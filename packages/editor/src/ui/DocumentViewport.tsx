import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { EngineAdapter, PageMetrics, TextAction } from '@pdf-editor/contracts';
import type { TextActionSelection } from './text-actions.js';
import { ensureLoaded, loadDisplayPage, loadedDocument, releaseDisplayModel, scheduleIdleWork, selectionPageRange, type DisplayDocument, type LoadedDocument } from './display-document.js';
import { clearPageBitmaps, devicePixelRatio, matchesPageRender, renderPage, type PageGeometry } from './draw-render.js';
import { isRenderCancelled, renderWork, type RenderWorkOptions } from './render-work.js';
import { PageRaster } from './PageRaster.js';
import { useI18n } from './i18n.js';
import { PdfTextLayer, type TextSelectionTarget, type ReadingAction } from './PdfTextLayer.js';
import { ObjectSelectionStartContext, selectionPointer, type SelectionPointerIntent } from './ObjectSelectionLayer.js';

export type PageView = 'single' | 'double';
export type PointerTool = 'hand' | 'select' | 'edit';
export type ViewportSize = { docId: string; pageId: string; view: PageView; widthPt: number; heightPt: number; columns: 1 | 2 };

type Props = {
  engine: EngineAdapter; document: DisplayDocument; zoom: number; pixelRatio?: number; renderPaused?: boolean;
  view: PageView; continuous: boolean; root: RefObject<HTMLElement | null>;
  locked: boolean; pointer: PointerTool;
  onActive(page: DisplayDocument): void;
  onUpdate(page: DisplayDocument): void;
  onReleasePage(pageId: string, version: number, releaseModel: boolean): void;
  onFirstPaint?(docId: string): void;
  retainedPageIds?: readonly string[];
  selectionEpoch?: number;
  onHost(host: HTMLDivElement | null): void;
  onEditText(document: LoadedDocument, objectId: string, range: [number, number]): void;
  onInsertText(document: LoadedDocument, point: { x: number; y: number }): void;
  onAnnotate(document: LoadedDocument, targets: TextSelectionTarget[], action: ReadingAction): Promise<void>;
  onError(message: string): void;
  onTextAction?: ((selection: TextActionSelection, action: TextAction | 'ask') => void) | undefined;
  aiSelection?: TextActionSelection | null;
  onViewSize?(size: ViewportSize): void;
  drawing?: boolean;
  renderDisplayOverlay?(page: DisplayDocument, host: HTMLDivElement | null, geometry: PageGeometry): ReactNode;
  renderOverlay?(page: LoadedDocument, host: HTMLDivElement | null, geometry: PageGeometry): ReactNode;
  children(page: LoadedDocument, host: HTMLDivElement | null, geometry: PageGeometry): ReactNode;
};
type ModelLoader = (options?: RenderWorkOptions) => Promise<LoadedDocument>;
const sameIds = (previous: string[], next: string[]) => previous.length === next.length && previous.every((id, index) => id === next[index]);
function selectionPage(node: Node | null): HTMLElement | null {
  return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-document-page]') ?? null;
}

export const DocumentViewport = memo(function DocumentViewport(props: Props) {
  const { document, root, continuous, view, locked } = props;
  const pixelRatio = props.pixelRatio ?? devicePixelRatio();
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<string, DisplayDocument>());
  const visiblePages = useRef(new Map<string, HTMLDivElement>());
  const modelLoaders = useRef(new Map<string, ModelLoader>());
  const [scrolling, setScrolling] = useState(false);
  const [selectionPages, setSelectionPages] = useState<string[]>([]);
  const [requestedPages, setRequestedPages] = useState<string[]>([]);
  const selectionEpoch = useRef(props.selectionEpoch);
  useLayoutEffect(() => {
    if (selectionEpoch.current === props.selectionEpoch) return;
    selectionEpoch.current = props.selectionEpoch;
    window.getSelection()?.removeAllRanges();
    setSelectionPages(previous => previous.length ? [] : previous);
    setRequestedPages(previous => previous.length ? [] : previous);
  }, [props.selectionEpoch]);
  const retained = useMemo(() => new Set([...(props.retainedPageIds ?? []), ...selectionPages, ...requestedPages]),
    [props.retainedPageIds, selectionPages, requestedPages]);
  const latest = useRef({ ...props, pixelRatio }); latest.current = { ...props, pixelRatio };
  const frame = useRef(0);
  const painted = useRef(false);
  useEffect(() => () => { clearPageBitmaps(props.engine, document.info.id); }, [props.engine, document.info.id]);
  useLayoutEffect(() => {
    const stage = root.current;
    const active = [...(container.current?.querySelectorAll<HTMLElement>('[data-document-page]') ?? [])]
      .find(node => node.dataset.documentPage === document.page.id);
    if (stage && active) {
      stage.scrollLeft = 0;
      stage.scrollTop += active.getBoundingClientRect().top - stage.getBoundingClientRect().top - 24;
    }
  }, [document.info.id]);
  const trackPage = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const current = latest.current;
      if (current.locked || current.renderPaused || !root.current) return;
      const viewport = root.current.getBoundingClientRect();
      const middle = viewport.top + viewport.height * 0.4;
      let best: string | undefined, distance = Infinity;
      for (const [id, node] of visiblePages.current) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
        // Explicit editing/drawing owns the active page until it leaves the viewport.
        if ((current.pointer === 'edit' || current.drawing) && id === current.document.page.id) return;
        const delta = middle < rect.top ? rect.top - middle : middle > rect.bottom ? middle - rect.bottom : 0;
        if (delta < distance || (delta === distance && id === current.document.page.id)) { best = id; distance = delta; }
      }
      const page = best && pages.current.get(best);
      if (page && page.page.id !== current.document.page.id
          && page.pageVersion === (current.engine.getPageVersion?.(page.info.id, page.page.id) ?? current.document.info.revision)) {
        current.onActive({ ...page, info: current.document.info, name: current.document.name });
      }
    });
  };
  useEffect(() => {
    const node = root.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scroll = () => {
      setScrolling(true); trackPage();
      clearTimeout(timer); timer = setTimeout(() => setScrolling(false), 120);
    };
    node?.addEventListener('scroll', scroll, { passive: true });
    return () => {
      node?.removeEventListener('scroll', scroll); clearTimeout(timer);
      cancelAnimationFrame(frame.current); frame.current = 0;
    };
  }, [root]);
  useEffect(() => { if (!locked && !props.renderPaused) trackPage(); }, [locked, props.renderPaused]);
  const rememberSelection = () => {
    const selection = window.getSelection();
    const anchor = selectionPage(selection?.anchorNode ?? null), focus = selectionPage(selection?.focusNode ?? null);
    const ids = selection && !selection.isCollapsed && selection.rangeCount > 0 && anchor && focus
      && container.current?.contains(anchor) && container.current.contains(focus)
      ? selectionPageRange(latest.current.document.info.pageOrder, anchor.dataset.documentPage!, focus.dataset.documentPage!) : [];
    setSelectionPages(previous => sameIds(previous, ids) ? previous : ids);
  };
  const selectionReader = useRef(rememberSelection); selectionReader.current = rememberSelection;
  useEffect(() => {
    const change = () => selectionReader.current();
    window.document.addEventListener('selectionchange', change);
    return () => window.document.removeEventListener('selectionchange', change);
  }, []);
  const requestTextPage = async (startId: string, pageId: string) => {
    const anchor = selectionPage(window.getSelection()?.anchorNode ?? null);
    const origin = anchor && container.current?.contains(anchor) ? anchor.dataset.documentPage! : startId;
    const ids = selectionPageRange(latest.current.document.info.pageOrder, origin, pageId);
    setRequestedPages(previous => sameIds(previous, ids) ? previous : ids);
    await Promise.all(ids.map(id => modelLoaders.current.get(id)?.({ priority: 'interaction' })));
  };
  const index = document.info.pageOrder.indexOf(document.page.id);
  const start = view === 'double' ? index - index % 2 : index;
  const windowIds = document.info.pageOrder.slice(start, start + (view === 'double' ? 2 : 1));
  const ids = continuous ? document.info.pageOrder : document.info.pageOrder.filter(id => windowIds.includes(id) || retained.has(id));
  useEffect(() => {
    if (!props.onViewSize) return;
    const controller = new AbortController();
    const report = (other?: PageMetrics) => {
      if (!controller.signal.aborted) props.onViewSize?.({ docId: document.info.id, pageId: document.page.id, view,
        widthPt: document.page.widthPt + (other?.widthPt ?? 0),
        heightPt: Math.max(document.page.heightPt, other?.heightPt ?? 0), columns: other ? 2 : 1 });
    };
    const otherId = view === 'double' ? windowIds.find(id => id !== document.page.id) : undefined;
    if (!otherId) report();
    else {
      const cached = pages.current.get(otherId);
      const other = cached?.pageVersion === (props.engine.getPageVersion?.(document.info.id, otherId) ?? document.info.revision) ? cached.page : undefined;
      if (other) report(other);
      else void renderWork(props.engine, () => props.engine.describePageMetrics(document.info.id, otherId),
        { signal: controller.signal, priority: 'page', key: `metrics:${JSON.stringify([document.info.id, otherId,
          props.engine.getPageVersion?.(document.info.id, otherId) ?? document.info.revision])}` }).then(report).catch(() => undefined);
    }
    return () => controller.abort();
  }, [props.engine, props.onViewSize, document.info.id, document.info.revision, document.page.id, document.page.widthPt, document.page.heightPt, view, start]);
  return <div ref={container} className={`document-pages document-pages-${view}`}>
    {ids.map(id => <PageSurface key={`${document.info.id}:${id}`} {...props} pixelRatio={pixelRatio} pageId={id}
      pageNumber={document.info.pageOrder.indexOf(id) + 1} quiet={!scrolling} retained={retained.has(id)}
      onReady={page => {
        const current = latest.current;
        if (page.info.id !== current.document.info.id
            || page.pageVersion !== (current.engine.getPageVersion?.(page.info.id, id) ?? current.document.info.revision)) return;
        const next = { ...page, info: current.document.info, name: current.document.name };
        pages.current.set(id, next);
        if (id === current.document.page.id) current.onUpdate(next);
        trackPage();
      }}
      onLoader={loader => { if (loader) modelLoaders.current.set(id, loader); else modelLoaders.current.delete(id); }}
      onRequestTextPage={pageId => requestTextPage(id, pageId)}
      onSelectionSettled={() => { selectionReader.current(); setRequestedPages(previous => previous.length ? [] : previous); }}
      onPaint={() => {
        const host = visiblePages.current.get(id), viewport = root.current?.getBoundingClientRect(), rect = host?.getBoundingClientRect();
        if (!painted.current && viewport && rect && rect.bottom > viewport.top && rect.top < viewport.bottom) {
          painted.current = true; latest.current.onFirstPaint?.(document.info.id);
        }
      }}
      onVisibility={host => { if (host) visiblePages.current.set(id, host); else visiblePages.current.delete(id); trackPage(); }}
      onRelease={releaseModel => { pages.current.delete(id); latest.current.onReleasePage(id,
        props.engine.getPageVersion?.(document.info.id, id) ?? document.info.revision, releaseModel); }} />)}
  </div>;
});

function PageSurface({ engine, document, zoom, pixelRatio = devicePixelRatio(), renderPaused = false, root, pageId, pageNumber,
  children, pointer, drawing, renderDisplayOverlay, renderOverlay, onActive, onHost, locked, quiet, retained, selectionEpoch, onReady, onRelease, onVisibility, onLoader,
  onRequestTextPage, onSelectionSettled, onPaint, onEditText, onInsertText, onAnnotate, onError, onTextAction, aiSelection }: Props & {
  pageId: string; pageNumber: number; quiet: boolean; retained: boolean;
  onReady(page: DisplayDocument): void; onRelease(releaseModel: boolean): void; onVisibility(host: HTMLDivElement | null): void;
  onLoader(loader: ModelLoader | null): void; onRequestTextPage(pageId: string): Promise<void>; onSelectionSettled(): void; onPaint(): void;
}) {
  const { t } = useI18n();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const active = document.page.id === pageId;
  const [visible, setVisible] = useState(active);
  const [surface, setSurface] = useState<DisplayDocument | null>(active ? document : null);
  const estimatedSize = useRef(document.page);
  const [paintedVersion, setPaintedVersion] = useState<number | null>(null);
  const paintFrame = useRef(0);
  const [error, setError] = useState('');
  const pending = useRef<SelectionPointerIntent | null>(null);
  const [pendingGesture, setPendingGesture] = useState(false);
  const [geometryGesture, setGeometryGesture] = useState(false);
  const geometryEndFrame = useRef(0);
  const stopTracking = useRef<() => void>(() => undefined);
  const gestureAbort = useRef(new AbortController());
  const keepModel = retained || pendingGesture || geometryGesture;
  const version = engine.getPageVersion?.(document.info.id, pageId) ?? document.info.revision;
  const validActive = active && document.pageVersion === version;
  const content = validActive ? document : surface?.pageVersion === version ? surface : null;
  const current = useRef(content); current.current = content;
  if (content) estimatedSize.current = content.page;
  const callbacks = useRef({ onReady, onRelease, onVisibility, onLoader, onError, onPaint });
  callbacks.current = { onReady, onRelease, onVisibility, onLoader, onError, onPaint };
  const source = useMemo(() => ({
    get current() { return pending.current; },
    set current(value: SelectionPointerIntent | null) { pending.current = value; },
    onConsumed() { stopTracking.current(); setPendingGesture(false); },
  }), []);
  const publish = (page: DisplayDocument) => { current.current = page; setSurface(page); callbacks.current.onReady(page); };
  const ensureModel = async (options: RenderWorkOptions = {}): Promise<LoadedDocument> => {
    const base = current.current ?? await loadDisplayPage(engine, document.info, document.name, pageId, zoom, false, pixelRatio, options);
    const ready = loadedDocument(base);
    if (ready) return ready;
    publish({ ...base, model: { status: 'loading' } });
    try {
      const loaded = await ensureLoaded(engine, base, options);
      const latest = current.current;
      const next = { ...base, info: latest?.info ?? base.info, name: latest?.name ?? base.name,
        render: latest?.render ?? base.render, model: { status: 'ready' as const, page: loaded.page } };
      publish(next);
      if (pending.current && !active) onActive(next);
      return loadedDocument(next)!;
    } catch (caught) {
      if (!isRenderCancelled(caught) && !options.signal?.aborted
          && base.pageVersion === (engine.getPageVersion?.(base.info.id, pageId) ?? current.current?.info.revision)) {
        const message = t('Unable to display this page.');
        publish({ ...(current.current ?? base), model: { status: 'error', message } }); callbacks.current.onError(message);
      }
      throw caught;
    }
  };
  const loader = useRef(ensureModel); loader.current = ensureModel;
  useLayoutEffect(() => {
    callbacks.current.onLoader(options => loader.current(options));
    return () => { callbacks.current.onLoader(null); callbacks.current.onRelease(true); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); gestureAbort.current = controller;
    return () => { controller.abort(); stopTracking.current(); cancelAnimationFrame(paintFrame.current); cancelAnimationFrame(geometryEndFrame.current); };
  }, []);
  useLayoutEffect(() => {
    if (pending.current) { pending.current = null; stopTracking.current(); setPendingGesture(false); }
  }, [version, pointer, selectionEpoch]);
  useLayoutEffect(() => {
    if (validActive) { current.current = document; setSurface(document); callbacks.current.onReady(document); }
  }, [validActive, validActive ? document.page : null, validActive ? document.render : null, validActive ? document.model : null]);
  useEffect(() => { if (active) onHost(host); }, [active, host, onHost]);
  useEffect(() => {
    if (!host) return;
    if (!('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false), { root: root.current, rootMargin: '350px 0px' });
    observer.observe(host); return () => observer.disconnect();
  }, [host, root]);
  useEffect(() => { callbacks.current.onVisibility(visible ? host : null); }, [visible, host]);
  useEffect(() => {
    if (visible) return;
    const previous = current.current;
    if (previous) {
      const next = { ...(keepModel ? previous : releaseDisplayModel(previous)), render: { ...previous.render, bitmap: null } };
      current.current = next; setSurface(next);
    }
    callbacks.current.onRelease(!keepModel);
  }, [visible, keepModel]);
  useEffect(() => {
    if ((!visible && !keepModel) || current.current || renderPaused) return;
    const controller = new AbortController();
    void loadDisplayPage(engine, document.info, document.name, pageId, zoom, false, pixelRatio,
      { signal: controller.signal, priority: active ? 'active' : 'page' }).then(page => {
      if (!controller.signal.aborted) { setError(''); publish(page); }
    }).catch(caught => {
      if (controller.signal.aborted || isRenderCancelled(caught)) return;
      const message = t('Unable to display this page.'); setError(message); callbacks.current.onError(message);
    });
    return () => controller.abort();
  }, [engine, document.info.id, version, pageId, visible, keepModel, active, renderPaused]);
  useEffect(() => {
    const page = current.current;
    if (!visible || renderPaused || !page || matchesPageRender(page.render, zoom, pixelRatio)) return;
    const controller = new AbortController();
    void renderPage(engine, document.info.id, page.page, zoom, document.info.revision, pixelRatio,
      { signal: controller.signal, priority: active ? 'active' : 'page', distance: Math.abs(document.info.pageOrder.indexOf(pageId) - document.info.pageOrder.indexOf(document.page.id)) }).then(render => {
      if (controller.signal.aborted || version !== (engine.getPageVersion?.(document.info.id, pageId) ?? render.revision)) return;
      publish({ ...(current.current ?? page), render });
    }).catch(caught => {
      if (!controller.signal.aborted && !isRenderCancelled(caught)) {
        const message = t('Unable to display this page.'); setError(message); callbacks.current.onError(message);
      }
    });
    return () => controller.abort();
  }, [engine, document.info.id, version, pageId, zoom, pixelRatio, renderPaused, visible, active, content?.page, content?.render]);
  useEffect(() => {
    const page = current.current;
    if (drawing || (!visible && !keepModel) || !page || page.model.status === 'ready' || page.model.status === 'error') return;
    const interaction = keepModel || (active && pointer === 'edit');
    if (!interaction && (!quiet || renderPaused || paintedVersion !== version)) return;
    const controller = new AbortController();
    const load = () => { void loader.current({ signal: controller.signal, priority: interaction ? 'interaction' : 'model' }).catch(() => undefined); };
    const cancelIdle = interaction ? (load(), () => undefined) : scheduleIdleWork(load);
    return () => { cancelIdle(); controller.abort(); };
  }, [engine, version, visible, keepModel, drawing, active, pointer, quiet, renderPaused, paintedVersion, content?.page]);
  const displayed = useMemo(() => content ? { ...content, info: document.info, name: document.name } : null,
    [content, document.info, document.name]);
  const shown = useMemo(() => loadedDocument(displayed), [displayed]);
  const size = content?.page ?? estimatedSize.current;
  const geometry = { width: size.widthPt * zoom, height: size.heightPt * zoom };
  return <div ref={setHost} className="page-wrap" data-document-page={pageId} data-page-number={pageNumber}
    data-model-state={content?.model.status ?? 'unloaded'} style={geometry}
    onPointerDownCapture={event => {
      if (!event.currentTarget.contains(event.target as Node) || locked) return;
      if (!active && content) onActive({ ...content, info: document.info, name: document.name });
      if (drawing && event.button === 0) { cancelAnimationFrame(geometryEndFrame.current); setGeometryGesture(true); return; }
      if (event.button !== 0 || pointer === 'hand' || (pointer === 'select' && !document.info.permissions.copy)) return;
      const layer = host?.querySelector(pointer === 'edit' ? '.selection-layer' : '.pdf-text-layer');
      if (layer && (pointer !== 'edit' || active)) return;
      event.preventDefault(); stopTracking.current();
      const intent: SelectionPointerIntent = { start: selectionPointer(event), latest: selectionPointer(event), ended: false, pageVersion: version, tool: pointer };
      pending.current = intent; setPendingGesture(true);
      const move = (event: PointerEvent) => { if (pending.current === intent && event.pointerId === intent.start.pointerId) intent.latest = selectionPointer(event); };
      const end = (event: PointerEvent) => {
        if (event.pointerId !== intent.start.pointerId) return;
        move(event); intent.ended = true; stopTracking.current();
      };
      const cancel = (event: PointerEvent) => {
        if (event.pointerId !== intent.start.pointerId) return;
        pending.current = null; setPendingGesture(false); stopTracking.current();
      };
      window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', end, true); window.addEventListener('pointercancel', cancel, true);
      stopTracking.current = () => {
        window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', cancel, true);
      };
      void loader.current({ priority: 'interaction', signal: gestureAbort.current.signal }).catch(() => { pending.current = null; setPendingGesture(false); stopTracking.current(); });
    }}
    onPointerUpCapture={() => {
      if (geometryGesture) geometryEndFrame.current = requestAnimationFrame(() => { geometryEndFrame.current = 0; setGeometryGesture(false); });
    }}
    onPointerCancelCapture={() => { setGeometryGesture(false); }}>
    {content && visible ? <PageRaster key={version} engine={engine} docId={document.info.id} page={content.page} render={content.render}
      zoom={zoom} pixelRatio={pixelRatio} root={root} active={active} paused={renderPaused} label={t('Page {page}', { page: pageNumber })}
      onPaint={() => {
        if (paintedVersion === version || paintFrame.current) return;
        paintFrame.current = requestAnimationFrame(() => {
          paintFrame.current = requestAnimationFrame(() => { paintFrame.current = 0; setPaintedVersion(version); callbacks.current.onPaint(); });
        });
      }}
      onError={() => { const message = t('Unable to display this page.'); setError(message); callbacks.current.onError(message); }} />
      : !content || visible ? <span className="page-placeholder">{error || t('Page {page}', { page: pageNumber })}</span> : null}
    <ObjectSelectionStartContext.Provider value={source}>
      {shown && (visible || keepModel) && <>
        {!drawing && pointer === 'select' && document.info.permissions.copy && <PdfTextLayer document={shown} zoom={zoom} disabled={locked}
          onEdit={onEditText} onInsert={onInsertText} onAnnotate={onAnnotate} onError={onError}
          onRequestPage={onRequestTextPage} onSelectionSettled={onSelectionSettled} selectionEpoch={selectionEpoch}
          {...(onTextAction ? { onTextAction } : {})} aiSelection={aiSelection ?? null} />}
        {active && children(shown, host, geometry)}
        {renderOverlay?.(shown, host, geometry)}
      </>}
      {displayed && (visible || keepModel) && renderDisplayOverlay?.(displayed, host, geometry)}
    </ObjectSelectionStartContext.Provider>
    <span className="page-caption" aria-hidden="true">{pageNumber}</span>
  </div>;
}
