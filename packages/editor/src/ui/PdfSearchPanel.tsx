import { useI18n } from './i18n.js';
import { memo, useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { CommitResult, DocumentInfo, EngineAdapter } from '@pdf-editor/contracts';
import { nextSearchIndex, type SearchOptions } from './search-matching.js';
import { searchPage, prepareSearchReplacement, type PdfSearchMatch as Match } from './page-search.js';
import { AppDialog } from './AppDialog.js';
import { unrecognizedImageRegions } from './ocr-regions.js';
import './panel-refresh.css';

type SearchSnapshot = Pick<DocumentInfo, 'id' | 'revision' | 'pageOrder'>;
type SearchState = {
  docId: string; revision: number; engine: EngineAdapter;
  matches: Match[]; status: 'searching' | 'complete' | 'stopped' | 'failed'; scannedPages: number;
};
type Props = { document: DocumentInfo | null; engine: EngineAdapter; disabled: boolean;
  active?: boolean; onRequestOcr?: (() => void) | undefined; resumeSearch?: number;
  onLocate(match: Match): void;
  onCommitted?(result: CommitResult): Promise<void>; onBusyChange?(busy: boolean): void };

const SearchResult = memo(function SearchResult({ match, selected, disabled, selectedButton, onLocate }: {
  match: Match; selected: boolean; disabled: boolean; selectedButton: RefObject<HTMLButtonElement | null>; onLocate(match: Match): void;
}) {
  const { t } = useI18n();
  const { start, end } = match.excerptRange;
  return <button type="button" ref={selected ? selectedButton : undefined} aria-pressed={selected} disabled={disabled}
    className="pdf-search-result"
    onClick={() => onLocate(match)}>{t('Page {page}', { page: match.pageNumber })}: {match.excerpt.slice(0, start)}<mark>{match.excerpt.slice(start, end)}</mark>{match.excerpt.slice(end)}</button>;
});

/** Search one page at a time; keep only hit locations and short excerpts, never extracted page text. */
export async function searchPdfDocument(
  engine: Pick<EngineAdapter, 'describePage'>,
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
    const page = await engine.describePage(snapshot.id, pageId);
    if (signal.aborted) break;
    found.push(...searchPage(page, index + 1, query, options));
    onProgress([...found], index + 1);
  }
  return found;
}

export function PdfSearchPanel({ document, engine, disabled, active = true, onRequestOcr, resumeSearch = 0, onLocate, onCommitted, onBusyChange }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [selected, setSelected] = useState<Match | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scanPages, setScanPages] = useState<number[]>([]);
  const [askOcr, setAskOcr] = useState(false);
  const promptedDocument = useRef('');
  useEffect(() => {
    if (!active || !document) return;
    let cancelled = false;
    setScanPages([]);
    void (async () => {
      const pages: number[] = [];
      for (const [index, pageId] of document.pageOrder.entries()) {
        if (cancelled) return;
        const page = await engine.describePage(document.id, pageId);
        if (unrecognizedImageRegions(page).length) pages.push(index + 1);
      }
      if (!cancelled) {
        setScanPages(pages);
        if (pages.length && promptedDocument.current !== document.id) {
          promptedDocument.current = document.id; setAskOcr(true);
        }
      }
    })().catch(caught => { console.warn('Unable to inspect searchable text', caught); });
    return () => { cancelled = true; };
  }, [active, document?.id, document?.revision, engine]);
  const [result, setResult] = useState<SearchState | null>(null);
  const queryInput = useRef<HTMLInputElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const statusId = useId();
  const wordHelpId = useId();
  const operation = useRef<AbortController | null>(null);
  const progressFrame = useRef(0);
  const pendingProgress = useRef<SearchState | null>(null);
  const cancelProgress = () => {
    cancelAnimationFrame(progressFrame.current); progressFrame.current = 0; pendingProgress.current = null;
  };
  const current = useRef({ docId: document?.id, revision: document?.revision, engine });
  current.current = { docId: document?.id, revision: document?.revision, engine };
  useEffect(() => {
    operation.current?.abort();
    operation.current = null;
    cancelProgress(); setResult(null); setSelected(null); setError('');
    return () => { operation.current?.abort(); cancelProgress(); };
  }, [document?.id, document?.revision, engine]);
  useEffect(() => {
    selectedButton.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const visible = document && result?.docId === document.id && result.revision === document.revision
    && result.engine === engine ? result : null;
  const searching = visible?.status === 'searching';
  const selectedIndex = selected && visible ? visible.matches.indexOf(selected) : -1;
  const canNavigate = !disabled && !replacing && !searching && !!visible?.matches.length;
  const canContinue = !disabled && !replacing && !searching && Boolean(document && query.trim())
    && (!visible || visible.matches.length > 0);
  useEffect(() => { setNotice(''); }, [document?.id]);

  function invalidateSearch() {
    operation.current?.abort(); operation.current = null; cancelProgress();
    setResult(null); setSelected(null); setError(''); setNotice('');
  }

  const locate = useCallback((match: Match) => {
    setSelected(match);
    onLocate(match);
  }, [onLocate]);

  function navigate(direction: 1 | -1) {
    if (!canNavigate || !visible) return;
    const match = visible.matches[nextSearchIndex(selectedIndex, visible.matches.length, direction)];
    if (match) locate(match);
  }

  async function search(direction: 1 | -1 = 1) {
    if (!document || !query.trim() || disabled || replacing) return;
    operation.current?.abort(); cancelProgress(); setError(''); setNotice(''); setSelected(null);
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
        if (!belongsToCurrentDocument()) return;
        pendingProgress.current = { docId: snapshot.id, revision: snapshot.revision, engine,
          matches: found, status: 'searching', scannedPages };
        if (!progressFrame.current) progressFrame.current = requestAnimationFrame(() => {
          progressFrame.current = 0;
          if (belongsToCurrentDocument() && pendingProgress.current) setResult(pendingProgress.current);
        });
      }, { matchCase, wholeWord });
      if (belongsToCurrentDocument()) {
        cancelProgress();
        setResult({ docId: snapshot.id, revision: snapshot.revision, engine,
          matches, status: 'complete', scannedPages: snapshot.pageOrder.length });
        const first = matches[nextSearchIndex(-1, matches.length, direction)];
        if (first) locate(first);
      }
    } catch (error) {
      if (belongsToCurrentDocument()) {
        setError(error instanceof Error ? error.message : t('Search failed'));
        const progress = pendingProgress.current; cancelProgress();
        setResult(previous => (progress ?? previous) && ({ ...(progress ?? previous)!, status: 'failed' }));
      }
    } finally {
      if (operation.current === controller) operation.current = null;
    }
  }

  useEffect(() => {
    if (active && query.trim() && !disabled && !replacing) void search();
  }, [active, resumeSearch]);

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
      const transaction = await prepareSearchReplacement(engine, document, selected, replacement);
      const result = await engine.apply(transaction);
      await onCommitted(result);
      invalidateSearch();
      setNotice('Match replaced. Choose Next match or press Enter to continue searching.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('Replace failed')); }
    finally { setReplacing(false); onBusyChange?.(false); }
  }

  const count = visible?.matches.length ?? 0;
  const countLabel = t('{current} of {count}', { current: selectedIndex + 1, count });
  return <section className="text-edit-panel task-panel pdf-search-panel" aria-label={t('Find in document')}>
    <header className="task-panel-header"><h2>{t('Find in document')}</h2></header>
    <AppDialog open={active && askOcr} onOpenChange={setAskOcr} title={t('Recognize text for search?')}>
      <p>{t('This document contains scanned pages. Recognize text throughout the document to make it searchable?')}</p>
      {!onRequestOcr && <p>{t(document && !document.permissions.modify ? 'This document does not allow adding a searchable text layer.' : 'Open this PDF in the desktop app to recognize scanned text.')}</p>}
      <footer><button type="button" onClick={() => setAskOcr(false)}>{t('Not now')}</button>
        {onRequestOcr && <button type="button" className="button button-primary" disabled={disabled} onClick={() => { setAskOcr(false); onRequestOcr(); }}>{t('Recognize entire document')}</button>}</footer>
    </AppDialog>
    <div className="task-panel-body">
      {!!scanPages.length && <div className="panel-refresh-note" role="status">
        <p>{t('Text in images on {count} pages has not been recognized.', { count: scanPages.length })}</p>
        {onRequestOcr ? <button type="button" disabled={disabled} onClick={() => setAskOcr(true)}>{t('Recognize entire document')}</button>
          : <p>{t(document && !document.permissions.modify ? 'This document does not allow adding a searchable text layer.' : 'Open this PDF in the desktop app to recognize scanned text.')}</p>}
      </div>}
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
            const progress = pendingProgress.current; cancelProgress();
            setResult(previous => (progress ?? previous) && ({ ...(progress ?? previous)!, status: 'stopped' }));
          }}>{t('Stop search')}</button>}
        </div>
        <details><summary>{t('Search options')}</summary>
        <div className="panel-refresh-row">
          <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" checked={matchCase}
            disabled={!document || disabled || replacing} onChange={event => { setMatchCase(event.target.checked); invalidateSearch(); }} />{t('Match case')}</label>
          <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" checked={wholeWord} aria-describedby={wordHelpId}
            disabled={!document || disabled || replacing} onChange={event => { setWholeWord(event.target.checked); invalidateSearch(); }} />{t('Whole words')}</label>
        </div>
        <p id={wordHelpId} className="panel-refresh-muted">{t('Whole words use Unicode letter/number boundaries, not Chinese word segmentation.')}</p>
        </details>
      </form>
      <p role="status" id={statusId} aria-live="polite" aria-atomic="true">
        {searching ? t('Searching… {pages} / {total} pages · {count} matches', { pages: visible.scannedPages, total: document?.pageOrder.length ?? 0, count })
          : visible?.status === 'stopped' ? `${t('Search stopped')} · ${countLabel}`
          : visible?.status === 'failed' ? `${t('Search failed')} · ${countLabel}`
          : visible ? count ? countLabel : t('No matches found') : t('Enter text and press Enter to search.')}
      </p>
      {notice ? <p role="status" className="layout-result">{t(notice)}</p> : null}
      {!!count && <div className="pdf-search-results" aria-label={t('Search results')}>
        {visible?.matches.map((match, index) => <SearchResult key={`${match.pageId}:${match.blockId}:${match.range.start}:${match.range.end}:${index}`}
          match={match} selected={selected === match} disabled={!canNavigate} selectedButton={selectedButton} onLocate={locate} />)}
      </div>}
    </div>
    <footer className="task-panel-footer">
      {error ? <p role="alert">{t(error)}</p> : null}
      <div className="text-edit-actions">
        <button type="button" disabled={!canContinue} title={t('Previous match (Shift+Enter / Shift+F3)')}
          onClick={() => navigateOrSearch(-1)}>{t('Previous match')}</button>
        <button type="button" className="task-panel-primary" disabled={!canContinue} title={t('Next match (Enter / F3)')}
          onClick={() => navigateOrSearch(1)}>{t('Next match')}</button>
      </div>
      {onCommitted && document?.permissions.modify && document.capabilities.includes('text.replace') ? <>
        <label>{t('Replace with')}<input value={replacement} disabled={disabled || replacing} onChange={event => setReplacement(event.target.value)} /></label>
        {selected?.isOcr && <p className="task-help">{t('Replacing recognized text changes the searchable text layer, not the scanned image.')}</p>}
        {selected && !selected.replaceable && <p className="task-help">{t('This text can be searched but cannot be edited.')}</p>}
        <button type="button" disabled={!canNavigate || !selected?.replaceable} onClick={() => void replace()}>{t('Replace selected match')}</button>
      </> : null}
    </footer>
  </section>;
}
