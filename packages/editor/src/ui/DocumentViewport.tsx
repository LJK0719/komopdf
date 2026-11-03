import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { EngineAdapter, PageModel, TextAction } from '@pdf-editor/contracts';
import type { TextActionSelection } from './text-actions.js';
import type { LoadedDocument } from './EditorShell.js';
import { devicePixelRatio, matchesPageRender, renderPage, type PageGeometry } from './draw-render.js';
import { isRenderCancelled, renderWork } from './render-work.js';
import { PageRaster } from './PageRaster.js';
import { useI18n } from './i18n.js';
import { PdfTextLayer, type TextSelectionTarget, type ReadingAction } from './PdfTextLayer.js';
import { ObjectSelectionStartContext, type SelectionPointerStart } from './ObjectSelectionLayer.js';

export type PageView = 'single' | 'double';
export type PointerTool = 'hand' | 'select' | 'edit';
export type ViewportSize = { docId: string; pageId: string; view: PageView; widthPt: number; heightPt: number; columns: 1 | 2 };

type Props = {
  engine: EngineAdapter; document: LoadedDocument; zoom: number; pixelRatio?: number; renderPaused?: boolean;
  view: PageView; continuous: boolean; root: RefObject<HTMLElement | null>;
  locked: boolean; pointer: PointerTool;
  onActive(page: LoadedDocument): void;
  onHost(host: HTMLDivElement | null): void;
  onEditText(document: LoadedDocument, objectId: string, range: [number, number]): void;
  onInsertText(document: LoadedDocument, point: { x: number; y: number }): void;
  onAnnotate(document: LoadedDocument, targets: TextSelectionTarget[], action: ReadingAction): Promise<void>;
  onError(message: string): void;
  onTextAction?: ((selection: TextActionSelection, action: TextAction | 'ask') => void) | undefined;
  aiSelection?: TextActionSelection | null;
  onViewSize?(size: ViewportSize): void;
  drawing?: boolean;
  renderOverlay?(page: LoadedDocument, host: HTMLDivElement | null, geometry: PageGeometry): ReactNode;
  children(page: LoadedDocument, host: HTMLDivElement | null, geometry: PageGeometry): ReactNode;
};

export function DocumentViewport(props: Props) {
  const { document, root, continuous, view, locked } = props;
  const pixelRatio = props.pixelRatio ?? devicePixelRatio();
  const container = useRef<HTMLDivElement>(null);
  const loaded = useRef(new Map<string, LoadedDocument>());
  const visiblePages = useRef(new Map<string, HTMLDivElement>());
  useLayoutEffect(() => { loaded.current.clear(); visiblePages.current.clear(); }, [document.info.id]);
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
      stage.scrollLeft = 0;
      stage.scrollTop += active.getBoundingClientRect().top - stage.getBoundingClientRect().top - 24;
    }
  }, [document.info.id]);
  const latest = useRef({ ...props, pixelRatio }); latest.current = { ...props, pixelRatio };
  const frame = useRef(0);
  const trackPage = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const current = latest.current;
      if (current.locked || current.renderPaused || !root.current) return;
      const viewport = root.current.getBoundingClientRect();
      const middle = viewport.top + viewport.height * 0.4;
      let best: string | undefined;
      let distance = Infinity;
      for (const [id, node] of visiblePages.current) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
        if (current.pointer === 'edit' && id === current.document.page.id) return;
        const delta = middle < rect.top ? rect.top - middle : middle > rect.bottom ? middle - rect.bottom : 0;
        if (delta < distance || (delta === distance && id === current.document.page.id)) { best = id; distance = delta; }
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
    return () => { node?.removeEventListener('scroll', trackPage); cancelAnimationFrame(frame.current); frame.current = 0; };
  }, [root]);
  useEffect(() => { if (!locked && !props.renderPaused) trackPage(); }, [locked, props.renderPaused]);
  const index = document.info.pageOrder.indexOf(document.page.id);
  const start = view === 'double' ? index - index % 2 : index;
  const ids = continuous ? document.info.pageOrder : document.info.pageOrder.slice(start, start + (view === 'double' ? 2 : 1));
  useEffect(() => {
    if (!props.onViewSize) return;
    const controller = new AbortController();
    const report = (other?: PageModel) => {
      if (controller.signal.aborted) return;
      props.onViewSize?.({ docId: document.info.id, pageId: document.page.id, view,
        widthPt: document.page.widthPt + (other?.widthPt ?? 0),
        heightPt: Math.max(document.page.heightPt, other?.heightPt ?? 0), columns: other ? 2 : 1 });
    };
    const otherId = view === 'double' ? document.info.pageOrder.slice(start, start + 2).find(id => id !== document.page.id) : undefined;
    if (!otherId) report();
    else {
      const other = loaded.current.get(otherId)?.page;
      if (other) report(other);
      else void renderWork(props.engine, () => props.engine.describePage(document.info.id, otherId),
        { signal: controller.signal, priority: 'page' }).then(report).catch(() => undefined);
    }
    return () => controller.abort();
  }, [props.engine, props.onViewSize, document.info.id, document.info.revision, document.page.id, document.page.widthPt, document.page.heightPt, view, start]);
  return <div ref={container} className={`document-pages document-pages-${view}`}>
    {ids.map((id, position) => <PageSurface key={`${document.info.id}:${id}`} {...props} pixelRatio={pixelRatio} pageId={id}
      pageNumber={continuous ? position + 1 : start + position + 1}
      onReady={page => {
        const current = latest.current;
        if (page.info.id !== current.document.info.id
            || (page.pageVersion ?? page.render.revision) !== (current.engine.getPageVersion?.(page.info.id, id) ?? current.document.info.revision)) return;
        loaded.current.set(id, page); trackPage();
      }}
      onVisibility={host => { if (host) visiblePages.current.set(id, host); else visiblePages.current.delete(id); trackPage(); }}
      onRelease={() => { loaded.current.delete(id); visiblePages.current.delete(id); }} />)}
  </div>;
}

function PageSurface({ engine, document, zoom, pixelRatio = devicePixelRatio(), renderPaused = false, root, pageId, pageNumber,
  children, pointer, drawing, renderOverlay, onActive, onHost, locked, onReady, onRelease, onVisibility, onEditText, onInsertText,
  onAnnotate, onError, onTextAction, aiSelection }: Props & {
  pageId: string; pageNumber: number; onReady(page: LoadedDocument): void; onRelease(): void; onVisibility(host: HTMLDivElement | null): void;
}) {
  const { t } = useI18n();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const selectionStart = useRef<SelectionPointerStart | null>(null);
  const active = document.page.id === pageId;
  const [visible, setVisible] = useState(active);
  useEffect(() => { if (active) onHost(host); }, [active, host, onHost]);
  const [page, setPage] = useState<PageModel | null>(active ? document.page : null);
  const estimatedSize = useRef({ widthPt: document.page.widthPt, heightPt: document.page.heightPt });
  const [result, setResult] = useState<LoadedDocument | null>(null);
  const [error, setError] = useState('');
  const callbacks = useRef({ onReady, onRelease, onVisibility, onError }); callbacks.current = { onReady, onRelease, onVisibility, onError };
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
  useEffect(() => { callbacks.current.onVisibility(visible ? host : null); }, [visible, host]);
  useEffect(() => {
    if (!visible) { setResult(null); callbacks.current.onRelease(); return; }
    if (validActive) { setPage(document.page); callbacks.current.onReady(document); return; }
    if (active || renderPaused) return;
    if (result && (result.pageVersion ?? result.render.revision) === version && matchesPageRender(result.render, zoom, pixelRatio)) {
      callbacks.current.onReady(result); return;
    }
    const controller = new AbortController();
    const options = { signal: controller.signal, priority: 'page' as const };
    setError('');
    void (async () => {
      const model = result && (result.pageVersion ?? result.render.revision) === version ? result.page
        : await renderWork(engine, () => engine.describePage(document.info.id, pageId), options);
      if (controller.signal.aborted) return;
      setPage(model);
      const render = await renderPage(engine, document.info.id, model, zoom, document.info.revision, pixelRatio, options);
      if (controller.signal.aborted || version !== (engine.getPageVersion?.(document.info.id, pageId) ?? render.revision)) return;
      const next = { info: document.info, name: document.name, page: model, render, pageVersion: version };
      setResult(next); callbacks.current.onReady(next);
    })().catch(caught => {
      if (controller.signal.aborted || isRenderCancelled(caught)) return;
      const message = t('Unable to display this page.'); setError(message); callbacks.current.onError(message);
    });
    return () => controller.abort();
  }, [engine, document.info.id, version, pageId, zoom, pixelRatio, renderPaused, visible, active, validActive, validActive ? document.render : null]);
  const size = content?.page ?? page ?? estimatedSize.current;
  const geometry = { width: size.widthPt * zoom, height: size.heightPt * zoom };
  return <div ref={setHost} className="page-wrap" data-document-page={pageId} data-page-number={pageNumber}
    style={geometry}
    onPointerDownCapture={event => {
      if (!event.currentTarget.contains(event.target as Node) || active || !shown || locked) return;
      if (pointer === 'edit' && !drawing && event.button === 0) {
        const { pointerId, button, clientX, clientY, ctrlKey, metaKey, shiftKey, altKey } = event;
        selectionStart.current = { pointerId, button, clientX, clientY, ctrlKey, metaKey, shiftKey, altKey };
      }
      onActive(shown);
    }}
    onPointerUpCapture={() => { selectionStart.current = null; }}
    onPointerCancelCapture={() => { selectionStart.current = null; }}>
    {shown && visible ? <>
      <PageRaster key={version} engine={engine} docId={document.info.id} page={shown.page} render={shown.render} zoom={zoom} pixelRatio={pixelRatio}
        root={root} active={active} paused={renderPaused} label={t('Page {page}', { page: pageNumber })}
        onError={() => { const message = t('Unable to display this page.'); setError(message); callbacks.current.onError(message); }} />
      {!drawing && pointer === 'select' && document.info.permissions.copy && <PdfTextLayer document={shown} zoom={zoom} disabled={locked}
        onEdit={onEditText} onInsert={onInsertText} onAnnotate={onAnnotate} onError={onError}
        {...(onTextAction ? { onTextAction } : {})} aiSelection={aiSelection ?? null} />}
      {active && <ObjectSelectionStartContext.Provider value={selectionStart}>{children(shown, host, geometry)}</ObjectSelectionStartContext.Provider>}
      {renderOverlay?.(shown, host, geometry)}
    </> : <span className="page-placeholder">{error || t('Page {page}', { page: pageNumber })}</span>}
    <span className="page-caption" aria-hidden="true">{pageNumber}</span>
  </div>;
}
