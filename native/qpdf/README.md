# QPDF export processor

This package is the isolated P5 QPDF layer. It transforms a completed PDF export copy; it does not own or mutate the active PDFium document, session, undo history, Rust bridge, or UI state.

## Locked inputs

- QPDF `v12.4.1`, commit `c37f83ae468abb6cc741f43b2f6fdeb66e550ffb`
- Official release source archive and Windows dependency bundle with fixed hashes in `qpdf-lock.json`
- Windows: QPDF OpenSSL and native crypto providers, with OpenSSL selected by default
- macOS: QPDF native crypto provider, statically linked `libjpeg-turbo` 3.2.0, and system `libz`
- WASM: QPDF native crypto provider; Emscripten 6.0.9 project toolchain and its pinned zlib/libjpeg ports

Build targets from the project root:

```powershell
# Windows + WASM (local toolchains)
python scripts/build-qpdf.py --target all

# macOS arm64 (via authorized remote Mac or local macOS)
python scripts/build-qpdf.py --target macos
```

Build caches and synthetic validation files stay under `tmp/qpdf-work` (or remote task root `tmp/mac-qpdf-20260922`). Published artifacts are under `native/qpdf/artifacts`.

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

A separate `optimize-images` job accepts `imageQuality` (integer 1–95). It recompresses only eligible opaque 8-bit RGB/grayscale page images as JPEG when the resulting stream is smaller; transparent/masked, unsupported and unreachable image streams remain unchanged. No image downsampling is offered. A request with no smaller eligible page image fails rather than claiming a successful optimization. Text, paths, shared image references and AES-256 protection remain part of the export copy. Upstream QPDF also supports `--password-file=-`; the narrow project CLI keeps passwords and jobs on stdin, never command-line arguments.

## Native C bridge and WASM

`include/pdf_editor_qpdf.h` exposes ABI version 2 (the three original operation codes are unchanged):

- `PDE_QPDF_DECRYPT`
- `PDE_QPDF_ENCRYPT_AES256`
- `PDE_QPDF_OPTIMIZE_LOSSLESS`
- `pde_qpdf_transform` for complete in-memory PDF bytes and passwords
- `pde_qpdf_optimize_images` for explicit quality and in-memory copy optimization
- `pde_qpdf_free` for the returned output buffer

The Windows artifact includes the bridge static library and its complete static link closure. The macOS arm64 artifact provides the static bridge library, static libqpdf and static libjpeg-turbo, linking only against standard system libraries (`libz`, `libc++`, `libSystem`). The WASM artifact contains `pdf-editor-qpdf.js`, `pdf-editor-qpdf.wasm`, and the same C header. It is an ES module factory with no pthreads, growing memory, 64 MiB initial memory, and a 1 GiB configured maximum. Callers copy the export PDF and password strings into WASM memory and release the returned buffer with `pde_qpdf_free`.

## macOS artifact

`artifacts/macos-arm64/bin` contains:

- `pdf-editor-qpdf`: the narrow project CLI (Mach-O 64-bit executable arm64, minos 13.0)
- `qpdf`: the pinned upstream CLI for inspection and troubleshooting

`artifacts/macos-arm64/lib` contains:

- `libpdf-editor-qpdf-bridge.a`: static C bridge library
- `libqpdf.a`: static QPDF library
- `libjpeg.a`: static libjpeg-turbo library

Dynamic dependencies are strictly limited to Apple system libraries (`/usr/lib/libz.1.dylib`, `/usr/lib/libc++.1.dylib`, `/usr/lib/libSystem.B.dylib`). There are no third-party dylib dependencies or Homebrew runtime dependencies.

## Verified result and boundary

The manifests record Windows x64, macOS arm64, and WASM smoke tests that each performed:

1. AES-256 revision 6 encryption of a synthetic two-page PDF.
2. Reopen with the correct password and decryption.
3. QPDF structural checks.
4. Confirmation that both pages and both text streams remained present after decryption and lossless optimization.
5. In-memory C bridge transform roundtrip (encryption, decryption, lossless optimization).

Windows Rust and Web Worker adapters use the same local copy-export path. Real browser and native checks cover protected export, password reopening/editing, preservation on normal save, decrypted copies and retained history. Separate image-quality cases check new and existing JPEGs, shared references, opaque versus masked streams and preservation of text/vector content; the browser export UI was exercised with a real PDF. The layer never owns the active document. The macOS arm64 artifact is ABI2-built and passes the existing C bridge encryption/decryption/lossless smoke; its new image-quality operation still needs a dedicated Mac run. The artifacts do not claim signing, notarization, Intel execution or a completed installer. License files accompany the runtime for human review; this package makes no legal conclusion.
