#!/usr/bin/env python3
"""Bootstrap the pinned PDFium Windows build inside this project.

This script intentionally keeps HOME, TEMP, depot_tools caches, CIPD, source, and
build outputs below the project directory. It performs at most one bootstrap/build
attempt per invocation and does not apply project PDFium patches.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import urllib.request
import zipfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
VENDOR = PROJECT / "native" / "vendor"
TOOLS = VENDOR / "tools"
SOURCES = VENDOR / "sources"
WORK = PROJECT / "tmp" / "m0-native-build"
LOCK_PATH = VENDOR / "toolchain-lock.json"
PDFIUM_COMMIT = "80fccd7553e5cff9cea6549bc0db2ea93ea6cb2e"
PDFIUM_UPSTREAM = "https://pdfium.googlesource.com/pdfium.git"
DEPOT_TOOLS_URL = "https://storage.googleapis.com/chrome-infra/depot_tools.zip"
DEPOT_TOOLS_SHA256 = "2c1689e511fcf90044e5f039c0fbbfc04f3baa0a956a1d6ed7fa9d6d655867dc"
GN_VERSION = "git_revision:1740f5c25bcac5a650ee3d1c1ec22bfa25fcd756"
NINJA_VERSION = "version:3@1.12.1.chromium.4"
CLANG_REVISION = "3e520fe28bbeed4a87f5e575272933d359915989"
CLANG_PACKAGE = "clang-llvmorg-23-init-10931-g20b6ec66-8.tar.xz"
CLANG_URL = f"https://storage.googleapis.com/chromium-browser-clang/Win/{CLANG_PACKAGE}"
CLANG_SHA256 = "7fa1aa9bf477f565687a2f516bf75ff6bfdd13da9b36bf521a75ac8ae2761d6a"
CLANG_SIZE = 50_211_688
VS_PATH = Path(r"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools")


def run(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str],
    timeout_seconds: int | None = None,
) -> None:
    print("+", subprocess.list2cmdline(command), flush=True)
    completed = subprocess.run(
        command, cwd=cwd, env=env, check=False, timeout=timeout_seconds
    )
    if completed.returncode:
        raise subprocess.CalledProcessError(completed.returncode, command)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def confined_environment(depot_tools: Path) -> dict[str, str]:
    env = os.environ.copy()
    for directory in (
        WORK / "home",
        WORK / "temp",
        WORK / "cache",
        WORK / "cipd",
        WORK / "depot-cache",
        WORK / "git-cache",
        WORK / "local-app-data",
        WORK / "roaming-app-data",
    ):
        directory.mkdir(parents=True, exist_ok=True)
    env.update(
        {
            "HOME": str(WORK / "home"),
            "USERPROFILE": str(WORK / "home"),
            "TEMP": str(WORK / "temp"),
            "TMP": str(WORK / "temp"),
            "XDG_CACHE_HOME": str(WORK / "cache"),
            "LOCALAPPDATA": str(WORK / "local-app-data"),
            "APPDATA": str(WORK / "roaming-app-data"),
            "DEPOT_TOOLS_CACHE_DIR": str(WORK / "depot-cache"),
            "GIT_CACHE_PATH": str(WORK / "git-cache"),
            "CIPD_CACHE_DIR": str(WORK / "cipd"),
            "DEPOT_TOOLS_WIN_TOOLCHAIN": "0",
            "DEPOT_TOOLS_UPDATE": "0",
            "GCLIENT_PY3": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "PATH": str(depot_tools) + os.pathsep + env.get("PATH", ""),
        }
    )
    return env


def ensure_depot_tools(env: dict[str, str]) -> tuple[Path, dict[str, str]]:
    depot_tools = TOOLS / "depot_tools"
    archive = WORK / "downloads" / "depot_tools.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        print(f"Downloading {DEPOT_TOOLS_URL}", flush=True)
        urllib.request.urlretrieve(DEPOT_TOOLS_URL, archive)
    archive_hash = sha256(archive)
    if archive_hash != DEPOT_TOOLS_SHA256:
        raise RuntimeError(f"depot_tools archive hash mismatch: {archive_hash}")
    if not (depot_tools / "gclient.py").exists():
        depot_tools.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(depot_tools)
    env = confined_environment(depot_tools)
    return depot_tools, env


def ensure_depot_windows_wrappers(depot_tools: Path, env: dict[str, str]) -> None:
    if (depot_tools / "git.bat").exists():
        return
    bootstrap = depot_tools / "bootstrap" / "win_tools.bat"
    run(
        [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", str(bootstrap)],
        env=env,
        timeout_seconds=300,
    )
    if not (depot_tools / "git.bat").exists():
        raise FileNotFoundError("depot_tools bootstrap did not generate git.bat")


def install_cipd_package(
    cipd: Path, package: str, version: str, destination: Path, env: dict[str, str]
) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    executable = destination / ("gn.exe" if package.startswith("gn/") else "ninja.exe")
    if executable.exists():
        return
    run(
        [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", str(cipd), "install", package, version, "-root", str(destination)],
        env=env,
        timeout_seconds=180,
    )


def ensure_fixed_tools(depot_tools: Path, env: dict[str, str]) -> tuple[Path, Path, Path]:
    cipd = depot_tools / "cipd.bat"
    gn_root = TOOLS / "gn"
    ninja_root = TOOLS / "ninja"
    install_cipd_package(cipd, "gn/gn/windows-amd64", GN_VERSION, gn_root, env)
    install_cipd_package(
        cipd,
        "infra/3pp/tools/ninja/windows-amd64",
        NINJA_VERSION,
        ninja_root,
        env,
    )

    clang_root = TOOLS / "clang"
    clang_exe = clang_root / "bin" / "clang-cl.exe"
    clang_archive = WORK / "downloads" / CLANG_PACKAGE
    if not clang_exe.exists():
        if not clang_archive.exists():
            print(f"Downloading {CLANG_URL}", flush=True)
            urllib.request.urlretrieve(CLANG_URL, clang_archive)
        if clang_archive.stat().st_size != CLANG_SIZE:
            raise RuntimeError(f"Clang archive size mismatch: {clang_archive.stat().st_size}")
        clang_hash = sha256(clang_archive)
        if clang_hash != CLANG_SHA256:
            raise RuntimeError(f"Clang archive hash mismatch: {clang_hash}")
        import tarfile

        clang_root.mkdir(parents=True, exist_ok=True)
        with tarfile.open(clang_archive, "r:xz") as bundle:
            bundle.extractall(clang_root)
    if not clang_exe.exists():
        matches = sorted(clang_root.rglob("clang-cl.exe"))
        if not matches:
            raise FileNotFoundError("Pinned Clang archive did not contain clang-cl.exe")
        clang_exe = matches[0]
    return gn_root / "gn.exe", ninja_root / "ninja.exe", clang_exe


def ensure_pdfium(env: dict[str, str], remote: str) -> Path:
    source = SOURCES / "pdfium"
    if not (source / ".git").exists():
        source.mkdir(parents=True, exist_ok=True)
        run(["git", "init"], cwd=source, env=env)
        run(["git", "remote", "add", "origin", remote], cwd=source, env=env)
    else:
        run(["git", "remote", "set-url", "origin", remote], cwd=source, env=env)
        current = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=source,
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
        if current.returncode == 0 and current.stdout.strip() == PDFIUM_COMMIT:
            return source
    run(
        ["git", "fetch", "--depth=1", "origin", PDFIUM_COMMIT],
        cwd=source,
        env=env,
        timeout_seconds=300,
    )
    run(
        ["git", "checkout", "--detach", "FETCH_HEAD"],
        cwd=source,
        env=env,
        timeout_seconds=120,
    )
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, env=env, text=True).strip()
    if actual != PDFIUM_COMMIT:
        raise RuntimeError(f"PDFium checkout mismatch: {actual}")
    return source


def write_gclient(source: Path, remote: str) -> Path:
    checkout_root = source.parent
    gclient = checkout_root / ".gclient"
    content = f'''solutions = [
  {{
    "name": "pdfium",
    "url": "{remote}",
    "managed": False,
    "custom_deps": {{}},
    "custom_vars": {{"checkout_configuration": "minimal"}},
    "custom_hooks": [],
    "safesync_url": "",
  }},
]
target_os = ["win"]
'''
    gclient.write_text(content, encoding="utf-8", newline="\n")
    return checkout_root


def sync_dependencies(checkout_root: Path, env: dict[str, str]) -> None:
    gclient = str(TOOLS / "depot_tools" / "gclient.bat")
    run(
        [
            os.environ.get("COMSPEC", "cmd.exe"),
            "/d",
            "/c",
            gclient,
            "sync",
            "--no-history",
            "--shallow",
            "--revision",
            f"pdfium@{PDFIUM_COMMIT}",
        ],
        cwd=checkout_root,
        env=env,
        timeout_seconds=3600,
    )


def ensure_build_inputs(source: Path, env: dict[str, str]) -> None:
    # The minimal DEPS configuration omits simdutf, but testing/BUILD.gn still
    # references its build description while GN generates the graph.
    simdutf = source / "third_party" / "simdutf"
    revision = "f7356eed293f8208c40b3c1b344a50bd70971983"
    if not (simdutf / ".git").exists():
        simdutf.mkdir(parents=True, exist_ok=True)
        run(["git", "init"], cwd=simdutf, env=env)
        run(["git", "remote", "add", "origin", "https://chromium.googlesource.com/chromium/src/third_party/simdutf"], cwd=simdutf, env=env)
    current = subprocess.run(["git", "rev-parse", "HEAD"], cwd=simdutf, env=env, capture_output=True, text=True)
    if current.returncode != 0 or current.stdout.strip() != revision:
        run(["git", "fetch", "--depth=1", "origin", revision], cwd=simdutf, env=env, timeout_seconds=180)
        run(["git", "checkout", "--detach", revision], cwd=simdutf, env=env)

    debugger_root = TOOLS / "windows-debuggers"
    if not (debugger_root / "Debuggers/x64/dbghelp.dll").exists():
        raise FileNotFoundError("Prepare the official Windows SDK debugger package in native/vendor/tools/windows-debuggers")
    toolchain = source / "build/vs_toolchain.py"
    if "PDF_EDITOR_DEBUGGERS_ROOT" not in toolchain.read_text(encoding="utf-8"):
        patch = VENDOR / "patches/0002-windows-debugger-root.patch"
        run(["git", "apply", "--check", str(patch)], cwd=source, env=env)
        run(["git", "apply", str(patch)], cwd=source, env=env)
    env["PDF_EDITOR_DEBUGGERS_ROOT"] = str(debugger_root)


def prepare_edit_probe(source: Path, env: dict[str, str]) -> None:
    form_header = source / "core/fpdfapi/page/cpdf_form.h"
    if "DetachStreamForEditing" not in form_header.read_text(encoding="utf-8"):
        patch = VENDOR / "patches/0001-isolated-form-stream-editing.patch"
        run(["git", "apply", "--check", str(patch)], cwd=source, env=env)
        run(["git", "apply", str(patch)], cwd=source, env=env)
    overlay = source / "pdf_editor_bridge"
    overlay.mkdir(exist_ok=True)
    for name in ("BUILD.gn", "form_edit.h", "form_edit.cc", "form_fields.h", "form_fields.cc"):
        shutil.copy2(PROJECT / "native/pdf-core/pdfium" / name, overlay / name)
    shutil.copy2(PROJECT / "native/pdf-core/tests/pdfium_edit_test.cc", overlay / "pdfium_edit_test.cc")


def write_args(source: Path) -> Path:
    output = source / "out" / "win-x64-release"
    output.mkdir(parents=True, exist_ok=True)
    (output / "args.gn").write_text(
        '''target_os = "win"
target_cpu = "x64"
is_debug = false
is_component_build = false
pdf_is_complete_lib = true
pdf_is_standalone = false
pdf_enable_v8 = false
pdf_enable_xfa = false
pdf_use_skia = false
pdf_use_agg = true
pdf_use_partition_alloc = false
clang_use_chrome_plugins = false
use_remoteexec = false
treat_warnings_as_errors = false
''',
        encoding="utf-8",
        newline="\n",
    )
    return output


def generate_and_build(
    source: Path, output: Path, env: dict[str, str], gn: Path, ninja: Path, edit_probe: bool = False
) -> tuple[Path, Path]:
    if not gn.exists() or not ninja.exists():
        raise FileNotFoundError("Pinned GN/Ninja tools are missing")
    env["GYP_MSVS_OVERRIDE_PATH"] = str(VS_PATH)
    # This machine installs VS 2026 under Program Files (x86), not the default
    # Program Files path searched by the pinned Chromium toolchain.
    env["vs2026_install"] = str(VS_PATH)
    run(
        [str(gn), "gen", str(output)] + (["--root-target=//pdf_editor_bridge"] if edit_probe else []),
        cwd=source,
        env=env,
        timeout_seconds=300,
    )
    run(
        [str(ninja), "-C", str(output), "-j4", "pdf_editor_edit_test" if edit_probe else "pdfium"],
        cwd=source,
        env=env,
        timeout_seconds=3600,
    )
    if edit_probe:
        run([str(output / "pdf_editor_edit_test.exe"), str(PROJECT / "resources/downloads/fonts/lxgw-wenkai/LXGWWenKai-Regular.ttf")], cwd=output, env=env, timeout_seconds=120)
    return gn, ninja


def write_lock(
    status: str,
    remote: str,
    depot_archive: Path | None,
    gn: Path | None,
    ninja: Path | None,
    clang: Path | None,
    failure: str | None = None,
) -> None:
    applied_patches = []
    for relative, marker, patch_name in (
        ("build/vs_toolchain.py", "PDF_EDITOR_DEBUGGERS_ROOT", "0002-windows-debugger-root.patch"),
        ("core/fpdfapi/page/cpdf_form.h", "DetachStreamForEditing", "0001-isolated-form-stream-editing.patch"),
    ):
        candidate = SOURCES / "pdfium" / relative
        if candidate.exists() and marker in candidate.read_text(encoding="utf-8"):
            applied_patches.append(patch_name)
    payload = {
        "schemaVersion": 1,
        "status": status,
        "failure": failure,
        "pdfium": {
            "repository": remote,
            "upstreamRepository": PDFIUM_UPSTREAM,
            "commit": PDFIUM_COMMIT,
            "branchReference": "refs/heads/chromium/7869",
            "patchesApplied": applied_patches,
            "patchHashes": {name: sha256(VENDOR / "patches" / name) for name in applied_patches},
            "extraBuildDependency": {"simdutf": "f7356eed293f8208c40b3c1b344a50bd70971983"},
        },
        "depotTools": {
            "archiveUrl": DEPOT_TOOLS_URL,
            "archiveSha256": sha256(depot_archive) if depot_archive and depot_archive.exists() else None,
            "directory": "native/vendor/tools/depot_tools",
        },
        "gn": {"version": GN_VERSION, "path": str(gn) if gn else None},
        "ninja": {"version": NINJA_VERSION, "path": str(ninja) if ninja else None},
        "clang": {
            "sourceRevision": CLANG_REVISION,
            "package": CLANG_PACKAGE,
            "archiveUrl": CLANG_URL,
            "archiveSha256": CLANG_SHA256,
            "path": str(clang) if clang else None,
            "compilerUsedByGn": "native/vendor/sources/pdfium/third_party/llvm-build/Release+Asserts/bin/clang-cl.exe",
        },
        "windows": {
            "visualStudio": str(VS_PATH),
            "sdkVersion": "10.0.26100.0",
            "output": "native/vendor/sources/pdfium/out/win-x64-release",
        },
        "cacheBoundary": "tmp/m0-native-build",
    }
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCK_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edit-probe", action="store_true", help="apply the project bridge and run synthetic PDF writeback tests")
    stages = parser.add_mutually_exclusive_group()
    stages.add_argument("--sync-only", action="store_true", help="stop after fixed checkout and gclient sync")
    stages.add_argument("--build-only", action="store_true", help="build the prepared checkout without repeating the full gclient sync")
    parser.add_argument(
        "--pdfium-remote",
        default=PDFIUM_UPSTREAM,
        help="Git remote that must expose the pinned PDFium commit",
    )
    parser.add_argument(
        "--proxy",
        help="Process-local HTTP(S) proxy for Git, CIPD, gclient, and downloads",
    )
    args = parser.parse_args()

    for directory in (TOOLS, SOURCES, WORK / "state"):
        directory.mkdir(parents=True, exist_ok=True)

    archive = WORK / "downloads" / "depot_tools.zip"
    gn = ninja = clang = None
    try:
        if args.proxy:
            proxy_env = {
                "HTTP_PROXY": args.proxy,
                "HTTPS_PROXY": args.proxy,
                "http_proxy": args.proxy,
                "https_proxy": args.proxy,
            }
            os.environ.update(proxy_env)
        base_env = confined_environment(TOOLS / "depot_tools")
        depot_tools, env = ensure_depot_tools(base_env)
        ensure_depot_windows_wrappers(depot_tools, env)
        gn, ninja, clang = ensure_fixed_tools(depot_tools, env)
        source = ensure_pdfium(env, args.pdfium_remote)
        if not args.build_only:
            checkout_root = write_gclient(source, args.pdfium_remote)
            sync_dependencies(checkout_root, env)
        if args.sync_only:
            write_lock(
                "dependencies-synced",
                args.pdfium_remote,
                archive,
                gn,
                ninja,
                clang,
            )
            return 0
        ensure_build_inputs(source, env)
        if args.edit_probe:
            prepare_edit_probe(source, env)
        output = write_args(source)
        generate_and_build(source, output, env, gn, ninja, args.edit_probe)
        write_lock(
            "windows-edit-probe-passed" if args.edit_probe else "windows-native-built",
            args.pdfium_remote,
            archive,
            gn,
            ninja,
            clang,
        )
        return 0
    except Exception as error:
        write_lock(
            "bootstrap-or-build-failed",
            args.pdfium_remote,
            archive,
            gn,
            ninja,
            clang,
            f"{type(error).__name__}: {error}",
        )
        raise


if __name__ == "__main__":
    raise SystemExit(main())
