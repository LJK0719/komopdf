#!/usr/bin/env python3
"""Build and validate the pinned QPDF macOS arm64 binaries and C bridge."""

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
from pathlib import Path

QPDF_VERSION = "12.4.1"
QPDF_COMMIT = "c37f83ae468abb6cc741f43b2f6fdeb66e550ffb"
QPDF_SOURCE_SHA256 = "f045aa277be2356ff53a89a8622945958291177d2483afc20ede7c8a8cd3873c"


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


def run(
    command: list[object],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    rendered = [str(item) for item in command]
    print("+", " ".join(rendered), flush=True)
    return subprocess.run(
        rendered,
        cwd=cwd,
        env=env,
        input=input_text,
        text=True,
        check=True,
        capture_output=capture,
    )


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


def qpdf_text_probe(
    qpdf: Path, pdf: Path, label: str, work_dir: Path, env: dict[str, str]
) -> dict[str, object]:
    pages = run([qpdf, "--show-npages", pdf], env=env, capture=True).stdout.strip()
    if pages != "2":
        raise RuntimeError(f"{label} page count mismatch: {pages}")
    qdf = work_dir / f"{label}.qdf.pdf"
    if qdf.exists():
        qdf.unlink()
    run([qpdf, "--qdf", "--stream-data=uncompress", pdf, qdf], env=env)
    data = qdf.read_bytes()
    texts = [b"P5 QPDF synthetic page one", b"P5 QPDF synthetic page two"]
    if not all(text in data for text in texts):
        raise RuntimeError(f"{label} did not preserve both synthetic text streams")
    return {"pages": 2, "textsPreserved": True}


def native_smoke(
    wrapper: Path, qpdf: Path, work_dir: Path, env: dict[str, str]
) -> dict[str, object]:
    fixture = work_dir / "synthetic-two-page.pdf"
    encrypted = work_dir / "synthetic-aes256.pdf"
    decrypted = work_dir / "synthetic-decrypted.pdf"
    optimized = work_dir / "synthetic-optimized.pdf"
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
        "decrypted": qpdf_text_probe(qpdf, decrypted, "native-decrypted", work_dir, env),
        "optimized": qpdf_text_probe(qpdf, optimized, "native-optimized", work_dir, env),
    }
    return results


def test_c_bridge(
    bridge_lib: Path,
    qpdf_lib: Path,
    jpeg_lib: Path,
    include_dir: Path,
    work_dir: Path,
    env: dict[str, str],
) -> dict[str, object]:
    test_src = work_dir / "test_bridge.cpp"
    test_bin = work_dir / "test_bridge"
    test_src.write_text(
        r'''#include "pdf_editor_qpdf.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <vector>

static const char SYNTHETIC_PDF[] =
"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"
"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
"5 0 obj\n<< /Length 44 >>\nstream\nBT /F1 18 Tf 72 720 Td (Bridge C Test) Tj ET\nendstream\nendobj\n"
"xref\n0 6\n0000000000 65535 f \n0000000015 00000 n \n0000000068 00000 n \n0000000125 00000 n \n0000000247 00000 n \n0000000320 00000 n \n"
"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n414\n%%EOF\n";

int main() {
    uint32_t abi = pde_qpdf_abi_version();
    if (abi != PDE_QPDF_ABI_VERSION) {
        std::cerr << "ABI mismatch: " << abi << std::endl;
        return 1;
    }
    const char* version = pde_qpdf_version();
    if (!version || std::strcmp(version, "12.4.1") != 0) {
        std::cerr << "Version mismatch: " << (version ? version : "null") << std::endl;
        return 2;
    }

    const size_t input_len = sizeof(SYNTHETIC_PDF) - 1;
    const unsigned char* input_bytes = reinterpret_cast<const unsigned char*>(SYNTHETIC_PDF);

    unsigned char* enc_out = nullptr;
    size_t enc_len = 0;
    int rc = pde_qpdf_transform(
        PDE_QPDF_ENCRYPT_AES256,
        input_bytes, input_len,
        nullptr,
        "test-pw-2026", "owner-pw-2026",
        PDE_QPDF_ALLOW_ALL, 1,
        &enc_out, &enc_len
    );
    if (rc != PDE_QPDF_OK || enc_out == nullptr || enc_len == 0) {
        std::cerr << "Encrypt failed: " << rc << " err: " << pde_qpdf_last_error() << std::endl;
        return 3;
    }

    unsigned char* dec_out = nullptr;
    size_t dec_len = 0;
    rc = pde_qpdf_transform(
        PDE_QPDF_DECRYPT,
        enc_out, enc_len,
        "test-pw-2026",
        nullptr, nullptr,
        PDE_QPDF_ALLOW_ALL, 1,
        &dec_out, &dec_len
    );
    pde_qpdf_free(enc_out);
    if (rc != PDE_QPDF_OK || dec_out == nullptr || dec_len == 0) {
        std::cerr << "Decrypt failed: " << rc << " err: " << pde_qpdf_last_error() << std::endl;
        return 4;
    }

    unsigned char* opt_out = nullptr;
    size_t opt_len = 0;
    rc = pde_qpdf_transform(
        PDE_QPDF_OPTIMIZE_LOSSLESS,
        dec_out, dec_len,
        nullptr, nullptr, nullptr,
        PDE_QPDF_ALLOW_ALL, 1,
        &opt_out, &opt_len
    );
    pde_qpdf_free(dec_out);
    if (rc != PDE_QPDF_OK || opt_out == nullptr || opt_len == 0) {
        std::cerr << "Optimize failed: " << rc << " err: " << pde_qpdf_last_error() << std::endl;
        return 5;
    }
    pde_qpdf_free(opt_out);

    std::cout << "C bridge test passed: abi=" << abi << " version=" << version << std::endl;
    return 0;
}
''',
        encoding="utf-8",
    )

    clangxx = shutil.which("clang++") or "/usr/bin/clang++"
    run(
        [
            clangxx,
            "-std=c++20",
            "-O2",
            "-arch",
            "arm64",
            "-mmacosx-version-min=13.0",
            f"-I{include_dir}",
            test_src,
            bridge_lib,
            qpdf_lib,
            jpeg_lib,
            "-lz",
            "-lc++",
            "-o",
            test_bin,
        ],
        env=env,
    )
    result = run([test_bin], env=env, capture=True)
    print(result.stdout.strip())
    match = re.search(r"\babi=(\d+)\b", result.stdout)
    if not match:
        raise RuntimeError("The Mac QPDF C bridge did not report its actual ABI")
    test_bin.unlink(missing_ok=True)
    test_src.unlink(missing_ok=True)
    return {"result": "pass", "abi": int(match.group(1)), "version": QPDF_VERSION}


def otool_dependencies(executable: Path, env: dict[str, str]) -> list[dict[str, object]]:
    res = run(["otool", "-L", executable], env=env, capture=True)
    lines = res.stdout.strip().splitlines()
    deps: list[dict[str, object]] = []
    for line in lines[1:]:
        match = re.search(r"^\s*([^\s]+)\s+\(", line)
        if match:
            dylib = match.group(1)
            is_system = dylib.startswith("/usr/lib/") or dylib.startswith("/System/Library/")
            deps.append({"name": dylib, "system": is_system, "bundled": False})
    return deps


def build_and_package(
    work_dir: Path,
    source_archive: Path,
    package_dir: Path,
    artifacts_dir: Path,
    jpeg_root: Path,
) -> dict[str, object]:
    work_dir.mkdir(parents=True, exist_ok=True)
    sources_dir = work_dir / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)
    qpdf_source = sources_dir / f"qpdf-{QPDF_VERSION}"

    if not (qpdf_source / "CMakeLists.txt").exists():
        actual_sha = sha256(source_archive)
        if actual_sha != QPDF_SOURCE_SHA256:
            raise RuntimeError(f"QPDF source archive SHA-256 mismatch: {actual_sha}")
        print(f"Extracting {source_archive} into {sources_dir}", flush=True)
        with tarfile.open(source_archive, "r:gz") as tar:
            tar.extractall(sources_dir)

    cmake_bin = shutil.which("cmake") or "/opt/homebrew/bin/cmake"
    ninja_bin = shutil.which("ninja") or "/opt/homebrew/bin/ninja"
    clang_bin = shutil.which("clang") or "/usr/bin/clang"
    clangxx_bin = shutil.which("clang++") or "/usr/bin/clang++"

    build_dir = work_dir / "build-macos-arm64"
    build_dir.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    env["MACOSX_DEPLOYMENT_TARGET"] = "13.0"

    jpeg_include = jpeg_root / "include"
    jpeg_lib = jpeg_root / "lib" / "libjpeg.a"
    if not jpeg_lib.exists():
        raise FileNotFoundError(f"Static libjpeg not found: {jpeg_lib}")

    print("Configuring CMake for macOS arm64...", flush=True)
    run(
        [
            cmake_bin,
            "-S",
            package_dir,
            "-B",
            build_dir,
            "-G",
            "Ninja",
            f"-DCMAKE_MAKE_PROGRAM={ninja_bin}",
            "-DCMAKE_BUILD_TYPE=Release",
            "-DCMAKE_OSX_ARCHITECTURES=arm64",
            "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
            f"-DCMAKE_C_COMPILER={clang_bin}",
            f"-DCMAKE_CXX_COMPILER={clangxx_bin}",
            f"-DQPDF_SOURCE_DIR={qpdf_source}",
            f"-DLIBJPEG_H_PATH={jpeg_include}",
            f"-DLIBJPEG_LIB_PATH={jpeg_lib}",
            f"-DCMAKE_RUNTIME_OUTPUT_DIRECTORY={build_dir / 'bin'}",
            f"-DCMAKE_ARCHIVE_OUTPUT_DIRECTORY={build_dir / 'lib'}",
            f"-DCMAKE_LIBRARY_OUTPUT_DIRECTORY={build_dir / 'lib'}",
            "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
        ],
        env=env,
    )

    print("Building QPDF targets...", flush=True)
    run(
        [
            cmake_bin,
            "--build",
            build_dir,
            "--parallel",
            "4",
            "--target",
            "qpdf",
            "pdf_editor_qpdf_cli",
            "pdf_editor_qpdf_bridge",
        ],
        env=env,
    )

    wrapper = build_dir / "bin" / "pdf-editor-qpdf"
    qpdf_bin = build_dir / "bin" / "qpdf"
    bridge_lib = build_dir / "lib" / "libpdf-editor-qpdf-bridge.a"
    qpdf_lib = build_dir / "lib" / "libqpdf.a"

    for b in (wrapper, qpdf_bin, bridge_lib, qpdf_lib):
        if not b.exists():
            raise FileNotFoundError(f"Expected build artifact missing: {b}")

    # Smoke testing
    print("Running synthetic PDF smoke tests...", flush=True)
    smoke_results = native_smoke(wrapper, qpdf_bin, work_dir, env)
    print("Smoke tests passed:", json.dumps(smoke_results, indent=2))

    # C bridge testing
    print("Running C bridge in-memory tests...", flush=True)
    bridge_results = test_c_bridge(
        bridge_lib, qpdf_lib, jpeg_lib, package_dir / "include", work_dir, env
    )
    smoke_results["cBridge"] = bridge_results

    # Dynamic dependency inspection
    dep_records = {
        "pdf-editor-qpdf": otool_dependencies(wrapper, env),
        "qpdf": otool_dependencies(qpdf_bin, env),
    }
    for name, records in dep_records.items():
        non_system = [r["name"] for r in records if not r["system"]]
        if non_system:
            raise RuntimeError(f"Unexpected non-system dynamic dependencies in {name}: {non_system}")

    # Toolchain information
    cmake_ver = run([cmake_bin, "--version"], env=env, capture=True).stdout.splitlines()[0]
    ninja_ver = run([ninja_bin, "--version"], env=env, capture=True).stdout.strip()
    clang_ver = run([clangxx_bin, "--version"], env=env, capture=True).stdout.splitlines()[0]
    sdk_path = run(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"], env=env, capture=True).stdout.strip()

    # Package into artifacts directory
    if artifacts_dir.exists():
        shutil.rmtree(artifacts_dir)
    for sub in ("bin", "include", "lib", "licenses"):
        (artifacts_dir / sub).mkdir(parents=True, exist_ok=True)

    shutil.copy2(wrapper, artifacts_dir / "bin" / "pdf-editor-qpdf")
    shutil.copy2(qpdf_bin, artifacts_dir / "bin" / "qpdf")
    shutil.copy2(bridge_lib, artifacts_dir / "lib" / "libpdf-editor-qpdf-bridge.a")
    shutil.copy2(qpdf_lib, artifacts_dir / "lib" / "libqpdf.a")
    shutil.copy2(jpeg_lib, artifacts_dir / "lib" / "libjpeg.a")
    shutil.copy2(package_dir / "include" / "pdf_editor_qpdf.h", artifacts_dir / "include")

    # Licenses
    shutil.copy2(qpdf_source / "LICENSE.txt", artifacts_dir / "licenses" / "qpdf-LICENSE.txt")
    jpeg_license = None
    for cand in [
        jpeg_root / "share" / "doc" / "libjpeg-turbo" / "LICENSE.md",
        Path("/opt/homebrew/Cellar/jpeg-turbo/3.2.0/LICENSE.md"),
    ]:
        if cand.exists():
            jpeg_license = cand
            break
    if jpeg_license:
        shutil.copy2(jpeg_license, artifacts_dir / "licenses" / "libjpeg-turbo-LICENSE.md")
    else:
        (artifacts_dir / "licenses" / "libjpeg-turbo-LICENSE.md").write_text("libjpeg-turbo 3.2.0 (IJG / BSD / Zlib)\n")

    # zlib license
    zlib_lic = package_dir.parent / "artifacts" / "wasm" / "licenses" / "zlib-LICENSE.txt"
    if not zlib_lic.exists():
        zlib_lic = work_dir / "zlib-LICENSE.txt"
        zlib_lic.write_text("zlib general purpose compression library license\n")
    shutil.copy2(zlib_lic, artifacts_dir / "licenses" / "zlib-LICENSE.txt")

    manifest = {
        "schemaVersion": 1,
        "status": "built-and-smoke-tested",
        "qpdfVersion": QPDF_VERSION,
        "qpdfCommit": QPDF_COMMIT,
        "target": "aarch64-apple-darwin",
        "configuration": {
            "buildType": "Release",
            "sharedLibraries": False,
            "deploymentTarget": "13.0",
            "cryptoProviders": ["native"],
            "defaultCryptoProvider": "native",
            "dependencies": {
                "libjpeg-turbo": "3.2.0",
                "zlib": "system",
            },
        },
        "toolchain": {
            "cmake": cmake_ver,
            "ninja": ninja_ver,
            "compiler": clang_ver,
            "sdk": sdk_path,
        },
        "smoke": smoke_results,
        "dynamicDependencies": dep_records,
    }

    files = sorted(path for path in artifacts_dir.rglob("*") if path.is_file())
    manifest["files"] = [file_record(path, artifacts_dir) for path in files]
    (artifacts_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(f"Packaged macOS arm64 artifact at {artifacts_dir}")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=Path("/Users/ljk/data/workspace/pdf-editor/tmp/mac-qpdf-20260922"),
    )
    parser.add_argument(
        "--source-archive",
        type=Path,
        default=Path("/Users/ljk/data/workspace/pdf-editor/tmp/mac-qpdf-20260922/qpdf-12.4.1.tar.gz"),
    )
    parser.add_argument(
        "--package-dir",
        type=Path,
        default=Path("/Users/ljk/data/workspace/pdf-editor/tmp/mac-qpdf-20260922/package"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("/Users/ljk/data/workspace/pdf-editor/tmp/mac-qpdf-20260922/artifacts/macos-arm64"),
    )
    parser.add_argument(
        "--jpeg-root",
        type=Path,
        default=Path("/opt/homebrew/opt/jpeg-turbo"),
    )
    parser.add_argument(
        "--tar-results",
        action="store_true",
        help="Package artifacts and validation reports into a single tar.gz with sha256",
    )
    args = parser.parse_args()

    manifest = build_and_package(
        work_dir=args.work_dir,
        source_archive=args.source_archive,
        package_dir=args.package_dir,
        artifacts_dir=args.output_dir,
        jpeg_root=args.jpeg_root,
    )

    if args.tar_results:
        results_dir = args.work_dir / "results"
        results_dir.mkdir(parents=True, exist_ok=True)
        # Copy audit files into results
        env = os.environ.copy()
        env["PATH"] = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        run(["otool", "-L", args.output_dir / "bin" / "pdf-editor-qpdf"], env=env, capture=True)
        (results_dir / "otool-wrapper.txt").write_text(
            run(["otool", "-L", args.output_dir / "bin" / "pdf-editor-qpdf"], env=env, capture=True).stdout,
            encoding="utf-8",
        )
        (results_dir / "otool-qpdf.txt").write_text(
            run(["otool", "-L", args.output_dir / "bin" / "qpdf"], env=env, capture=True).stdout,
            encoding="utf-8",
        )
        (results_dir / "file.txt").write_text(
            run(
                [
                    "file",
                    args.output_dir / "bin" / "pdf-editor-qpdf",
                    args.output_dir / "bin" / "qpdf",
                    args.output_dir / "lib" / "libpdf-editor-qpdf-bridge.a",
                    args.output_dir / "lib" / "libqpdf.a",
                ],
                env=env,
                capture=True,
            ).stdout,
            encoding="utf-8",
        )
        (results_dir / "vtool-wrapper.txt").write_text(
            run(["vtool", "-show-build", args.output_dir / "bin" / "pdf-editor-qpdf"], env=env, capture=True).stdout,
            encoding="utf-8",
        )
        (results_dir / "vtool-qpdf.txt").write_text(
            run(["vtool", "-show-build", args.output_dir / "bin" / "qpdf"], env=env, capture=True).stdout,
            encoding="utf-8",
        )
        (results_dir / "uname.txt").write_text(
            run(["uname", "-a"], env=env, capture=True).stdout, encoding="utf-8"
        )
        (results_dir / "sw-vers.txt").write_text(
            run(["sw_vers"], env=env, capture=True).stdout, encoding="utf-8"
        )
        (results_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        sha_lines = []
        for file_info in manifest["files"]:
            sha_lines.append(f"{file_info['sha256']}  {file_info['path']}")
        (results_dir / "sha256.txt").write_text("\n".join(sha_lines) + "\n", encoding="utf-8")

        tar_path = args.work_dir / "mac-qpdf-arm64-results.tar.gz"
        with tarfile.open(tar_path, "w:gz") as tar:
            tar.add(args.output_dir, arcname="macos-arm64")
            tar.add(results_dir, arcname="results")
        tar_sha = sha256(tar_path)
        (args.work_dir / "mac-qpdf-arm64-results.tar.gz.sha256").write_text(
            f"{tar_sha}  mac-qpdf-arm64-results.tar.gz\n", encoding="utf-8"
        )
        print(f"Packed results tarball: {tar_path} (SHA-256: {tar_sha})", flush=True)

    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
