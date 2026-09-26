import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { EngineAdapter, PageModel } from '@pdf-editor/contracts';
import type { LoadedDocument } from './EditorShell.js';
import { drawRender, mountVisiblePageTiles, renderPage } from './draw-render.js';
import { useI18n } from './i18n.js';
import { PdfTextLayer, type TextSelectionTarget, type ReadingAction } from './PdfTextLayer.js';

export type PageView = 'single' | 'double';
export type PointerTool = 'hand' | 'select' | 'edit';

type Props = {
  engine: EngineAdapter; document: LoadedDocument; zoom: number;
  view: PageView; continuous: boolean; root: RefObject<HTMLElement | null>;
  locked: boolean; pointer: PointerTool;
  onActive(page: LoadedDocument): void;
  onHost(host: HTMLDivElement | null): void;
  onEditText(document: LoadedDocument, objectId: string, range: [number, number]): void;
  onInsertText(document: LoadedDocument, point: { x: number; y: number }): void;
  onAnnotate(document: LoadedDocument, targets: TextSelectionTarget[], action: ReadingAction): Promise<void>;
  onError(message: string): void;
  children(page: LoadedDocument, host: HTMLDivElement | null): ReactNode;
};

export function DocumentViewport(props: Props) {
  const { document, root, continuous, view, locked, onActive } = props;
  const container = useRef<HTMLDivElement>(null);
  const loaded = useRef(new Map<string, LoadedDocument>());
  useLayoutEffect(() => { loaded.current.clear(); }, [document.info.id, document.info.revision, props.zoom]);
  const latest = useRef(props); latest.current = props;
  const frame = useRef(0);
  const trackPage = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const current = latest.current;
      if (current.locked || !root.current || !container.current) return;
      const viewport = root.current.getBoundingClientRect();
      const middle = viewport.top + viewport.height * 0.4;
      let best: string | undefined;
      let distance = Infinity;
      for (const node of container.current.querySelectorAll<HTMLElement>('[data-document-page]')) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
        const delta = middle < rect.top ? rect.top - middle : middle > rect.bottom ? middle - rect.bottom : 0;
        // Keep the active page when both facing pages occupy the same row.
        if (delta < distance || (delta === distance && node.dataset.documentPage === current.document.page.id)) {
          best = node.dataset.documentPage; distance = delta;
        }
      }
      const page = best && loaded.current.get(best);
      if (page && page.info.revision === current.document.info.revision && page.page.id !== current.document.page.id) current.onActive(page);
    });
  };
  useEffect(() => {
    const node = root.current;
    node?.addEventListener('scroll', trackPage, { passive: true });
    return () => { node?.removeEventListener('scroll', trackPage); cancelAnimationFrame(frame.current); };
  }, [root]);
  useEffect(() => { if (!locked) trackPage(); }, [locked]);
  const index = document.info.pageOrder.indexOf(document.page.id);
  const start = view === 'double' ? index - index % 2 : index;
  const ids = continuous ? document.info.pageOrder : document.info.pageOrder.slice(start, start + (view === 'double' ? 2 : 1));
  return <div ref={container} className={`document-pages document-pages-${view}`}>
    {ids.map((id, position) => <PageSurface key={id} {...props} pageId={id}
      pageNumber={continuous ? position + 1 : start + position + 1}
      onReady={page => { loaded.current.set(id, page); trackPage(); }}
      onRelease={() => loaded.current.delete(id)} />)}
  </div>;
}

function PageSurface({ engine, document, zoom, root, pageId, pageNumber, children, pointer, onActive, onHost, locked, onReady, onRelease, onEditText, onInsertText, onAnnotate, onError }: Props & {
  pageId: string; pageNumber: number; onReady(page: LoadedDocument): void; onRelease(): void;
}) {
  const { t } = useI18n();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tiles = useRef<HTMLDivElement>(null);
  const active = document.page.id === pageId;
  const [visible, setVisible] = useState(active);
  useEffect(() => { if (active) onHost(host); }, [active, host, onHost]);
  const [page, setPage] = useState<PageModel | null>(active ? document.page : null);
  const estimatedSize = useRef({ widthPt: document.page.widthPt, heightPt: document.page.heightPt });
  const [result, setResult] = useState<LoadedDocument | null>(null);
  const [error, setError] = useState('');
  const callbacks = useRef({ onReady, onRelease }); callbacks.current = { onReady, onRelease };
  useEffect(() => () => callbacks.current.onRelease(), []);
  const validActive = active && document.render.revision === document.info.revision;
  const shown = validActive ? document : result?.info.revision === document.info.revision ? result : null;
  useEffect(() => {
    if (!host) return;
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false), { root: root.current, rootMargin: '350px 0px' });
    observer.observe(host); return () => observer.disconnect();
  }, [host, root]);
  useEffect(() => {
    if (validActive) { setPage(document.page); callbacks.current.onReady(document); return; }
    if (!visible) { setResult(null); callbacks.current.onRelease(); return; }
    let cancelled = false;
    setError('');
    void (async () => {
      const model = await engine.describePage(document.info.id, pageId);
      if (cancelled) return;
      setPage(model);
      const render = await renderPage(engine, document.info.id, model, zoom, document.info.revision);
      if (cancelled) return;
      const next = { info: document.info, name: document.name, page: model, render };
      setResult(next); callbacks.current.onReady(next);
    })().catch(() => { if (!cancelled) setError(t('Unable to display this page.')); });
    return () => { cancelled = true; };
  }, [engine, document.info.id, document.info.revision, pageId, zoom, visible, validActive, validActive ? document.render : null]);
  useEffect(() => {
    if (!shown || !visible) return;
    if (shown.render.pixels.byteLength) { drawRender(canvas.current, shown.render); return; }
    if (tiles.current && root.current) return mountVisiblePageTiles(tiles.current, root.current, engine,
      document.info.id, shown.page, zoom, shown.render, () => setError(t('Unable to display this page.')), () => undefined);
  }, [shown?.render, visible, engine, zoom, root]);
  const size = page ?? estimatedSize.current;
  return <div ref={setHost} className="page-wrap" data-document-page={pageId} data-page-number={pageNumber}
    style={{ width: Math.ceil(size.widthPt * zoom), height: Math.ceil(size.heightPt * zoom) }}
    onPointerDownCapture={() => { if (!active && shown && !locked) onActive(shown); }}>
    {shown && visible ? <>
      {shown.render.pixels.byteLength ? <canvas ref={canvas} className="pdf-canvas" aria-label={t('Page {page}', { page: pageNumber })} />
        : <div ref={tiles} className="pdf-tile-layer" role="img" aria-label={t('Page {page}', { page: pageNumber })} />}
      {pointer === 'select' && document.info.permissions.copy && <PdfTextLayer document={shown} zoom={zoom} disabled={locked}
        onEdit={onEditText} onInsert={onInsertText} onAnnotate={onAnnotate} onError={onError} />}
      {active && children(shown, host)}
    </> : <span className="page-placeholder">{error || t('Page {page}', { page: pageNumber })}</span>}
    <span className="page-caption" aria-hidden="true">{pageNumber}</span>
  </div>;
}
