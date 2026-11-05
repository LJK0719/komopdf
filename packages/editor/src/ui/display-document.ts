import { EngineError, type DocumentInfo, type DocumentSource, type EngineAdapter, type PageMetrics, type PageModel } from '@pdf-editor/contracts';
import { devicePixelRatio, pageRenderGeometry, renderPage, type PageRender } from './draw-render.js';
import { renderWork, type RenderWorkOptions } from './render-work.js';

export type LoadedDocument = {
  info: DocumentInfo;
  name: string;
  page: PageModel;
  render: PageRender;
  pageVersion?: number;
};

export type PageModelState =
  | { status: 'unloaded' }
  | { status: 'loading' }
  | { status: 'ready'; page: PageModel }
  | { status: 'error'; message: string };

/** Reading state never claims that an unrequested model is an empty page. */
export type DisplayDocument = {
  info: DocumentInfo;
  name: string;
  page: PageMetrics;
  render: PageRender;
  pageVersion: number;
  model: PageModelState;
};

export function pageMetrics(page: PageMetrics): PageMetrics {
  return { id: page.id, widthPt: page.widthPt, heightPt: page.heightPt, rotation: page.rotation };
}

export function displayDocument(document: DisplayDocument | LoadedDocument): DisplayDocument {
  if ('model' in document) return document;
  return { ...document, page: pageMetrics(document.page), pageVersion: document.pageVersion ?? document.render.revision,
    model: { status: 'ready', page: document.page } };
}

/** The single ready boundary used by the existing, non-nullable editing UI. */
export function loadedDocument(document: DisplayDocument | null | undefined): LoadedDocument | null {
  if (document?.model.status !== 'ready') return null;
  return { info: document.info, name: document.name, page: document.model.page, render: document.render, pageVersion: document.pageVersion };
}

export function releaseDisplayModel(document: DisplayDocument): DisplayDocument {
  return document.model.status === 'unloaded' ? document : { ...document, model: { status: 'unloaded' } };
}

export async function loadDisplayPage(
  engine: EngineAdapter, info: DocumentInfo, name: string, pageId: string, zoom = 1.25,
  renderPixels = true, pixelRatio = devicePixelRatio(), options: RenderWorkOptions = {},
): Promise<DisplayDocument> {
  const pageVersion = engine.getPageVersion?.(info.id, pageId) ?? info.revision;
  const page = await renderWork(engine, () => engine.describePageMetrics(info.id, pageId),
    { priority: 'active', ...options, key: `metrics:${JSON.stringify([info.id, pageId, pageVersion])}` });
  const render = renderPixels ? await renderPage(engine, info.id, page, zoom, info.revision, pixelRatio, options)
    : pageRenderGeometry(page, zoom, info.revision, pixelRatio);
  if (pageVersion !== (engine.getPageVersion?.(info.id, pageId) ?? render.revision)) {
    throw new EngineError('STALE_REVISION', 'Page changed while loading');
  }
  return { info, name, page: pageMetrics(page), render, pageVersion, model: { status: 'unloaded' } };
}

export async function openDisplayDocument(
  engine: EngineAdapter, source: DocumentSource, password?: string, onOpened?: () => void,
): Promise<DisplayDocument> {
  const info = await (password === undefined ? engine.open(source) : engine.open(source, password));
  try {
    onOpened?.();
    const pageId = info.pageOrder[0];
    if (!pageId) throw new EngineError('INVALID_REQUEST', 'Document has no displayable pages');
    return await loadDisplayPage(engine, info, source.name, pageId);
  } catch (error) {
    await engine.close(info.id).catch(() => undefined);
    throw error;
  }
}

/** Shared work promotes an already queued reading model when a gesture needs it. */
export async function ensureLoaded(
  engine: EngineAdapter, document: DisplayDocument, options: RenderWorkOptions = {},
): Promise<LoadedDocument> {
  const currentVersion = () => engine.getPageVersion?.(document.info.id, document.page.id) ?? document.info.revision;
  if (document.pageVersion !== currentVersion()) throw new EngineError('STALE_REVISION', 'Page changed while loading');
  options.signal?.throwIfAborted();
  const ready = loadedDocument(document);
  if (ready) return ready;
  const page = await renderWork(engine, () => engine.describePage(document.info.id, document.page.id),
    { priority: 'interaction', ...options, key: `model:${JSON.stringify([document.info.id, document.page.id, document.pageVersion])}` });
  if (document.pageVersion !== currentVersion()) throw new EngineError('STALE_REVISION', 'Page changed while loading');
  return { info: document.info, name: document.name, page, render: document.render, pageVersion: document.pageVersion };
}

export function selectionPageRange(order: readonly string[], anchorId: string, focusId: string): string[] {
  const anchor = order.indexOf(anchorId), focus = order.indexOf(focusId);
  return anchor < 0 || focus < 0 ? [] : order.slice(Math.min(anchor, focus), Math.max(anchor, focus) + 1);
}

/** Cancelable idle work; callers invoke this only after a real page paint. */
export function scheduleIdleWork(run: () => void): () => void {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(run, 120);
  return () => clearTimeout(id);
}
