import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { EngineAdapter, PageModel } from '@pdf-editor/contracts';
import type { LoadedDocument } from './EditorShell.js';
import { drawRender, mountVisiblePageTiles, renderPage } from './draw-render.js';
import { useI18n } from './i18n.js';
import { PdfTextLayer, type TextSelectionTarget, type ReadingAction } from './PdfTextLayer.js';
import { ObjectSelectionStartContext, type SelectionPointerStart } from './ObjectSelectionLayer.js';

export type PageView = 'single' | 'double';
export type PointerTool = 'hand' | 'select' | 'edit';
export type ViewportSize = { docId: string; pageId: string; view: PageView; widthPt: number; heightPt: number; columns: 1 | 2 };

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
  onViewSize?(size: ViewportSize): void;
  drawing?: boolean;
  renderOverlay?(page: LoadedDocument, host: HTMLDivElement | null): ReactNode;
  children(page: LoadedDocument, host: HTMLDivElement | null): ReactNode;
};

export function DocumentViewport(props: Props) {
  const { document, root, continuous, view, locked, onActive } = props;
  const container = useRef<HTMLDivElement>(null);
  const loaded = useRef(new Map<string, LoadedDocument>());
  useLayoutEffect(() => { loaded.current.clear(); }, [document.info.id, props.zoom]);
  useLayoutEffect(() => {
    const retained = new Set(document.info.pageOrder);
    for (const [id, page] of loaded.current) {
      const version = props.engine.getPageVersion?.(document.info.id, id) ?? document.info.revision;
      if (!retained.has(id) || (page.pageVersion ?? page.render.revision) !== version) loaded.current.delete(id);
    }
  }, [document.info, props.engine]);
  useLayoutEffect(() => {
    const stage = root.current;
    const active = [...(container.current?.querySelectorAll<HTMLElement>('[data-document-page]') ?? [])]
      .find(node => node.dataset.documentPage === document.page.id);
    if (stage && active) {
      // Do not let the previous document's scroll offset select a different page.
      stage.scrollLeft = 0;
      stage.scrollTop += active.getBoundingClientRect().top - stage.getBoundingClientRect().top - 24;
    }
  }, [document.info.id]);
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
        // A toolbar/layout change must not move a still-visible editing target.
        if (current.pointer === 'edit' && node.dataset.documentPage === current.document.page.id) return;
        const delta = middle < rect.top ? rect.top - middle : middle > rect.bottom ? middle - rect.bottom : 0;
        // Keep the active page when both facing pages occupy the same row.
        if (delta < distance || (delta === distance && node.dataset.documentPage === current.document.page.id)) {
          best = node.dataset.documentPage; distance = delta;
        }
      }
      const page = best && loaded.current.get(best);
      if (page && page.page.id !== current.document.page.id
          && (page.pageVersion ?? page.render.revision) === (current.engine.getPageVersion?.(current.document.info.id, page.page.id) ?? current.document.info.revision)) {
        current.onActive({ ...page, info: current.document.info, name: current.document.name });
      }
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
  useEffect(() => {
    if (!props.onViewSize) return;
    let cancelled = false;
    const report = (other?: PageModel) => {
      if (cancelled) return;
      props.onViewSize?.({ docId: document.info.id, pageId: document.page.id, view,
        widthPt: document.page.widthPt + (other?.widthPt ?? 0),
        heightPt: Math.max(document.page.heightPt, other?.heightPt ?? 0), columns: other ? 2 : 1 });
    };
    const otherId = view === 'double' ? document.info.pageOrder.slice(start, start + 2).find(id => id !== document.page.id) : undefined;
    if (!otherId) report();
    else {
      const other = loaded.current.get(otherId)?.page;
      if (other) report(other);
      else void props.engine.describePage(document.info.id, otherId).then(report).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [props.engine, props.onViewSize, document.info.id, document.info.revision, document.page.id, document.page.widthPt, document.page.heightPt, view, start]);
  return <div ref={container} className={`document-pages document-pages-${view}`}>
    {ids.map((id, position) => <PageSurface key={`${document.info.id}:${id}`} {...props} pageId={id}
      pageNumber={continuous ? position + 1 : start + position + 1}
      onReady={page => { loaded.current.set(id, page); trackPage(); }}
      onRelease={() => loaded.current.delete(id)} />)}
  </div>;
}

function PageSurface({ engine, document, zoom, root, pageId, pageNumber, children, pointer, drawing, renderOverlay, onActive, onHost, locked, onReady, onRelease, onEditText, onInsertText, onAnnotate, onError }: Props & {
  pageId: string; pageNumber: number; onReady(page: LoadedDocument): void; onRelease(): void;
}) {
  const { t } = useI18n();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tiles = useRef<HTMLDivElement>(null);
  const selectionStart = useRef<SelectionPointerStart | null>(null);
  const active = document.page.id === pageId;
  const [visible, setVisible] = useState(active);
  useEffect(() => { if (active) onHost(host); }, [active, host, onHost]);
  const [page, setPage] = useState<PageModel | null>(active ? document.page : null);
  const estimatedSize = useRef({ widthPt: document.page.widthPt, heightPt: document.page.heightPt });
  const [result, setResult] = useState<LoadedDocument | null>(null);
  const [error, setError] = useState('');
  const callbacks = useRef({ onReady, onRelease }); callbacks.current = { onReady, onRelease };
  useEffect(() => () => callbacks.current.onRelease(), []);
  const version = engine.getPageVersion?.(document.info.id, pageId) ?? document.info.revision;
  const validActive = active && (document.pageVersion ?? document.render.revision) === version;
  const content = validActive ? document : result && (result.pageVersion ?? result.render.revision) === version ? result : null;
  const shown = useMemo(() => content ? { ...content, info: document.info, name: document.name } : null,
    [content, document.info, document.name]);
  useEffect(() => {
    if (!host) return;
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false), { root: root.current, rootMargin: '350px 0px' });
    observer.observe(host); return () => observer.disconnect();
  }, [host, root]);
  useEffect(() => {
    if (validActive) { setPage(document.page); callbacks.current.onReady(document); return; }
    // EditorShell owns the active page refresh; do not race it after a commit.
    if (active) return;
    if (!visible) { setResult(null); callbacks.current.onRelease(); return; }
    if (result && (result.pageVersion ?? result.render.revision) === version
        && result.render.width === Math.ceil(result.page.widthPt * zoom)
        && result.render.height === Math.ceil(result.page.heightPt * zoom)) {
      callbacks.current.onReady(result); return;
    }
    let cancelled = false;
    setError('');
    void (async () => {
      const model = await engine.describePage(document.info.id, pageId);
      if (cancelled) return;
      setPage(model);
      const render = await renderPage(engine, document.info.id, model, zoom, document.info.revision);
      if (cancelled || version !== (engine.getPageVersion?.(document.info.id, pageId) ?? render.revision)) return;
      const next = { info: document.info, name: document.name, page: model, render, pageVersion: version };
      setResult(next); callbacks.current.onReady(next);
    })().catch(() => { if (!cancelled) setError(t('Unable to display this page.')); });
    return () => { cancelled = true; };
  }, [engine, document.info.id, version, pageId, zoom, visible, active, validActive, validActive ? document.render : null]);
  useEffect(() => {
    if (!shown || !visible) return;
    if (shown.render.pixels.byteLength) { drawRender(canvas.current, shown.render); return; }
    if (tiles.current && root.current) return mountVisiblePageTiles(tiles.current, root.current, engine,
      document.info.id, shown.page, zoom, shown.render, () => setError(t('Unable to display this page.')), () => undefined);
  }, [shown?.render, visible, engine, zoom, root]);
  const size = page ?? estimatedSize.current;
  return <div ref={setHost} className="page-wrap" data-document-page={pageId} data-page-number={pageNumber}
    style={{ width: Math.ceil(size.widthPt * zoom), height: Math.ceil(size.heightPt * zoom) }}
    onPointerDownCapture={event => {
      if (active || !shown || locked) return;
      if (pointer === 'edit' && !drawing && event.button === 0) {
        const { pointerId, button, clientX, clientY, ctrlKey, metaKey, shiftKey, altKey } = event;
        selectionStart.current = { pointerId, button, clientX, clientY, ctrlKey, metaKey, shiftKey, altKey };
      }
      onActive(shown);
    }}
    onPointerUpCapture={() => { selectionStart.current = null; }}
    onPointerCancelCapture={() => { selectionStart.current = null; }}>
    {shown && visible ? <>
      {shown.render.pixels.byteLength ? <canvas ref={canvas} className="pdf-canvas" aria-label={t('Page {page}', { page: pageNumber })} />
        : <div ref={tiles} className="pdf-tile-layer" role="img" aria-label={t('Page {page}', { page: pageNumber })} />}
      {!drawing && pointer === 'select' && document.info.permissions.copy && <PdfTextLayer document={shown} zoom={zoom} disabled={locked}
        onEdit={onEditText} onInsert={onInsertText} onAnnotate={onAnnotate} onError={onError} />}
      {active && <ObjectSelectionStartContext.Provider value={selectionStart}>{children(shown, host)}</ObjectSelectionStartContext.Provider>}
      {renderOverlay?.(shown, host)}
    </> : <span className="page-placeholder">{error || t('Page {page}', { page: pageNumber })}</span>}
    <span className="page-caption" aria-hidden="true">{pageNumber}</span>
  </div>;
}
