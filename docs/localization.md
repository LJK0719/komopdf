# Localization and public pages

komopdf supports English, Simplified Chinese, Traditional Chinese, Japanese, Korean, German, French, Spanish, Brazilian Portuguese, Italian and Russian. UI language is independent of document content, OCR languages and AI output languages.

## Translation resources

- `packages/editor/src/ui/locales.ts` defines supported locales and URL segments.
- Existing English message strings are keys. Maintain translations in the shared UI and site catalogs, not in generated public catalogs.
- Run `pnpm i18n:public` after changing public copy or account error messages. `pnpm i18n:public --check` checks that generated resources match their sources.
- Public pages receive only their small translation subset. Starting an editor loads the full UI resources for its language.
- Each rendered page or workspace has its own i18next instance. Embedded editors set their own `lang`; they do not change the language of the surrounding static document.
- Preserve interpolation parameters, document names, product names and format syntax. Use locale-appropriate plural variants for counts.

## Navigation and indexing

English keeps the original URLs; other languages use directories such as `/ja/` and `/pt-br/`. Static parameters enumerate published language/page combinations. Unsupported combinations return 404 rather than indexable English fallback content.

Public pages provide localized metadata, self-referencing canonical URLs and reciprocal language alternatives. Account, billing and authentication pages are excluded from indexing. The sitemap includes only canonical public pages. The existing homepage remains the editor.

Tool pages enter a dedicated workspace when opened. Marketing navigation is hidden while editing, and returning to a guide goes through the editor's existing unload protection. Workspace language changes preserve the current document, selection, zoom and draft without changing the guide URL. Explicit website language selection clears an obsolete `lang` query parameter while preserving unrelated authentication return context.

## Checks

Use the existing TypeScript, Vitest and Playwright commands. Locale tests verify message coverage, parameters, plural forms and generated resource equivalence. Website tests cover static metadata, reciprocal alternatives, 404/noindex behavior, account language selection, unsaved-work navigation and export after switching through all supported languages.

References: [Google localized pages](https://developers.google.com/search/docs/specialty/international/localized-versions), [Google multilingual sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites), [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports), [react-i18next SSR](https://react.i18next.com/latest/ssr).
