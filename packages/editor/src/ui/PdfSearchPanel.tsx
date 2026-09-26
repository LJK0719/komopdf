import { translate as t, useI18n } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { CommitResult, DocumentInfo, EngineAdapter } from '@pdf-editor/contracts';
import { CommandRegistry } from '@pdf-editor/commands';

type Match = {
  pageId: string; blockId: string; pageNumber: number; range: { start: number; end: number }; excerpt: string;
};
type SearchSnapshot = Pick<DocumentInfo, 'id' | 'revision' | 'pageOrder'>;
type SearchState = {
  docId: string; revision: number; engine: EngineAdapter;
  matches: Match[]; status: string; busy: boolean;
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
): Promise<Match[]> {
  const found: Match[] = [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  for (let index = 0; index < snapshot.pageOrder.length; index++) {
    if (signal.aborted) break;
    const pageId = snapshot.pageOrder[index]!;
    const blocks = await engine.extract({ docId: snapshot.id, pageIds: [pageId] });
    if (signal.aborted) break;
    for (const block of blocks) {
      const text = block.runs.map(run => run.text).join('');
      for (const hit of text.matchAll(pattern)) {
        const start = hit.index;
        const end = start + hit[0].length;
        found.push({ pageId, blockId: block.id, pageNumber: index + 1, range: { start, end },
          excerpt: text.slice(Math.max(0, start - 35), end + 65) });
      }
    }
    onProgress([...found], index + 1);
  }
  return found;
}

export function PdfSearchPanel({ document, engine, disabled, onLocate, onCommitted, onBusyChange }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [selected, setSelected] = useState<Match | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SearchState | null>(null);
  const operation = useRef<AbortController | null>(null);
  const current = useRef({ docId: document?.id, revision: document?.revision, engine });
  current.current = { docId: document?.id, revision: document?.revision, engine };
  useEffect(() => {
    operation.current?.abort();
    operation.current = null;
    setResult(null); setSelected(null);
    return () => operation.current?.abort();
  }, [document?.id, document?.revision, engine]);

  const visible = document && result?.docId === document.id && result.revision === document.revision
    && result.engine === engine ? result : null;

  async function search() {
    if (!document || !query.trim() || disabled) return;
    operation.current?.abort(); setError(''); setSelected(null);
    const controller = new AbortController();
    operation.current = controller;
    const snapshot: SearchSnapshot = { id: document.id, revision: document.revision, pageOrder: [...document.pageOrder] };
    const belongsToCurrentDocument = () => !controller.signal.aborted && operation.current === controller
      && current.current.docId === snapshot.id && current.current.revision === snapshot.revision
      && current.current.engine === engine;
    setResult({ docId: snapshot.id, revision: snapshot.revision, engine,
      matches: [], status: 'Searching locally…', busy: true });
    try {
      const matches = await searchPdfDocument(engine, snapshot, query.trim(), controller.signal, (found, scannedPages) => {
        if (belongsToCurrentDocument()) setResult({ docId: snapshot.id, revision: snapshot.revision, engine,
          matches: found, status: `Searched ${scannedPages} / ${snapshot.pageOrder.length} pages · ${found.length} matches`, busy: true });
      });
      if (belongsToCurrentDocument()) setResult({ docId: snapshot.id, revision: snapshot.revision, engine,
        matches, status: `${matches.length} match${matches.length === 1 ? '' : 'es'}`, busy: false });
    } catch (error) {
      if (belongsToCurrentDocument()) setError(error instanceof Error ? error.message : t('Search failed'));
      if (belongsToCurrentDocument()) setResult(previous => previous && ({ ...previous,
        status: error instanceof Error ? error.message : 'Search failed', busy: false }));
    } finally {
      if (operation.current === controller) operation.current = null;
    }
  }

  async function replace() {
    if (!document || !selected || !onCommitted || disabled || replacing || !visible) return;
    setReplacing(true); onBusyChange?.(true); setError('');
    try {
      const page = await engine.describePage(document.id, selected.pageId);
      const range: [number, number] = [selected.range.start, selected.range.end];
      const layout = await engine.previewText({ docId: document.id, pageId: page.id, blockId: selected.blockId, range, text: replacement });
      if (layout.overflow) throw new Error(t('Text does not fit. Shorten it or use a smaller font size.'));
      const result = await new CommandRegistry(engine).execute({ id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual',
        commands: [{ type: 'text.replace', pageId: page.id, blockId: selected.blockId, range, text: replacement }] }, { document, pages: new Map([[page.id, page]]) });
      await onCommitted(result);
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('Replace failed')); }
    finally { setReplacing(false); onBusyChange?.(false); }
  }

  return <section className="text-edit-panel" aria-label={t("Find in document")}>
    <details open><summary>{t("Find in document")}</summary>
      <form onSubmit={event => { event.preventDefault(); void search(); }}>
        <label>{t("Find text")}<input value={query} disabled={!document || disabled} onChange={event => setQuery(event.target.value)} /></label>
        <button disabled={!document || disabled || !query.trim()} type="submit">{t("Find")}</button>
        {visible?.busy && <button type="button" onClick={() => {
          operation.current?.abort(); operation.current = null;
          setResult(previous => previous && ({ ...previous, busy: false, status: 'Search stopped' }));
        }}>{t("Stop search")}</button>}
      </form>
      {onCommitted && document?.permissions.modify && document.capabilities.includes('text.replace') && <>
        <label>{t('Replace with')}<input value={replacement} disabled={disabled || replacing} onChange={event => setReplacement(event.target.value)} /></label>
        <button type="button" disabled={disabled || replacing || !selected || !visible} onClick={() => void replace()}>{t('Replace selected match')}</button>
      </>}
      {visible?.status && <p role="status">{visible.busy ? t('Searching locally…') : t('{count} matches', { count: visible.matches.length })}</p>}
      {error && <p role="alert">{t(error)}</p>}
      {visible?.matches.map(match => <button key={`${match.pageId}:${match.blockId}:${match.range.start}:${match.range.end}`}
        aria-pressed={selected === match} disabled={disabled || replacing} onClick={() => { setSelected(match); onLocate(match.pageId, match.blockId, match.range); }}>{t('Page {page}', { page: match.pageNumber })}: {match.excerpt}
      </button>)}
    </details>
  </section>;
}
