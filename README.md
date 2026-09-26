# komopdf

A free, local-first PDF web editor built with React, Next.js and Base UI. PDF rendering and editing run in a browser Worker using the shared PDFium-based WebAssembly core. The web interface currently has no AI assistant; the self-hostable gateway remains available for the desktop service and shared AI protocols.

This repository contains the web application **and its shared editing engine**, not just a UI around a proprietary WASM binary. The desktop-specific Tauri host and komo Agent integration are maintained privately. Desktop installers will be available from [komopdf-releases](https://github.com/LJK0719/komopdf-releases) after release verification.

## Development

Use Node 24 and the `packageManager` version in `package.json`. No desktop repository, Claude account, or production credential is needed to build the web app.

```text
pnpm install --frozen-lockfile
python scripts/prepare-fonts.py
uv run --cache-dir tmp/uv-cache scripts/prepare-font-library.py
pnpm prepare:web-assets
pnpm typecheck
pnpm test
pnpm --filter @pdf-editor/web build
pnpm dev:web
```

Font preparation downloads the pinned sources in `resources/font-assets.json` and `resources/font-library.json`, reusing existing verified files. The complete library has **39 families and 158 faces**; see the [font catalog and preparation notes](resources/FONT_LIBRARY.md). `prepare:web-assets` stages the prepared library and the core/QPDF WASM artifacts; fonts are fetched only when used. Web builds precompress fonts and engines for Nginx `gzip_static`. This does not run the desktop preparation or rebuild PDFium on every UI change. Never commit `resources/downloads`, `node_modules`, private documents or runtime credentials.

The static site output is `apps/web/dist`. The build finalizer publishes the flattened `__next.<route>.__PAGE__.txt` URLs requested by the client from the same build's nested segment files. Deploy these route payloads along with HTML; unlike hashed JS chunks, stale route payloads must not be carried forward. Missing `.txt` resources must return 404, not the editor HTML fallback. Build it before `pnpm test:browser`; the browser launcher may require a locally installed browser. The gateway can be developed independently with `pnpm dev:gateway -- --credential-file <external-credential-file>`. Credentials stay outside the repository.

## Interface

The website and shared editor support English and Simplified Chinese. The language menu follows your browser language on first use and remembers your choice locally. Editing tools are grouped by task; File contains open, save, export, print and close. Common Ctrl/Cmd shortcuts are supported.

The shared UI uses React 19, Base UI primitives for accessible menus, context menus, tooltips and dialogs, Lucide icons, and reusable CSS design tokens. UI translations live in `packages/editor/src/ui/messages.ts`; new labels should use `useI18n`/`translate`, never translate document content.

Home, Edit, Insert, Comment, Pages and View organize the ribbon. Reading defaults to continuous scrolling, with single/facing-page layouts, hand panning and text selection. Edit mode exposes object selection and context menus: double-click text to edit it on the page, use the top bar for its formatting, and select an image for replacement, cropping or rotation. Text finishes on blur or Ctrl/Cmd+Enter; Escape cancels. The right panel is reserved for explicit tasks such as find/replace, export and advanced tools, not a duplicate source/replacement text form. Desktop hosts can still supply their own komo panel.

Nested object hit testing prefers the smaller target with a small screen-space tolerance. Dragging inside a containing frame starts a marquee; dragging its edge moves it. Alt-drag starts a marquee over any object. Marquees select enclosed objects rather than inadvertently including the surrounding frame, while explicit groups keep their editing scope. Home no longer exposes a Merge PDFs shortcut; importing pages remains available under Insert/Pages.

The text ribbon includes effective character spacing, line-height multiplier and paragraph alignment. Ordinary text preserves Tc/Tw and TJ adjustments through replacement, font changes and saving. Edit paragraph recognizes adjacent, same-style horizontal text in the same column, respects table rules and content-order boundaries, and converts it through the existing undoable reflow command only on request. Opening a PDF never automatically merges or rewrites its contents. Different styles, rotated/RTL text, nested content and ambiguous layouts retain object editing rather than being forced into a paragraph. Small paragraph text edits preserve untouched style runs; line-height and alignment remain editable after save/reopen.

Pages opens a dedicated organizer with 1–4 columns or automatic wrapping. Ctrl/Cmd+wheel changes thumbnail size without zooming the browser; Ctrl/Cmd-click toggles pages, Shift-click extends from an anchor, and dragging reorders the selection. The ribbon and page/thumbnail context menus operate on the same selected pages. Copy captures a PDF snapshot for pasting within the active document, independently of later edits or deletion; extract exports a separate PDF. Deletion keeps at least one page. These changes use the existing atomic commands and undo history.

In Select mode, clicking text shows a reading caret. Its context menu can copy or highlight selected text, apply a content underline, or enter the in-place editor at the selected range/caret. Blank-space context menus add text at that location. The editable textarea retains native text cut/copy/paste and IME behavior; reading selection does not silently modify a document. Image menus include flip, rotate, replace and crop, and internal-link menus expose their resolved page destination. Bookmark reading/navigation is supported; bookmark creation is not exposed until a real write command exists.

Interaction references: the user's WPS PDF screenshots and PDFgear's official [text editing](https://www.pdfgear.com/windows-user-guide/edit-pdf-text.htm), [image editing](https://www.pdfgear.com/windows-user-guide/edit-pdf-image.htm) [navigation](https://www.pdfgear.com/windows-user-guide/navigate-pdf.htm) and [page reordering](https://www.pdfgear.com/windows-user-guide/reorder-pdf-pages.htm) guides. These are interaction references, not a claim that PDFgear is open source.

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
