#!/usr/bin/env python3
"""Build the pinned QPDF Windows CLI/C bridge and the matching WASM C bridge."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "native" / "qpdf"
VENDOR = ROOT / "native" / "vendor"
SOURCES = VENDOR / "sources"
TOOLS = VENDOR / "tools"
WORK = ROOT / "tmp" / "qpdf-work"
ARTIFACTS = PACKAGE / "artifacts"

QPDF_VERSION = "12.4.1"
QPDF_COMMIT = "c37f83ae468abb6cc741f43b2f6fdeb66e550ffb"
QPDF_SOURCE_URL = (
    "https://github.com/qpdf/qpdf/releases/download/v12.4.1/qpdf-12.4.1.tar.gz"
)
QPDF_SOURCE_SHA256 = "f045aa277be2356ff53a89a8622945958291177d2483afc20ede7c8a8cd3873c"
QPDF_SOURCE_ARCHIVE = SOURCES / "qpdf-12.4.1.tar.gz"
QPDF_SOURCE = SOURCES / "qpdf-12.4.1"

VCPKG_URL = "https://github.com/qpdf/qpdf/releases/download/v12.4.1/vcpkg.zip"
VCPKG_SHA256 = "bd260e1cedc0d2d188e68bb7643d32dfd7161dfbf74b31dc896ebf46e7054a01"
VCPKG_ROOT = TOOLS / "qpdf-vcpkg"
VCPKG_ARCHIVE = VCPKG_ROOT / "vcpkg.zip"
VCPKG = VCPKG_ROOT / "vcpkg"

NINJA = TOOLS / "ninja" / "ninja.exe"
EMSDK = TOOLS / "emsdk"
VS_ROOT = Path(r"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools")
VCVARS64 = VS_ROOT / "VC" / "Auxiliary" / "Build" / "vcvars64.bat"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(path: Path, root: Path) -> dict[str, object]:
    return {
        "path": path.relative_to(root).as_posix(),
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
    }


def rmtree_force(path: Path) -> None:
    if not path.exists():
        return
    for root, _, files in os.walk(path):
        for f in files:
            p = Path(root) / f
            try:
                p.chmod(0o777)
            except Exception:
                pass
    shutil.rmtree(path, ignore_errors=True)


def run(
    command: list[object],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    rendered = [str(item) for item in command]
    print("+", subprocess.list2cmdline(rendered), flush=True)
    return subprocess.run(
        rendered,
        cwd=cwd,
        env=env,
        input=input_text,
        text=True,
        check=True,
        capture_output=capture,
    )


def download(url: str, destination: Path) -> None:
    if destination.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {url}", flush=True)
    urllib.request.urlretrieve(url, destination)


def verify(path: Path, expected: str) -> None:
    actual = sha256(path)
    if actual != expected:
        raise RuntimeError(f"SHA-256 mismatch for {path}: {actual}")


def prepare_sources() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    download(QPDF_SOURCE_URL, QPDF_SOURCE_ARCHIVE)
    verify(QPDF_SOURCE_ARCHIVE, QPDF_SOURCE_SHA256)
    if not (QPDF_SOURCE / "CMakeLists.txt").exists():
        with tarfile.open(QPDF_SOURCE_ARCHIVE, "r:gz") as archive:
            archive.extractall(SOURCES, filter="data")
    if f"VERSION {QPDF_VERSION}" not in (QPDF_SOURCE / "CMakeLists.txt").read_text(
        encoding="utf-8"
    ):
        raise RuntimeError("extracted QPDF source version does not match the lock")

    VCPKG_ROOT.mkdir(parents=True, exist_ok=True)
    download(VCPKG_URL, VCPKG_ARCHIVE)
    verify(VCPKG_ARCHIVE, VCPKG_SHA256)
    if not (VCPKG / "installed" / "x64-windows-static").exists():
        with zipfile.ZipFile(VCPKG_ARCHIVE) as archive:
            archive.extractall(VCPKG_ROOT)


def ensure_vcpkg_junction() -> None:
    link = QPDF_SOURCE / "vcpkg"
    target = VCPKG.resolve()
    if link.exists():
        if link.resolve() != target:
            raise RuntimeError(f"unexpected QPDF vcpkg directory: {link.resolve()}")
        return
    run(
        [
            os.environ.get("COMSPEC", "cmd.exe"),
            "/d",
            "/c",
            "mklink",
            "/J",
            str(link),
            str(target),
        ]
    )


def locate_cmake() -> Path:
    found = shutil.which("cmake")
    if not found:
        raise FileNotFoundError("cmake 3.16 or newer is required")
    return Path(found)


def msvc_environment() -> dict[str, str]:
    if not VCVARS64.exists():
        raise FileNotFoundError(f"Visual Studio x64 environment not found: {VCVARS64}")
    WORK.mkdir(parents=True, exist_ok=True)
    capture_script = WORK / "capture-msvc-env.cmd"
    capture_script.write_text(
        f'@call "{VCVARS64}" >nul\n@set\n@exit /b 0\n', encoding="utf-8"
    )
    try:
        completed = subprocess.run(
            [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", str(capture_script)],
            text=True,
            check=True,
            capture_output=True,
        )
    finally:
        capture_script.unlink(missing_ok=True)
    env = os.environ.copy()
    for line in completed.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            if key.lower() == "path":
                for existing in [name for name in env if name.lower() == "path"]:
                    env.pop(existing)
                env["PATH"] = value
            else:
                env[key] = value
    confined = WORK / "windows-env"
    for name in ("home", "temp", "local-app-data", "roaming-app-data"):
        (confined / name).mkdir(parents=True, exist_ok=True)
    env.update(
        HOME=str(confined / "home"),
        USERPROFILE=str(confined / "home"),
        TEMP=str(confined / "temp"),
        TMP=str(confined / "temp"),
        LOCALAPPDATA=str(confined / "local-app-data"),
        APPDATA=str(confined / "roaming-app-data"),
    )
    return env


def synthetic_pdf() -> bytes:
    streams = [
        b"BT /F1 18 Tf 72 720 Td (P5 QPDF synthetic page one) Tj ET\n",
        b"BT /F1 18 Tf 72 720 Td (P5 QPDF synthetic page two) Tj ET\n",
    ]
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n%sends" % (len(streams[0]), streams[0]),
        b"<< /Length %d >>\nstream\n%sends" % (len(streams[1]), streams[1]),
    ]
    # Replace the sentinel without risking %-formatting inside stream content.
    objects[5] = objects[5].replace(b"ends", b"endstream")
    objects[6] = objects[6].replace(b"ends", b"endstream")

    output = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode("ascii"))
        output.extend(body)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode(
            "ascii"
        )
    )
    return bytes(output)


def qpdf_text_probe(qpdf: Path, pdf: Path, label: str, env: dict[str, str]) -> dict[str, object]:
    pages = run([qpdf, "--show-npages", pdf], env=env, capture=True).stdout.strip()
    if pages != "2":
        raise RuntimeError(f"{label} page count mismatch: {pages}")
    qdf = WORK / f"{label}.qdf.pdf"
    if qdf.exists():
        qdf.unlink()
    run([qpdf, "--qdf", "--stream-data=uncompress", pdf, qdf], env=env)
    data = qdf.read_bytes()
    texts = [b"P5 QPDF synthetic page one", b"P5 QPDF synthetic page two"]
    if not all(text in data for text in texts):
        raise RuntimeError(f"{label} did not preserve both synthetic text streams")
    return {"pages": 2, "textsPreserved": True}


def native_smoke(
    wrapper: Path, qpdf: Path, env: dict[str, str]
) -> tuple[dict[str, object], dict[str, Path]]:
    fixture = WORK / "synthetic-two-page.pdf"
    encrypted = WORK / "synthetic-aes256.pdf"
    decrypted = WORK / "synthetic-decrypted.pdf"
    optimized = WORK / "synthetic-optimized.pdf"
    for path in (encrypted, decrypted, optimized):
        if path.exists():
            path.unlink()
    fixture.write_bytes(synthetic_pdf())

    user_password = "P5-test-user-2026"
    owner_password = "P5-test-owner-2026"
    jobs = [
        {
            "operation": "encrypt-aes256",
            "inputFile": str(fixture),
            "outputFile": str(encrypted),
            "userPassword": user_password,
            "ownerPassword": owner_password,
            "encryptMetadata": True,
        },
        {
            "operation": "decrypt",
            "inputFile": str(encrypted),
            "outputFile": str(decrypted),
            "inputPassword": user_password,
        },
        {
            "operation": "optimize-lossless",
            "inputFile": str(decrypted),
            "outputFile": str(optimized),
        },
    ]
    for job in jobs:
        run([wrapper], env=env, input_text=json.dumps(job, ensure_ascii=False))

    encryption = run(
        [qpdf, "--password-file=-", "--show-encryption", encrypted],
        env=env,
        input_text=user_password + "\n",
        capture=True,
    ).stdout
    if ("R = 6" not in encryption) or ("AESv3" not in encryption):
        raise RuntimeError("encrypted fixture is not reported as revision 6 / 256-bit")
    run(
        [qpdf, "--password-file=-", "--check", encrypted],
        env=env,
        input_text=user_password + "\n",
        capture=True,
    )
    run([qpdf, "--check", decrypted], env=env, capture=True)
    run([qpdf, "--check", optimized], env=env, capture=True)

    results = {
        "result": "pass",
        "aes256Revision": 6,
        "correctPasswordReopen": True,
        "decrypted": qpdf_text_probe(qpdf, decrypted, "native-decrypted", env),
        "optimized": qpdf_text_probe(qpdf, optimized, "native-optimized", env),
    }
    return results, {
        "fixture": fixture,
        "encrypted": encrypted,
        "decrypted": decrypted,
        "optimized": optimized,
    }


def dumpbin_imports(executable: Path, env: dict[str, str]) -> list[str]:
    dumpbin = shutil.which("dumpbin", path=env.get("PATH"))
    if not dumpbin:
        raise FileNotFoundError("dumpbin was not provided by the Visual Studio environment")
    result = run([dumpbin, "/dependents", executable], env=env, capture=True)
    names = re.findall(r"(?im)^\s*([A-Za-z0-9_.-]+\.dll)\s*$", result.stdout)
    return sorted(set(names), key=str.lower)


def package_windows(
    build: Path,
    env: dict[str, str],
    smoke: dict[str, object],
) -> dict[str, object]:
    destination = ARTIFACTS / "windows-x64"
    if destination.exists():
        shutil.rmtree(destination)
    for subdir in ("bin", "include", "lib", "licenses"):
        (destination / subdir).mkdir(parents=True, exist_ok=True)

    binaries = [build / "bin" / "qpdf.exe", build / "bin" / "pdf-editor-qpdf.exe"]
    libraries = [build / "lib" / "pdf-editor-qpdf-bridge.lib", build / "lib" / "qpdf.lib"]
    external = VCPKG / "installed" / "x64-windows-static" / "lib"
    libraries.extend(external / name for name in ("zs.lib", "turbojpeg.lib", "libssl.lib", "libcrypto.lib"))
    for path in [*binaries, *libraries]:
        if not path.exists():
            raise FileNotFoundError(f"expected Windows build output is missing: {path}")
    for path in binaries:
        shutil.copy2(path, destination / "bin" / path.name)
    for path in libraries:
        shutil.copy2(path, destination / "lib" / path.name)
    shutil.copy2(PACKAGE / "include" / "pdf_editor_qpdf.h", destination / "include")

    shutil.copy2(QPDF_SOURCE / "LICENSE.txt", destination / "licenses" / "qpdf-LICENSE.txt")
    for dependency in ("zlib", "libjpeg-turbo", "openssl"):
        shutil.copy2(
            VCPKG / "installed" / "x64-windows-static" / "share" / dependency / "copyright",
            destination / "licenses" / f"{dependency}-copyright.txt",
        )

    dependency_records: dict[str, list[dict[str, object]]] = {}
    search_roots = [
        build / "bin",
        VCPKG / "installed" / "x64-windows-static" / "bin",
    ]
    redist_files = {
        path.name.lower(): path
        for path in (VS_ROOT / "VC" / "Redist" / "MSVC").rglob("*.dll")
        if "onecore" not in {part.lower() for part in path.parts}
        and "x64" in {part.lower() for part in path.parts}
    }
    system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    for binary in binaries:
        imported: list[dict[str, object]] = []
        for name in dumpbin_imports(binary, env):
            lowered = name.lower()
            redistributable = lowered.startswith(("vcruntime", "msvcp", "concrt"))
            system = not redistributable and (
                lowered.startswith(("api-ms-win-", "ext-ms-win-")) or (system32 / name).exists()
            )
            record: dict[str, object] = {"name": name, "system": system, "bundled": False}
            if not system:
                source = next((root / name for root in search_roots if (root / name).exists()), None)
                source = source or redist_files.get(lowered)
                source = source or ((system32 / name) if (system32 / name).exists() else None)
                if source is None:
                    raise FileNotFoundError(f"non-system runtime dependency not found: {name}")
                shutil.copy2(source, destination / "bin" / name)
                record["bundled"] = True
            imported.append(record)
        dependency_records[binary.name] = imported

    compiler_files = sorted((build / "CMakeFiles").glob("*/CMakeCXXCompiler.cmake"))
    if not compiler_files:
        raise FileNotFoundError("CMake compiler identity file is missing")
    compiler_text = compiler_files[-1].read_text(encoding="utf-8")
    compiler_match = re.search(r'CMAKE_CXX_COMPILER_VERSION "([^"]+)"', compiler_text)
    if not compiler_match:
        raise RuntimeError("CMake did not record the MSVC compiler version")
    compiler_version = "MSVC " + compiler_match.group(1)
    cmake = locate_cmake()
    manifest = {
        "schemaVersion": 1,
        "status": "built-and-smoke-tested",
        "qpdfVersion": QPDF_VERSION,
        "qpdfCommit": QPDF_COMMIT,
        "target": "x86_64-pc-windows-msvc",
        "configuration": {
            "buildType": "Release",
            "sharedLibraries": False,
            "msvcRuntime": "MultiThreaded",
            "cryptoProviders": ["openssl", "native"],
            "defaultCryptoProvider": "openssl",
        },
        "toolchain": {
            "cmake": run([cmake, "--version"], capture=True).stdout.splitlines()[0],
            "ninja": run([NINJA, "--version"], capture=True).stdout.strip(),
            "compiler": compiler_version,
            "visualStudio": str(VS_ROOT),
        },
        "smoke": smoke,
        "dynamicDependencies": dependency_records,
    }
    files = sorted(path for path in destination.rglob("*") if path.is_file())
    manifest["files"] = [file_record(path, destination) for path in files]
    (destination / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return manifest


def build_windows() -> tuple[dict[str, object], dict[str, Path]]:
    ensure_vcpkg_junction()
    cmake = locate_cmake()
    if not NINJA.exists():
        raise FileNotFoundError(f"project Ninja is missing: {NINJA}")
    env = msvc_environment()
    compiler = shutil.which("cl.exe", path=env["PATH"])
    if not compiler:
        candidates = sorted(VS_ROOT.glob("VC/Tools/MSVC/*/bin/Hostx64/x64/cl.exe"))
        if not candidates:
            raise FileNotFoundError("Visual Studio x64 cl.exe was not found")
        compiler = str(candidates[-1])
        env["PATH"] = str(candidates[-1].parent) + os.pathsep + env["PATH"]
    build = WORK / "build-windows"
    build.mkdir(parents=True, exist_ok=True)
    run(
        [
            cmake,
            "-S",
            PACKAGE,
            "-B",
            build,
            "-G",
            "Ninja",
            f"-DCMAKE_MAKE_PROGRAM={NINJA}",
            "-DCMAKE_BUILD_TYPE=Release",
            f"-DCMAKE_C_COMPILER={compiler}",
            f"-DCMAKE_CXX_COMPILER={compiler}",
            "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
            f"-DCMAKE_RUNTIME_OUTPUT_DIRECTORY={build / 'bin'}",
            f"-DCMAKE_ARCHIVE_OUTPUT_DIRECTORY={build / 'lib'}",
            f"-DCMAKE_LIBRARY_OUTPUT_DIRECTORY={build / 'bin'}",
            f"-DQPDF_SOURCE_DIR={QPDF_SOURCE}",
        ],
        env=env,
    )
    run(
        [
            cmake,
            "--build",
            build,
            "--parallel",
            "4",
            "--target",
            "qpdf",
            "pdf_editor_qpdf_cli",
            "pdf_editor_qpdf_bridge",
        ],
        env=env,
    )
    wrapper = build / "bin" / "pdf-editor-qpdf.exe"
    qpdf = build / "bin" / "qpdf.exe"
    smoke, paths = native_smoke(wrapper, qpdf, env)
    return package_windows(build, env, smoke), paths


def wasm_environment() -> dict[str, str]:
    env = os.environ.copy()
    node = EMSDK / "node" / "24.19.0_64bit" / "node.exe"
    python = EMSDK / "python" / "3.13.3_64bit" / "python.exe"
    cache = WORK / "emscripten-cache"
    for directory in (
        WORK / "wasm-home",
        WORK / "wasm-temp",
        WORK / "wasm-local-app-data",
        WORK / "wasm-roaming-app-data",
        cache / "sysroot" / "lib" / "pkgconfig",
    ):
        directory.mkdir(parents=True, exist_ok=True)
    env.update(
        EMSDK=str(EMSDK),
        EM_CONFIG=str(EMSDK / ".emscripten"),
        EMSDK_NODE=str(node),
        EMSDK_PYTHON=str(python),
        EM_CACHE=str(cache),
        HOME=str(WORK / "wasm-home"),
        USERPROFILE=str(WORK / "wasm-home"),
        TEMP=str(WORK / "wasm-temp"),
        TMP=str(WORK / "wasm-temp"),
        LOCALAPPDATA=str(WORK / "wasm-local-app-data"),
        APPDATA=str(WORK / "wasm-roaming-app-data"),
        PKG_CONFIG_LIBDIR=str(cache / "sysroot" / "lib" / "pkgconfig"),
        PKG_CONFIG_PATH=str(cache / "sysroot" / "lib" / "pkgconfig"),
    )
    paths = [
        EMSDK / "upstream" / "emscripten",
        EMSDK / "upstream" / "bin",
        node.parent,
        python.parent,
        NINJA.parent,
    ]
    env["PATH"] = os.pathsep.join([*(str(path) for path in paths), env.get("PATH", "")])
    return env


def wasm_node_script() -> str:
    return r'''import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath, inputPath, encryptedPath, decryptedPath, optimizedPath] = process.argv.slice(2);
const createModule = (await import(pathToFileURL(modulePath).href)).default;
const moduleDir = path.dirname(modulePath);
const qpdf = await createModule({ locateFile: (name) => path.join(moduleDir, name) });
const userPassword = process.env.QPDF_SMOKE_USER;
const ownerPassword = process.env.QPDF_SMOKE_OWNER;
if (!userPassword || !ownerPassword) throw new Error("missing synthetic smoke password environment");

function allocBytes(data) {
  const pointer = qpdf._malloc(data.length);
  qpdf.HEAPU8.set(data, pointer);
  return pointer;
}
function allocString(value) {
  if (value === null) return 0;
  const pointer = qpdf._malloc(qpdf.lengthBytesUTF8(value) + 1);
  qpdf.stringToUTF8(value, pointer, qpdf.lengthBytesUTF8(value) + 1);
  return pointer;
}
function transform(operation, input, inputPassword, user, owner) {
  const inputPointer = allocBytes(input);
  const inputPasswordPointer = allocString(inputPassword);
  const userPointer = allocString(user);
  const ownerPointer = allocString(owner);
  const outputPointerPointer = qpdf._malloc(4);
  const outputSizePointer = qpdf._malloc(4);
  try {
    const status = qpdf._pde_qpdf_transform(
      operation, inputPointer, input.length, inputPasswordPointer, userPointer, ownerPointer,
      255, 1, outputPointerPointer, outputSizePointer);
    if (status !== 0) {
      throw new Error(qpdf.UTF8ToString(qpdf._pde_qpdf_last_error()));
    }
    const outputPointer = qpdf.HEAPU32[outputPointerPointer >>> 2];
    const outputSize = qpdf.HEAPU32[outputSizePointer >>> 2];
    const output = qpdf.HEAPU8.slice(outputPointer, outputPointer + outputSize);
    qpdf._pde_qpdf_free(outputPointer);
    return output;
  } finally {
    qpdf._free(inputPointer);
    if (inputPasswordPointer) qpdf._free(inputPasswordPointer);
    if (userPointer) qpdf._free(userPointer);
    if (ownerPointer) qpdf._free(ownerPointer);
    qpdf._free(outputPointerPointer);
    qpdf._free(outputSizePointer);
  }
}

const input = fs.readFileSync(inputPath);
const encrypted = transform(2, input, null, userPassword, ownerPassword);
fs.writeFileSync(encryptedPath, encrypted);
const decrypted = transform(1, encrypted, userPassword, null, null);
fs.writeFileSync(decryptedPath, decrypted);
const optimized = transform(3, decrypted, null, null, null);
fs.writeFileSync(optimizedPath, optimized);
console.log(JSON.stringify({ abi: qpdf._pde_qpdf_abi_version(), encrypted: encrypted.length, decrypted: decrypted.length, optimized: optimized.length }));
'''


def wasm_smoke(
    javascript: Path,
    qpdf: Path,
    native_paths: dict[str, Path],
    native_env: dict[str, str],
    env: dict[str, str],
) -> dict[str, object]:
    script = WORK / "wasm-smoke.mjs"
    encrypted = WORK / "wasm-aes256.pdf"
    decrypted = WORK / "wasm-decrypted.pdf"
    optimized = WORK / "wasm-optimized.pdf"
    for path in (encrypted, decrypted, optimized):
        if path.exists():
            path.unlink()
    script.write_text(wasm_node_script(), encoding="utf-8", newline="\n")
    smoke_env = env.copy()
    smoke_env["QPDF_SMOKE_USER"] = "P5-test-user-2026"
    smoke_env["QPDF_SMOKE_OWNER"] = "P5-test-owner-2026"
    node = Path(env["EMSDK_NODE"])
    try:
        result = run(
            [
                node,
                script,
                javascript,
                native_paths["fixture"],
                encrypted,
                decrypted,
                optimized,
            ],
            env=smoke_env,
            capture=True,
        )
    finally:
        script.unlink(missing_ok=True)

    encryption = run(
        [qpdf, "--password-file=-", "--show-encryption", encrypted],
        env=native_env,
        input_text="P5-test-user-2026\n",
        capture=True,
    ).stdout
    if ("R = 6" not in encryption) or ("AESv3" not in encryption):
        raise RuntimeError("WASM encrypted fixture is not revision 6 / 256-bit")
    run(
        [qpdf, "--password-file=-", "--check", encrypted],
        env=native_env,
        input_text="P5-test-user-2026\n",
        capture=True,
    )
    return {
        "result": "pass",
        "nodeResult": json.loads(result.stdout.strip().splitlines()[-1]),
        "aes256Revision": 6,
        "correctPasswordReopen": True,
        "decrypted": qpdf_text_probe(qpdf, decrypted, "wasm-decrypted", native_env),
        "optimized": qpdf_text_probe(qpdf, optimized, "wasm-optimized", native_env),
    }


def package_wasm(build: Path, smoke: dict[str, object], env: dict[str, str]) -> dict[str, object]:
    destination = ARTIFACTS / "wasm"
    if destination.exists():
        shutil.rmtree(destination)
    (destination / "licenses").mkdir(parents=True, exist_ok=True)
    javascript = build / "bin" / "pdf-editor-qpdf.js"
    wasm = build / "bin" / "pdf-editor-qpdf.wasm"
    for path in (javascript, wasm):
        if not path.exists():
            raise FileNotFoundError(f"expected WASM build output is missing: {path}")
        shutil.copy2(path, destination / path.name)
    shutil.copy2(PACKAGE / "include" / "pdf_editor_qpdf.h", destination)
    shutil.copy2(QPDF_SOURCE / "LICENSE.txt", destination / "licenses" / "qpdf-LICENSE.txt")
    cache = Path(env["EM_CACHE"])
    shutil.copy2(
        cache / "ports" / "zlib" / "zlib-1.3.2" / "LICENSE",
        destination / "licenses" / "zlib-LICENSE.txt",
    )
    shutil.copy2(
        cache / "ports" / "libjpeg" / "jpeg-9f" / "README",
        destination / "licenses" / "libjpeg-README.txt",
    )

    empp = EMSDK / "upstream" / "emscripten" / "em++.exe"
    manifest = {
        "schemaVersion": 1,
        "status": "built-and-smoke-tested",
        "qpdfVersion": QPDF_VERSION,
        "qpdfCommit": QPDF_COMMIT,
        "target": "wasm32-unknown-emscripten",
        "configuration": {
            "pthread": False,
            "allowMemoryGrowth": True,
            "initialMemoryBytes": 67108864,
            "maximumMemoryBytes": 1073741824,
            "cryptoProviders": ["native"],
            "defaultCryptoProvider": "native",
            "ports": {"zlib": "1.3.2", "libjpeg": "9f"},
        },
        "toolchain": {
            "emscripten": run([empp, "--version"], env=env, capture=True).stdout.splitlines()[0],
            "node": run([Path(env["EMSDK_NODE"]), "--version"], env=env, capture=True).stdout.strip(),
            "ninja": run([NINJA, "--version"], env=env, capture=True).stdout.strip(),
        },
        "smoke": smoke,
    }
    files = sorted(path for path in destination.rglob("*") if path.is_file())
    manifest["files"] = [file_record(path, destination) for path in files]
    (destination / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return manifest


def build_wasm(
    native_paths: dict[str, Path], native_env: dict[str, str]
) -> dict[str, object]:
    cmake = locate_cmake()
    env = wasm_environment()
    embuilder = EMSDK / "upstream" / "emscripten" / "embuilder.exe"
    emcmake = EMSDK / "upstream" / "emscripten" / "emcmake.exe"
    if not embuilder.exists() or not emcmake.exists():
        raise FileNotFoundError("the pinned project Emscripten toolchain is incomplete")
    run([embuilder, "build", "zlib", "libjpeg"], env=env)

    build = WORK / "build-wasm"
    build.mkdir(parents=True, exist_ok=True)
    common_flags = "-sUSE_ZLIB=1 -sUSE_LIBJPEG=1"
    run(
        [
            emcmake,
            cmake,
            "-S",
            PACKAGE,
            "-B",
            build,
            "-G",
            "Ninja",
            f"-DCMAKE_MAKE_PROGRAM={NINJA}",
            "-DCMAKE_BUILD_TYPE=Release",
            f"-DCMAKE_C_FLAGS={common_flags}",
            f"-DCMAKE_CXX_FLAGS={common_flags} -fexceptions",
            f"-DCMAKE_EXE_LINKER_FLAGS={common_flags} -fexceptions",
            f"-DCMAKE_RUNTIME_OUTPUT_DIRECTORY={build / 'bin'}",
            f"-DCMAKE_ARCHIVE_OUTPUT_DIRECTORY={build / 'lib'}",
            f"-DCMAKE_LIBRARY_OUTPUT_DIRECTORY={build / 'bin'}",
            f"-DQPDF_SOURCE_DIR={QPDF_SOURCE}",
        ],
        env=env,
    )
    run(
        [cmake, "--build", build, "--parallel", "4", "--target", "pdf_editor_qpdf_wasm"],
        env=env,
    )
    javascript = build / "bin" / "pdf-editor-qpdf.js"
    qpdf = ARTIFACTS / "windows-x64" / "bin" / "qpdf.exe"
    smoke = wasm_smoke(javascript, qpdf, native_paths, native_env, env)
    return package_wasm(build, smoke, env)


def build_macos(remote_device: str = "ljkmacbook-air") -> tuple[dict[str, object], Path]:
    destination = ARTIFACTS / "macos-arm64"
    if sys.platform == "darwin":
        macos_script = ROOT / "scripts" / "build-qpdf-macos.py"
        run([
            sys.executable,
            str(macos_script),
            "--package-dir", str(PACKAGE),
            "--output-dir", str(destination),
            "--tar-results",
        ])
    else:
        ssh_connect = Path.home() / ".claude" / "accounts" / "ssh-connect.py"
        if not ssh_connect.exists():
            raise FileNotFoundError(f"SSH connect entry script not found: {ssh_connect}")
        remote_work = "/Users/ljk/data/workspace/pdf-editor/tmp/mac-qpdf-resample-20260923"
        source_archive = "/Users/ljk/data/workspace/pdf-editor/tmp/mac-qpdf-20260922/qpdf-12.4.1.tar.gz"
        run([sys.executable, str(ssh_connect), remote_device, "mkdir", "-p", f"{remote_work}/package"])
        overlay_tar = WORK / "qpdf-source-overlay.tar.gz"
        WORK.mkdir(parents=True, exist_ok=True)
        with tarfile.open(overlay_tar, "w:gz") as tar:
            for rel in [
                "CMakeLists.txt",
                "README.md",
                "qpdf-lock.json",
                "include/pdf_editor_qpdf.h",
                "src/pdf_editor_qpdf.cpp",
                "src/qpdf_job_main.cpp",
                "src/image_optimizer.cpp",
                "src/image_optimizer.h",
            ]:
                tar.add(PACKAGE / rel, arcname=rel)
        run([sys.executable, str(ssh_connect), "--scp", remote_device, str(overlay_tar), f"{remote_work}/qpdf-source-overlay.tar.gz"])
        macos_script = ROOT / "scripts" / "build-qpdf-macos.py"
        run([sys.executable, str(ssh_connect), "--scp", remote_device, str(macos_script), f"{remote_work}/build-qpdf-macos.py"])
        run([sys.executable, str(ssh_connect), remote_device, "/usr/bin/tar", "-xzf",
             f"{remote_work}/qpdf-source-overlay.tar.gz", "-C", f"{remote_work}/package"])
        run([sys.executable, str(ssh_connect), remote_device, "/usr/bin/python3",
             f"{remote_work}/build-qpdf-macos.py", "--work-dir", remote_work,
             "--source-archive", source_archive, "--package-dir", f"{remote_work}/package",
             "--output-dir", f"{remote_work}/artifacts/macos-arm64", "--tar-results"])
        local_results_tar = WORK / "mac-qpdf-arm64-resample-results.tar.gz"
        local_results_sha = WORK / "mac-qpdf-arm64-resample-results.tar.gz.sha256"
        run([sys.executable, str(ssh_connect), "--download", remote_device, f"{remote_work}/mac-qpdf-arm64-results.tar.gz", str(local_results_tar)])
        run([sys.executable, str(ssh_connect), "--download", remote_device, f"{remote_work}/mac-qpdf-arm64-results.tar.gz.sha256", str(local_results_sha)])
        expected_sha = local_results_sha.read_text(encoding="utf-8").strip().split()[0]
        actual_sha = sha256(local_results_tar)
        if actual_sha != expected_sha:
            raise RuntimeError(f"Downloaded results tarball hash mismatch: {actual_sha} != {expected_sha}")
        if destination.exists():
            rmtree_force(destination)
        destination.mkdir(parents=True, exist_ok=True)
        with tarfile.open(local_results_tar) as tar:
            members = [m for m in tar.getmembers() if m.name.startswith("macos-arm64/")]
            for m in members:
                m.name = m.name[len("macos-arm64/"):]
            tar.extractall(destination, members=[m for m in members if m.name])
        # Ensure writable permissions on Windows
        for root, _, files in os.walk(destination):
            for f in files:
                try:
                    (Path(root) / f).chmod(0o666)
                except Exception:
                    pass
    manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
    return manifest, destination


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", choices=("windows", "wasm", "macos", "all"), default="all")
    parser.add_argument("--device", default="ljkmacbook-air", help="Authorized remote Mac device label in registry")
    args = parser.parse_args()

    prepare_sources()
    summary: dict[str, object] = {
        "schemaVersion": 1,
        "qpdfVersion": QPDF_VERSION,
        "qpdfCommit": QPDF_COMMIT,
    }

    manifest_path = PACKAGE / "build-manifest.json"
    if manifest_path.exists():
        try:
            loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
            for key in ("windows", "macos", "wasm"):
                if key in loaded:
                    summary[key] = loaded[key]
        except Exception:
            pass

    native_manifest: dict[str, object] | None = None
    native_paths: dict[str, Path] | None = None
    native_env: dict[str, str] | None = None
    if args.target in ("windows", "all") and sys.platform == "win32":
        native_manifest, native_paths = build_windows()
        native_env = msvc_environment()
        summary["windows"] = {
            "status": native_manifest["status"],
            "artifact": "native/qpdf/artifacts/windows-x64",
            "manifestSha256": sha256(ARTIFACTS / "windows-x64" / "manifest.json"),
        }
    elif (ARTIFACTS / "windows-x64" / "manifest.json").exists():
        summary["windows"] = {
            "status": "built-and-smoke-tested",
            "artifact": "native/qpdf/artifacts/windows-x64",
            "manifestSha256": sha256(ARTIFACTS / "windows-x64" / "manifest.json"),
        }

    if args.target in ("wasm", "all"):
        if native_paths is None or native_env is None:
            fixture = WORK / "synthetic-two-page.pdf"
            fixture.parent.mkdir(parents=True, exist_ok=True)
            fixture.write_bytes(synthetic_pdf())
            native_paths = {"fixture": fixture}
            native_env = msvc_environment() if sys.platform == "win32" else os.environ.copy()
            qpdf = ARTIFACTS / ("windows-x64" if sys.platform == "win32" else "macos-arm64") / "bin" / ("qpdf.exe" if sys.platform == "win32" else "qpdf")
            if not qpdf.exists():
                raise RuntimeError("WASM smoke validation requires a built native QPDF artifact")
        wasm_manifest = build_wasm(native_paths, native_env)
        summary["wasm"] = {
            "status": wasm_manifest["status"],
            "artifact": "native/qpdf/artifacts/wasm",
            "manifestSha256": sha256(ARTIFACTS / "wasm" / "manifest.json"),
        }
    elif (ARTIFACTS / "wasm" / "manifest.json").exists():
        summary["wasm"] = {
            "status": "built-and-smoke-tested",
            "artifact": "native/qpdf/artifacts/wasm",
            "manifestSha256": sha256(ARTIFACTS / "wasm" / "manifest.json"),
        }

    if args.target == "macos" or (args.target == "all" and sys.platform == "darwin"):
        macos_manifest, _ = build_macos(remote_device=args.device)
        summary["macos"] = {
            "status": macos_manifest["status"],
            "target": "macos-arm64",
            "artifact": "native/qpdf/artifacts/macos-arm64",
            "manifestSha256": sha256(ARTIFACTS / "macos-arm64" / "manifest.json"),
        }
    elif (ARTIFACTS / "macos-arm64" / "manifest.json").exists():
        summary["macos"] = {
            "status": "built-and-smoke-tested",
            "target": "macos-arm64",
            "artifact": "native/qpdf/artifacts/macos-arm64",
            "manifestSha256": sha256(ARTIFACTS / "macos-arm64" / "manifest.json"),
        }

    (PACKAGE / "build-manifest.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
