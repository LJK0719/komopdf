import { useEffect, useRef, useState } from 'react';
import type { DocumentInfo, EngineAdapter } from '@pdf-editor/contracts';

type Match = {
  pageId: string; blockId: string; pageNumber: number; range: { start: number; end: number }; excerpt: string;
};
type SearchSnapshot = Pick<DocumentInfo, 'id' | 'revision' | 'pageOrder'>;
type SearchState = {
  docId: string; revision: number; engine: EngineAdapter;
  matches: Match[]; status: string; busy: boolean;
};
type Props = { document: DocumentInfo | null; engine: EngineAdapter; disabled: boolean;
  onLocate(pageId: string, blockId: string, range?: { start: number; end: number }): void };

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

export function PdfSearchPanel({ document, engine, disabled, onLocate }: Props) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchState | null>(null);
  const operation = useRef<AbortController | null>(null);
  const current = useRef({ docId: document?.id, revision: document?.revision, engine });
  current.current = { docId: document?.id, revision: document?.revision, engine };
  useEffect(() => {
    operation.current?.abort();
    operation.current = null;
    setResult(null);
    return () => operation.current?.abort();
  }, [document?.id, document?.revision, engine]);

  const visible = document && result?.docId === document.id && result.revision === document.revision
    && result.engine === engine ? result : null;

  async function search() {
    if (!document || !query.trim() || disabled) return;
    operation.current?.abort();
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
      if (belongsToCurrentDocument()) setResult(previous => previous && ({ ...previous,
        status: error instanceof Error ? error.message : 'Search failed', busy: false }));
    } finally {
      if (operation.current === controller) operation.current = null;
    }
  }

  return <section className="text-edit-panel" aria-label="Search PDF">
    <details><summary>Search PDF</summary>
      <form onSubmit={event => { event.preventDefault(); void search(); }}>
        <label>Find text<input value={query} disabled={!document || disabled} onChange={event => setQuery(event.target.value)} /></label>
        <button disabled={!document || disabled || !query.trim()} type="submit">Find</button>
        {visible?.busy && <button type="button" onClick={() => {
          operation.current?.abort(); operation.current = null;
          setResult(previous => previous && ({ ...previous, busy: false, status: 'Search stopped' }));
        }}>Stop search</button>}
      </form>
      {visible?.status && <p role="status">{visible.status}</p>}
      {visible?.matches.map(match => <button key={`${match.pageId}:${match.blockId}:${match.range.start}:${match.range.end}`}
        disabled={disabled} onClick={() => onLocate(match.pageId, match.blockId, match.range)}>
        Page {match.pageNumber}, character {match.range.start + 1}: {match.excerpt}
      </button>)}
    </details>
  </section>;
}
