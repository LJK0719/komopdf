import { useI18n } from './i18n.js';
import { useEffect, useId, useRef, useState } from 'react';
import type { CommitResult, DocumentInfo, EngineAdapter } from '@pdf-editor/contracts';
import { CommandRegistry } from '@pdf-editor/commands';
import { findSearchRanges, nextSearchIndex, type SearchOptions } from './search-matching.js';

type Match = {
  pageId: string; blockId: string; pageNumber: number; range: { start: number; end: number }; excerpt: string;
};
type SearchSnapshot = Pick<DocumentInfo, 'id' | 'revision' | 'pageOrder'>;
type SearchState = {
  docId: string; revision: number; engine: EngineAdapter;
  matches: Match[]; status: 'searching' | 'complete' | 'stopped' | 'failed'; scannedPages: number;
};
type Props = { document: DocumentInfo | null; engine: EngineAdapter; disabled: boolean;
  onLocate(pageId: string, blockId: string, range?: { start: number; end: number }): void;
  onCommitted?(result: CommitResult): Promise<void>; onBusyChange?(busy: boolean): void };

/** Search one page at a time; keep only hit locations and short excerpts, never extracted page text. */
export async function searchPdfDocument(
  engine: Pick<EngineAdapter, 'extract'>,
  snapshot: SearchSnapshot,
  query: string,
  signal: AbortSignal,
  onProgress: (matches: Match[], scannedPages: number) => void,
  options: SearchOptions = {},
): Promise<Match[]> {
  const found: Match[] = [];
  if (!query) return found;
  for (let index = 0; index < snapshot.pageOrder.length; index++) {
    if (signal.aborted) break;
    const pageId = snapshot.pageOrder[index]!;
    const blocks = await engine.extract({ docId: snapshot.id, pageIds: [pageId] });
    if (signal.aborted) break;
    for (const block of blocks) {
      const text = block.runs.map(run => run.text).join('');
      for (const range of findSearchRanges(text, query, options)) {
        found.push({ pageId, blockId: block.id, pageNumber: index + 1, range,
          excerpt: text.slice(Math.max(0, range.start - 35), range.end + 65) });
      }
    }
    onProgress([...found], index + 1);
  }
  return found;
}

export function PdfSearchPanel({ document, engine, disabled, onLocate, onCommitted, onBusyChange }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [selected, setSelected] = useState<Match | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SearchState | null>(null);
  const queryInput = useRef<HTMLInputElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const statusId = useId();
  const wordHelpId = useId();
  const operation = useRef<AbortController | null>(null);
  const current = useRef({ docId: document?.id, revision: document?.revision, engine });
  current.current = { docId: document?.id, revision: document?.revision, engine };
  useEffect(() => {
    operation.current?.abort();
    operation.current = null;
    setResult(null); setSelected(null); setError('');
    return () => operation.current?.abort();
  }, [document?.id, document?.revision, engine]);
  useEffect(() => {
    selectedButton.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const visible = document && result?.docId === document.id && result.revision === document.revision
    && result.engine === engine ? result : null;
  const searching = visible?.status === 'searching';
  const selectedIndex = selected && visible ? visible.matches.indexOf(selected) : -1;
  const canNavigate = !disabled && !replacing && !searching && !!visible?.matches.length;

  function invalidateSearch() {
    operation.current?.abort(); operation.current = null;
    setResult(null); setSelected(null); setError('');
  }

  function locate(match: Match) {
    setSelected(match);
    onLocate(match.pageId, match.blockId, match.range);
  }

  function navigate(direction: 1 | -1) {
    if (!canNavigate || !visible) return;
    const match = visible.matches[nextSearchIndex(selectedIndex, visible.matches.length, direction)];
    if (match) locate(match);
  }

  async function search(direction: 1 | -1 = 1) {
    if (!document || !query.trim() || disabled || replacing) return;
    operation.current?.abort(); setError(''); setSelected(null);
    const controller = new AbortController();
    operation.current = controller;
    const snapshot: SearchSnapshot = { id: document.id, revision: document.revision, pageOrder: [...document.pageOrder] };
    const belongsToCurrentDocument = () => !controller.signal.aborted && operation.current === controller
      && current.current.docId === snapshot.id && current.current.revision === snapshot.revision
      && current.current.engine === engine;
    setResult({ docId: snapshot.id, revision: snapshot.revision, engine,
      matches: [], status: 'searching', scannedPages: 0 });
    try {
      const matches = await searchPdfDocument(engine, snapshot, query.trim(), controller.signal, (found, scannedPages) => {
        if (belongsToCurrentDocument()) setResult({ docId: snapshot.id, revision: snapshot.revision, engine,
          matches: found, status: 'searching', scannedPages });
      }, { matchCase, wholeWord });
      if (belongsToCurrentDocument()) {
        setResult({ docId: snapshot.id, revision: snapshot.revision, engine,
          matches, status: 'complete', scannedPages: snapshot.pageOrder.length });
        const first = matches[nextSearchIndex(-1, matches.length, direction)];
        if (first) locate(first);
      }
    } catch (error) {
      if (belongsToCurrentDocument()) {
        setError(error instanceof Error ? error.message : t('Search failed'));
        setResult(previous => previous && ({ ...previous, status: 'failed' }));
      }
    } finally {
      if (operation.current === controller) operation.current = null;
    }
  }

  function navigateOrSearch(direction: 1 | -1) {
    if (visible) navigate(direction);
    else void search(direction);
  }

  // Rebind with current state, and remove the listener when this panel unmounts.
  // F3 belongs to PDF search only outside other editing fields (including replacement).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'F3' || event.defaultPrevented || event.isComposing || event.keyCode === 229
        || event.altKey || event.ctrlKey || event.metaKey || disabled || replacing || !document || !query.trim()) return;
      const target = event.composedPath()[0];
      if (target instanceof Element && target !== queryInput.current
        && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"]')) return;
      event.preventDefault();
      navigateOrSearch(event.shiftKey ? -1 : 1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function replace() {
    if (!document || !selected || !onCommitted || disabled || replacing || !visible || searching) return;
    setReplacing(true); onBusyChange?.(true); setError('');
    try {
      const page = await engine.describePage(document.id, selected.pageId);
      const range: [number, number] = [selected.range.start, selected.range.end];
      const layout = await engine.previewText({ docId: document.id, pageId: page.id, blockId: selected.blockId, range, text: replacement });
      if (layout.overflow) throw new Error(t('Text does not fit. Shorten it or use a smaller font size.'));
      const result = await new CommandRegistry(engine).execute({ id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual',
        commands: [{ type: 'text.replace', pageId: page.id, blockId: selected.blockId, range, text: replacement }] }, { document, pages: new Map([[page.id, page]]) });
      await onCommitted(result);
      invalidateSearch();
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('Replace failed')); }
    finally { setReplacing(false); onBusyChange?.(false); }
  }

  const count = visible?.matches.length ?? 0;
  const countLabel = t('{current} of {count}', { current: selectedIndex + 1, count });
  return <section className="text-edit-panel" aria-label={t('Find in document')}>
    <details open><summary>{t('Find in document')}</summary>
      <form onSubmit={event => { event.preventDefault(); if (!searching) void search(); }}>
        {/* Cross-page locate briefly makes the host busy; readOnly preserves query focus. */}
        <label>{t('Find text')}<input ref={queryInput} value={query} disabled={!document || replacing}
          readOnly={disabled} aria-disabled={disabled || undefined}
          aria-describedby={statusId} aria-keyshortcuts="Enter Shift+Enter F3 Shift+F3"
          onChange={event => { setQuery(event.target.value); invalidateSearch(); }}
          onKeyDown={event => {
            if (event.key !== 'Enter') return;
            // Never let IME confirmation submit the form, even in Safari's keyCode=229 case.
            event.preventDefault();
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
            navigateOrSearch(event.shiftKey ? -1 : 1);
          }} /></label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button disabled={!document || disabled || replacing || searching || !query.trim()} type="submit">{t('Find')}</button>
          {searching && <button type="button" onClick={() => {
            operation.current?.abort(); operation.current = null;
            setResult(previous => previous && ({ ...previous, status: 'stopped' }));
          }}>{t('Stop search')}</button>}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" checked={matchCase}
            disabled={!document || disabled || replacing} onChange={event => { setMatchCase(event.target.checked); invalidateSearch(); }} />{t('Match case')}</label>
          <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" checked={wholeWord} aria-describedby={wordHelpId}
            disabled={!document || disabled || replacing} onChange={event => { setWholeWord(event.target.checked); invalidateSearch(); }} />{t('Whole words')}</label>
        </div>
        <p id={wordHelpId} style={{ marginTop: 6 }}>{t('Whole words use Unicode letter/number boundaries, not Chinese word segmentation.')}</p>
      </form>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" disabled={!canNavigate} title={t('Previous match (Shift+Enter / Shift+F3)')}
          onClick={() => navigate(-1)}>{t('Previous match')}</button>
        <button type="button" disabled={!canNavigate} title={t('Next match (Enter / F3)')}
          onClick={() => navigate(1)}>{t('Next match')}</button>
      </div>
      <p role="status" id={statusId} aria-live="polite" aria-atomic="true">
        {searching ? t('Searching… {pages} / {total} pages · {count} matches', { pages: visible.scannedPages, total: document?.pageOrder.length ?? 0, count })
          : visible?.status === 'stopped' ? `${t('Search stopped')} · ${countLabel}`
          : visible?.status === 'failed' ? `${t('Search failed')} · ${countLabel}`
          : visible ? count ? countLabel : t('No matches found') : t('Enter text and press Enter to search.')}
      </p>
      {onCommitted && document?.permissions.modify && document.capabilities.includes('text.replace') && <>
        <label>{t('Replace with')}<input value={replacement} disabled={disabled || replacing} onChange={event => setReplacement(event.target.value)} /></label>
        <button type="button" disabled={!canNavigate || !selected} onClick={() => void replace()}>{t('Replace selected match')}</button>
      </>}
      {error && <p role="alert">{t(error)}</p>}
      {!!count && <div style={{ display: 'grid', gap: 6, maxHeight: 280, overflowY: 'auto' }} aria-label={t('Search results')}>
        {visible?.matches.map(match => {
          const excerptStart = Math.min(35, match.range.start);
          const excerptEnd = excerptStart + match.range.end - match.range.start;
          return <button type="button" key={`${match.pageId}:${match.blockId}:${match.range.start}:${match.range.end}`}
            ref={selected === match ? selectedButton : undefined} aria-pressed={selected === match} disabled={!canNavigate}
            style={{ textAlign: 'start', overflowWrap: 'anywhere', ...(selected === match ? { background: '#edf7f2', borderColor: 'var(--accent)', fontWeight: 600 } : {}) }}
            onClick={() => locate(match)}>{t('Page {page}', { page: match.pageNumber })}: {match.excerpt.slice(0, excerptStart)}<mark>{match.excerpt.slice(excerptStart, excerptEnd)}</mark>{match.excerpt.slice(excerptEnd)}</button>;
        })}
      </div>}
    </details>
  </section>;
}
