# komopdf

A free, local-first PDF web editor built with React, Next.js and Base UI. PDF rendering and editing run in a browser Worker using the shared PDFium-based WebAssembly core. The web interface includes **komo**, a lightweight multi-turn PDF Q&A assistant. Conversation state stays in memory, with no session or chat-storage management. Authorized text and up to two rendered scan pages can be sent to the self-hostable AI gateway; longer scans are better converted to Markdown with KOLMOPDF before use in another language model. Desktop komo remains a separate tool-using Agent.

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

Text editing reconstructs horizontal paragraphs from spatial lines and column/table boundaries, independently of PDF drawing order. Character-by-character drawing and mixed styles can be edited as one paragraph. Detection does not rewrite the PDF: the first real edit materializes an undoable logical paragraph. Complex rotated/RTL, nested, and ambiguous content retains object-level editing instead of being merged blindly.

The in-place paragraph editor uses Lexical for selection, IME and rich text, and the shared HarfBuzz/ICU core for saved layout. The ribbon includes fonts, effective character spacing, line-height multiplier and alignment; **Paragraph settings** adds first-line indent, fixed line spacing and space before/after. **Copy format** / **Apply format** also supplies the next new text box's defaults. Font sizes and spacing are stored in PDF points; view zoom is only a display transformation.

Paragraphs grow without shrinking their font. When the page's available space ends, linked fragments continue on new pages without moving unrelated artwork. One undo restores the text and generated pages; saved PDFs retain logical flow metadata for subsequent editing. Empty generated continuation pages are reclaimed when safe. This is paragraph-level continuation, not unrestricted Word-style reflow of the entire PDF.

Export supports PDF, PNG/JPEG (ZIP for multiple pages), reading-order text and self-contained fixed-layout HTML locally in the browser. Desktop hosts additionally provide local, editable DOCX conversion from the current edited PDF snapshot. DOCX reconstructs text, columns, tables and images; unclassified vector artwork is preserved as local graphic crops, not screenshots of the page text. Fonts, complex layering and scans still require review; DOCX conversion is not lossless and web OCR/Word conversion are not enabled.

Pages opens a dedicated organizer with 1–4 columns or automatic wrapping. Ctrl/Cmd+wheel changes thumbnail size without zooming the browser; Ctrl/Cmd-click toggles pages, Shift-click extends from an anchor, and dragging reorders the selection. The ribbon and page/thumbnail context menus operate on the same selected pages. Copy captures a PDF snapshot for pasting within the active document, independently of later edits or deletion; extract exports a separate PDF. Deletion keeps at least one page. These changes use the existing atomic commands and undo history.

In Select mode, clicking text shows a reading caret. Its context menu can copy or highlight selected text, apply a content underline, or enter the in-place editor at the selected range/caret. Blank-space context menus add text at that location. The rich paragraph editor retains cut/copy/paste and IME behavior. Reading selection uses real character geometry and spatial reading order, including end-of-line caret affinity, rather than re-typesetting the PDF in a transparent browser font; selecting text never modifies the document. Image menus include flip, rotate, replace and crop, and internal-link menus expose their resolved page destination. Bookmark reading/navigation is supported; bookmark creation is not exposed until a real write command exists.

Interaction references: the user's WPS PDF screenshots and PDFgear's official [text editing](https://www.pdfgear.com/windows-user-guide/edit-pdf-text.htm), [image editing](https://www.pdfgear.com/windows-user-guide/edit-pdf-image.htm) [navigation](https://www.pdfgear.com/windows-user-guide/navigate-pdf.htm) and [page reordering](https://www.pdfgear.com/windows-user-guide/reorder-pdf-pages.htm) guides. These are interaction references, not a claim that PDFgear is open source.

## Source layout

- `apps/web`: Next.js static site and browser host.
- `apps/gateway`: resource-limited AI gateway, including the shared desktop service protocol, Clerk authentication, Stripe subscriptions and a persistent SQLite token ledger; no user Agent or PDF processing runs here.
- `packages/{contracts,commands,ai-client,editor}`: shared contracts, transaction UI and web AI.
- `native/pdf-core`: the actual C++ editing core and PDFium bridges.
- `native/wasm`, `native/vendor/patches`: fixed toolchain metadata, project patches, and current WASM artifacts.
- `native/qpdf`: source and pinned export-engine artifacts.
- `distribution/release-manifest.ts`: public desktop download format; never embed a GitHub token in the website.

Native source builds use the pinned PDFium revision, patches and Emscripten version in the native manifests. The current bootstrap scripts target Windows build tools; install the required compiler/SDK before rebuilding with `python scripts/build-core-api.py --target wasm`. Other native build hosts require their corresponding toolchain setup; the presence of source does not claim a tested one-command bootstrap on every OS. All source needed for the web runtime is included or referenced by pinned upstream revision.

## KOMO accounts and billing

All non-AI PDF tools remain free without an account. KOMO requires Clerk sign-in, with a one-time allowance of 1,000 credits (100,000 input/output tokens). KOMO Plus is $4.99 USD/month and has no credit ceiling while the paid subscription is active; normal request-size/concurrency limits still apply. `/account/` supports profiles, Checkout, billing management and explicit desktop login approval. KolmoPDF parsing uses the user's own API key and separate KolmoPDF balance, not the Plus subscription.

To enable the gateway, configure a dedicated Clerk app (`CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`), a persistent `KOMO_ACCOUNT_DB`, `KOMO_PUBLIC_ORIGIN`, and Stripe (`STRIPE_RESTRICTED_KEY`, `STRIPE_KOMO_PRICE_ID`, `STRIPE_KOMO_PORTAL_CONFIG_ID`, `STRIPE_WEBHOOK_SECRET`). The Price must be active USD 499 cents per month. Use server credential storage, not committed environment files. The webhook endpoint is `/api/account/webhook`; configure subscription created/updated/deleted and Checkout completion/async-payment-success events. Complete Stripe Tax and Customer Portal configuration before live billing. See `infra/pdf-editor-gateway.service.example` and `infra/nginx.conf.example`. Without account configuration, AI endpoints fail closed; PDF tools continue to work.

## Scope and releases

Web documents are processed locally, with a limit of two documents, 50 MiB / 200 pages per source, and 100 MiB / 400 pages in total. Working documents also remain within the page limit after automatic continuation; an oversized candidate is rejected without changing revision/history. Browser conversions allow up to 200 output page instances (including repeats), a 64 MiB accumulated encoded-output budget, and a 16 MiB HTML budget accounting for base64 expansion. Oversized exports should use fewer pages/lower DPI or the desktop app. Web OCR recognition is not provided. Desktop builds have no such web business limits, but are still constrained by device resources.

The project is under active development. An empty `apps/web/public/releases/stable.json` means there are no published desktop installers. Do not replace it with guessed URLs.

## License and contributions

Original public source is licensed under Apache-2.0. Third-party libraries, font files and models retain their own licenses; their notices must accompany redistributed binaries. The license does not cover private desktop-specific source or grant rights to third-party components beyond their own terms.

Use small focused PRs, keep native/shared interfaces consistent, and run the relevant integration check at a complete work-package boundary. Do not upload private PDF files in public issues; use a synthetic or redacted reproducer. See `SECURITY.md` for confidential vulnerability reports.
