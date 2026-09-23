import { useEffect, useRef, useState } from 'react';
import type { DocumentInfo, EngineAdapter } from '@pdf-editor/contracts';

type Match = { pageId: string; blockId: string; pageNumber: number; excerpt: string };
type Props = { document: DocumentInfo | null; engine: EngineAdapter; disabled: boolean;
  onLocate(pageId: string, blockId: string): void };

export function PdfSearchPanel({ document, engine, disabled, onLocate }: Props) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    operation.current?.abort(); setMatches([]); setStatus(''); setBusy(false);
    return () => operation.current?.abort();
  }, [document?.id, document?.revision, engine]);

  async function search() {
    if (!document || !query.trim() || disabled) return;
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    const snapshot = document, needle = query.toLocaleLowerCase();
    const found: Match[] = [];
    setMatches([]); setBusy(true); setStatus('Searching locally…');
    try {
      for (let index = 0; index < snapshot.pageOrder.length; index++) {
        if (controller.signal.aborted) return;
        const pageId = snapshot.pageOrder[index]!;
        const blocks = await engine.extract({ docId: snapshot.id, pageIds: [pageId] });
        if (controller.signal.aborted) return;
        for (const block of blocks) {
          const text = block.runs.map(run => run.text).join('');
          const offset = text.toLocaleLowerCase().indexOf(needle);
          if (offset < 0) continue;
          found.push({ pageId, blockId: block.id, pageNumber: index + 1,
            excerpt: text.slice(Math.max(0, offset - 35), offset + needle.length + 65) });
          if (found.length === 100) break;
        }
        setMatches([...found]);
        setStatus(`Searched ${index + 1} / ${snapshot.pageOrder.length} pages`);
        if (found.length === 100) { setStatus('First 100 matching text blocks; refine your search for more'); return; }
      }
      setStatus(`${found.length} matching text block${found.length === 1 ? '' : 's'}`);
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Search failed');
    } finally {
      if (operation.current === controller) setBusy(false);
    }
  }
  return <section className="text-edit-panel" aria-label="Search PDF">
    <details><summary>Search PDF</summary>
      <form onSubmit={event => { event.preventDefault(); void search(); }}>
        <label>Find text<input value={query} disabled={!document || disabled} onChange={event => setQuery(event.target.value)} /></label>
        <button disabled={!document || disabled || !query.trim()} type="submit">Find</button>
        {busy && <button type="button" onClick={() => { operation.current?.abort(); setBusy(false); setStatus('Search stopped'); }}>Stop search</button>}
      </form>
      {status && <p role="status">{status}</p>}
      {matches.map(match => <button key={`${match.pageId}:${match.blockId}`} disabled={disabled}
        onClick={() => onLocate(match.pageId, match.blockId)}>Page {match.pageNumber}: {match.excerpt}</button>)}
    </details>
  </section>;
}
