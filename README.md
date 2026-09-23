# komopdf

A free, local-first PDF web editor built with React, Next.js, Tailwind CSS, shadcn/ui and Framer Motion. PDF rendering and editing run in a browser Worker using the shared PDFium-based WebAssembly core. Optional AI requests use the self-hostable gateway; documents are not processed on the gateway.

This repository contains the web application **and its shared editing engine**, not just a UI around a proprietary WASM binary. The desktop-specific Tauri host and komo Agent integration are maintained privately. Desktop installers will be available from [komopdf-releases](https://github.com/LJK0719/komopdf-releases) after release verification.

## Development

Use Node 24 and the `packageManager` version in `package.json`. No desktop repository, Claude account, or production credential is needed to build the web app.

```text
pnpm install --frozen-lockfile
python scripts/prepare-fonts.py
pnpm prepare:web-assets
pnpm typecheck
pnpm test
pnpm --filter @pdf-editor/web build
pnpm dev:web
```

Font preparation downloads the pinned open fonts listed in `resources/font-assets.json`; already verified cached files are reused. `prepare:web-assets` checks and stages the committed core/QPDF WASM artifacts plus all 18 fonts. It does not run the desktop runtime preparation or rebuild PDFium on every UI change. Never commit `resources/downloads`, `node_modules`, private documents or runtime credentials.

The static site output is `apps/web/dist`. Build it before `pnpm test:browser`; the browser launcher may require a locally installed browser. The gateway can be developed independently with `pnpm dev:gateway -- --credential-file <external-credential-file>`. Credentials stay outside the repository.

## Source layout

- `apps/web`: Next.js static site and browser host.
- `apps/gateway`: stateless, resource-limited AI gateway, including the shared desktop service protocol; no user Agent or PDF processing runs here.
- `packages/{contracts,commands,ai-client,editor}`: shared contracts, transaction UI and web AI.
- `native/pdf-core`: the actual C++ editing core and PDFium bridges.
- `native/wasm`, `native/vendor/patches`: fixed toolchain metadata, project patches, and current WASM artifacts.
- `native/qpdf`: source and pinned export-engine artifacts.
- `distribution/release-manifest.ts`: public desktop download format; never embed a GitHub token in the website.

Native source builds use the pinned PDFium revision, patches and Emscripten version in the native manifests. The current bootstrap scripts target Windows build tools; install the required compiler/SDK before rebuilding with `python scripts/build-core-api.py --target wasm`. Other native build hosts require their corresponding toolchain setup; the presence of source does not claim a tested one-command bootstrap on every OS. All source needed for the web runtime is included or referenced by pinned upstream revision.

## Scope and releases

Web documents are processed locally, with a limit of two documents, 50 MiB / 200 pages per source, and 100 MiB / 400 pages in total. Web OCR recognition is not provided. Desktop builds have no such business limits, but are still constrained by device resources.

The project is under active development; source availability is not a claim of a completed or signed desktop release. An empty `apps/web/public/releases/stable.json` means there are no published desktop installers. Do not replace it with guessed URLs.

## License and contributions

Original public source is licensed under Apache-2.0. Third-party libraries, font files and models retain their own licenses; their notices must accompany redistributed binaries. The license does not cover private desktop-specific source or grant rights to third-party components beyond their own terms.

Use small focused PRs, keep native/shared interfaces consistent, and run the relevant integration check at a complete work-package boundary. Do not upload private PDF files in public issues; use a synthetic or redacted reproducer. See `SECURITY.md` for confidential vulnerability reports.
