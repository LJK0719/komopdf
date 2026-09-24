# QPDF export processor

This package is the isolated P5 QPDF layer. It transforms a completed PDF export copy; it does not own or mutate the active PDFium document, session, undo history, Rust bridge, or UI state.

## Locked inputs

- QPDF `v12.4.1`, commit `c37f83ae468abb6cc741f43b2f6fdeb66e550ffb`
- Official release source archive and Windows dependency bundle with fixed hashes in `qpdf-lock.json`
- Windows: QPDF OpenSSL and native crypto providers, with OpenSSL selected by default
- macOS: QPDF native crypto provider, statically linked `libjpeg-turbo` 3.2.0, and system `libz`
- WASM: QPDF native crypto provider; Emscripten 6.0.9 project toolchain and its pinned zlib/libjpeg ports

Build targets from the project root (use the shell native to the build host):

```text
# Windows + WASM (local toolchains)
python scripts/build-qpdf.py --target all

# macOS arm64 and x64 (via the authorized Mac; x64 runs under Rosetta)
python scripts/build-qpdf.py --target macos
# Prepare the pinned source archive from qpdf-lock.json inside this project's cache first.
/bin/bash scripts/build-libjpeg-macos-x64.sh <libjpeg-turbo-3.2.0.tar.gz> <project-cache>/jpeg-x64
python scripts/build-qpdf.py --target macos-x64 --jpeg-root <project-cache>/jpeg-x64
```

The x64 static libjpeg-turbo is built into the project cache from the SHA-pinned 3.2.0 source in `qpdf-lock.json`; it is not taken from the arm64 Homebrew bottle. Build caches and synthetic validation files stay under `tmp/qpdf-work` and the remote project's `tmp/mac-qpdf-*` directories. Native desktop artifacts are kept in ignored `native/qpdf/artifacts/macos-{arm64,x64}`; the browser WASM artifact is tracked.

## Windows artifact

`artifacts/windows-x64/bin` contains:

- `pdf-editor-qpdf.exe`: the narrow project CLI
- `qpdf.exe`: the pinned upstream CLI for inspection and troubleshooting
- the imported Visual C++ runtime DLLs required by these executables

The project CLI accepts no PDF password or transform option on the command line. It reads exactly one JSON job from standard input. The native caller creates an export-side temporary output, writes the JSON directly to child stdin, closes stdin, checks the exit status, and leaves final destination selection/write to the host. It must not put passwords in argv, ordinary logs, or password temporary files.

Supported job operations:

```json
{
  "operation": "decrypt",
  "inputFile": "export-copy.encrypted.pdf",
  "outputFile": "export-copy.decrypted.pdf",
  "inputPassword": "password supplied in process memory"
}
```

```json
{
  "operation": "encrypt-aes256",
  "inputFile": "export-copy.pdf",
  "outputFile": "export-copy.protected.pdf",
  "userPassword": "user password supplied in process memory",
  "ownerPassword": "owner password supplied in process memory",
  "encryptMetadata": true,
  "permissions": {
    "accessibility": true,
    "extract": true,
    "assemble": true,
    "annotateAndForm": true,
    "formFilling": true,
    "modifyOther": true,
    "print": "full"
  }
}
```

```json
{
  "operation": "optimize-lossless",
  "inputFile": "export-copy.pdf",
  "outputFile": "export-copy.optimized.pdf"
}
```

`permissions` is optional and defaults to allowing all listed operations. `print` accepts `full`, `low`, or `none`. AES-256 uses QPDF revision 6. The lossless optimization path regenerates object streams, applies only generalized lossless stream decoding/recompression, recompresses Flate streams, and drops unreachable objects; it does not decode/re-encode JPEG image data. If the optimization input is encrypted, QPDF preserves its encryption and `inputPassword` must open it.

Example downsampling job (password, when required, is passed via stdin as `inputPassword`):

```json
{"operation":"resample-images","inputFile":"export-copy.pdf","outputFile":"resampled-copy.pdf","imageQuality":70,"imageMaxEdge":1600}
```

A separate `optimize-images` job accepts `imageQuality` (integer 1–95) and retains original pixel dimensions; it only replaces eligible opaque 8-bit DeviceRGB/DeviceGray/DeviceCMYK page images when JPEG bytes are smaller. ICCBased/Indexed inputs remain unsupported rather than risking a color change. `resample-images` additionally requires a positive `imageMaxEdge` in pixels and performs aspect-preserving area downsampling before JPEG encoding. It fails if no eligible image actually shrinks in pixel dimensions. Transparent/masked, unsupported and unreachable image streams remain unchanged; text, paths, shared image references and AES-256 protection stay in the export copy. No path mutates the active editing document. Upstream QPDF also supports `--password-file=-`; the project CLI keeps passwords and jobs on stdin, never command-line arguments.

## Native C bridge and WASM

`include/pdf_editor_qpdf.h` exposes ABI version 2 (the three original operation codes are unchanged):

- `PDE_QPDF_DECRYPT`
- `PDE_QPDF_ENCRYPT_AES256`
- `PDE_QPDF_OPTIMIZE_LOSSLESS`
- `pde_qpdf_transform` for complete in-memory PDF bytes and passwords
- `pde_qpdf_optimize_images` for explicit quality-only copy optimization
- `pde_qpdf_resample_images` for an explicit maximum image edge and quality; additive ABI2 export
- `pde_qpdf_free` for the returned output buffer

The Windows artifact includes the bridge static library and its complete static link closure. The macOS arm64 and x64 artifacts each provide matching-architecture static bridge, libqpdf and libjpeg-turbo libraries, linking only against standard system libraries (`libz`, `libc++`, `libSystem`). The WASM artifact contains `pdf-editor-qpdf.js`, `pdf-editor-qpdf.wasm`, and the same C header. It is an ES module factory with no pthreads, growing memory, 64 MiB initial memory, and a 1 GiB configured maximum. Callers copy the export PDF and password strings into WASM memory and release the returned buffer with `pde_qpdf_free`.

## macOS artifact

Both `artifacts/macos-arm64` and `artifacts/macos-x64` have architecture-matched `bin` and `lib` directories:

- `bin/pdf-editor-qpdf`: the narrow project CLI (Mach-O arm64 or x86_64, minos 13.0)
- `bin/qpdf`: the pinned upstream CLI for inspection and troubleshooting
The matching `lib` directory contains:

- `libpdf-editor-qpdf-bridge.a`: static C bridge library
- `libqpdf.a`: static QPDF library
- `libjpeg.a`: static libjpeg-turbo library

Dynamic dependencies are strictly limited to Apple system libraries (`/usr/lib/libz.1.dylib`, `/usr/lib/libc++.1.dylib`, `/usr/lib/libSystem.B.dylib`). There are no third-party dylib dependencies or Homebrew runtime dependencies.

## Verified result and boundary

The manifests record Windows x64, macOS arm64, macOS x64 (run through Rosetta), and WASM smoke tests that each performed:

1. AES-256 revision 6 encryption of a synthetic two-page PDF.
2. Reopen with the correct password and decryption.
3. QPDF structural checks.
4. Confirmation that both pages and both text streams remained present after decryption and lossless optimization.
5. In-memory C bridge transform roundtrip (encryption, decryption, lossless optimization).

Windows Rust and Web Worker adapters use the same local copy-export path. Real Edge and native checks cover protection, decrypted copies, history isolation, and pixel downsampling while retaining searchable text. Synthetic RGB/Gray resampling on both macOS architectures verified smaller pixel dimensions, preserved masks/shared references/text/vector content and an explicit no-op failure; the x64 executable ran under Rosetta, not on Intel hardware. These QPDF results are not a signed or cleanly installed desktop application. Full license texts accompany the runtime.
