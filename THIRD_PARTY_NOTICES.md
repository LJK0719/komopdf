# Third-party notices

Apache-2.0 covers komopdf's **original public source**, not the private desktop implementation or third-party libraries, fonts and runtime code. Each third-party component retains its own license. This inventory and its hashes are technical records, not a legal clearance.

## PDF core

The fixed PDFium revision is recorded in `native/wasm/runtime-build.json` and `native/wasm/wasm-lock.json`. The native components below were identified from the current `pdf_core_runtime` / `libpdfium` Ninja link inputs. Full upstream notice texts are retained in `third_party/notices/`:

| Component | Retained notice files |
|---|---|
| PDFium | `pdfium-LICENSE.txt`, `pdfium-AUTHORS.txt` |
| Abseil C++ | `abseil-cpp-LICENSE.txt`, `abseil-cpp-AUTHORS.txt` |
| Anti-Grain Geometry 2.3 | `agg23-copying.txt` |
| FreeType | `freetype-FTL.txt`, `freetype-LICENSE.txt` |
| HarfBuzz | `harfbuzz-COPYING.txt`, `harfbuzz-AUTHORS.txt` |
| ICU | `icu-LICENSE.txt` |
| Little CMS | `lcms-LICENSE.txt` |
| libjpeg-turbo / IJG | `libjpeg_turbo-LICENSE.md`, `libjpeg_turbo-README.ijg.txt` |
| OpenJPEG | `libopenjpeg-LICENSE.txt` |
| zlib | `zlib-LICENSE.txt` |

Test-only libraries and host build utilities are not included in this runtime inventory. The compiler executable itself is a build tool, but **generated Emscripten JavaScript and linked C/C++ runtime support are not merely build tools**: notices for Emscripten, musl, libc++, libc++abi, compiler-rt and LLVM libc are also retained. See `emscripten-LICENSE.txt`, `musl-COPYRIGHT.txt`, `libcxx-LICENSE.txt`, `libcxxabi-LICENSE.txt`, `compiler-rt-LICENSE.txt` and `llvm-libc-LICENSE.txt`.

## QPDF export engine

`native/qpdf/artifacts/wasm/manifest.json` records the current artifact. Original QPDF, IJG libjpeg and zlib license texts remain in that artifact's `licenses/` directory, with archived copies in `third_party/notices/`. QPDF's original text is Apache-2.0; do not infer an extra exception from this summary.

## Fonts

The six families / 18 faces and exact sources are defined by `resources/font-assets.json`. The original OFL texts for Noto Sans CJK SC, Noto Serif CJK SC, LXGW WenKai and the Liberation Sans/Serif/Mono families are archived as `font-*-OFL.txt`. Copyright and any reserved font names are governed by those original texts, not a shortened table here.

The font binaries are downloaded from fixed sources and staged with their licenses; the approximately 133 MiB font set is not committed to Git. Web and desktop resource preparation preserve the same notices.

## JavaScript dependencies

Dependencies in `pnpm-lock.yaml` retain the license texts shipped in their npm packages. Packaging a JavaScript bundle does not waive these notices: esbuild legal comments and the upstream package licenses must be retained in the corresponding distribution. This native inventory is not a complete npm SBOM or a signature/installation attestation.

## Maintenance

Verify committed notice bytes without a local native toolchain:

```text
python scripts/collect-core-notices.py --check
```

To refresh notices after an intentional dependency update, prepare the matching source/toolchain and fonts, then run the collector with `--source-root` and `--emscripten-root` as necessary. `third_party/notices/manifest.json` records source-relative provenance, sizes and SHA-256 values, never a developer's private absolute path. Review dependency changes and preserve applicable attributions; do not treat a matching hash as proof of complete license compliance.
