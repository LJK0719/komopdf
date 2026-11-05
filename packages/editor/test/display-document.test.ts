import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentInfo, EngineAdapter, PageMetrics, PageModel, RenderResult } from '@pdf-editor/contracts';
import { displayDocument, ensureLoaded, loadDisplayPage, loadedDocument, openDisplayDocument, releaseDisplayModel,
  scheduleIdleWork, selectionPageRange, type DisplayDocument } from '../src/ui/display-document.js';
import { pageRenderGeometry } from '../src/ui/draw-render.js';
import { setRenderWorkPaused } from '../src/ui/render-work.js';
import { DocumentViewport } from '../src/ui/DocumentViewport.js';
import { useDocumentSessions } from '../src/ui/use-document-sessions.js';

const info: DocumentInfo = { id: 'doc', revision: 12, savedRevision: 10, sourceIds: ['source'], pageOrder: ['p1', 'p2', 'p3', 'p4'],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false }, capabilities: [] };
const metrics: PageMetrics = { id: 'p1', widthPt: 400, heightPt: 600, rotation: 0 };
const model: PageModel = { ...metrics, objects: [{ id: 'object', pageId: 'p1', type: 'path',
  bounds: { x: 10, y: 20, width: 40, height: 60 }, transform: [1, 0, 0, 1, 0, 0],
  locator: { pageId: 'p1', containerPath: [], objectIndex: 0 } }] };
const bitmap: RenderResult = { width: 2, height: 2, stride: 8, format: 'rgba', pixels: new ArrayBuffer(16), revision: info.revision };
const view = (): DisplayDocument => ({ info, name: 'reading.pdf', page: metrics, pageVersion: 3,
  render: pageRenderGeometry(metrics, 1.25, info.revision, 1), model: { status: 'unloaded' } });
function mockEngine() {
  return { open: vi.fn(async () => info), close: vi.fn(async () => {}), getPageVersion: vi.fn(() => 3),
    describePageMetrics: vi.fn(async (_docId: string, pageId: string) => ({ ...metrics, id: pageId })),
    describePage: vi.fn(async () => model), render: vi.fn(async () => bitmap) } as unknown as EngineAdapter;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('display document readiness', () => {
  it('opens the first bitmap using only geometry even when a complete model is unavailable', async () => {
    const engine = mockEngine();
    vi.mocked(engine.describePage).mockRejectedValue(new Error('model unavailable'));
    const shown = await openDisplayDocument(engine, { kind: 'bytes', sourceId: 'source', name: 'reading.pdf', bytes: new ArrayBuffer(4) });
    expect(engine.describePageMetrics).toHaveBeenCalledExactlyOnceWith(info.id, 'p1');
    expect(engine.render).toHaveBeenCalledOnce();
    expect(engine.describePage).not.toHaveBeenCalled();
    expect(shown.model.status).toBe('unloaded');
    expect(shown.page).not.toHaveProperty('objects');
    expect(shown.pageVersion).toBe(3);
    expect(shown.render.bitmap).toBe(bitmap);
    expect(loadedDocument(shown)).toBeNull();
    expect(engine.close).not.toHaveBeenCalled();
  });

  it('can navigate and size a page without rasterizing it or requesting objects', async () => {
    const engine = mockEngine();
    const shown = await loadDisplayPage(engine, info, 'reading.pdf', 'p3', 2, false, 2, { priority: 'interaction' });
    expect(shown.page).toEqual({ ...metrics, id: 'p3' });
    expect(shown.render).toMatchObject({ width: 800, height: 1200, zoom: 2, pixelRatio: 2, bitmap: null });
    expect(engine.describePage).not.toHaveBeenCalled();
    expect(engine.render).not.toHaveBeenCalled();
  });

  it('projects the real ready model once an editing or selection intent asks for it', async () => {
    const engine = mockEngine(), shown = view();
    const loaded = await ensureLoaded(engine, shown);
    expect(loaded.page).toBe(model);
    expect(loaded.page.objects).toHaveLength(1);
    expect(loaded.pageVersion).toBe(3);
    expect(loaded.info.revision).toBe(12);
    const ready = displayDocument(loaded);
    expect(ready.page).not.toHaveProperty('objects');
    expect(loadedDocument(ready)?.page).toBe(model);
    expect((await ensureLoaded(engine, ready)).page).toBe(model);
    expect(engine.describePage).toHaveBeenCalledOnce();
    expect(shown.model.status).toBe('unloaded');
  });

  it('waits for a new committed revision before locating an inserted paragraph for editing', async () => {
    const engine = mockEngine();
    vi.mocked(engine.getPageVersion!).mockReturnValue(4);
    const committed: DisplayDocument = { ...view(), info: { ...info, revision: 13 }, pageVersion: 4, model: { status: 'loading' } };
    const object = model.objects[0]!;
    const inserted: PageModel = { ...model, objects: [...model.objects, { ...object, id: 'new-paragraph', type: 'text', textBlock: {
      id: 'new-block', pageId: 'p1', sourceObjectIds: ['insert-command-id'], bounds: object.bounds, transform: object.transform, editability: 'direct',
      runs: [{ text: 'New text', sourceObjectIds: ['insert-command-id'], style: { fontId: 'font', fontSize: 14, color: [0, 0, 0] } }],
    } }] };
    let complete!: (page: PageModel) => void;
    vi.mocked(engine.describePage).mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const pending = ensureLoaded(engine, committed, { priority: 'interaction' });
    expect(loadedDocument(committed)).toBeNull();
    complete(inserted);
    const ready = await pending;
    const target = ready.page.objects.find(item => item.id === 'insert-command-id' || item.textBlock?.sourceObjectIds.includes('insert-command-id'));
    expect(ready.info.revision).toBe(13);
    expect(ready.pageVersion).toBe(4);
    expect(target?.id).toBe('new-paragraph');
    expect(target?.textBlock?.runs[0]?.text).toBe('New text');
    expect(engine.describePage).toHaveBeenCalledExactlyOnceWith(info.id, 'p1');
  });

  it('promotes a queued background model for interaction and shares the same request', async () => {
    const engine = mockEngine(), owner = {};
    setRenderWorkPaused(engine, owner, true);
    try {
      const background = ensureLoaded(engine, view(), { priority: 'model' });
      const interaction = ensureLoaded(engine, view(), { priority: 'interaction' });
      const pages = await Promise.all([background, interaction]);
      expect(pages.every(page => page.page === model)).toBe(true);
      expect(engine.describePage).toHaveBeenCalledOnce();
    } finally { setRenderWorkPaused(engine, owner, false); }
  });

  it('does not publish a stale or failed model as an empty ready page', async () => {
    const engine = mockEngine(), shown = view();
    let version = 3;
    vi.mocked(engine.getPageVersion!).mockImplementation(() => version);
    vi.mocked(engine.describePage).mockImplementation(async () => { version++; return model; });
    await expect(ensureLoaded(engine, shown)).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(loadedDocument(shown)).toBeNull();
    expect(shown.model.status).toBe('unloaded');
    expect(engine.close).not.toHaveBeenCalled();
  });

  it('releases objects without losing geometry, the real revision, or an existing raster', () => {
    const ready = displayDocument({ info, name: 'reading.pdf', page: model,
      pageVersion: 3, render: { ...view().render, bitmap } });
    const released = releaseDisplayModel(ready);
    expect(released.model.status).toBe('unloaded');
    expect(released.page).not.toHaveProperty('objects');
    expect(released.page).toBe(ready.page);
    expect(released.info).toBe(info);
    expect(released.render.bitmap).toBe(bitmap);
  });
});

describe('reading session and text retention', () => {
  it('keeps navigation, page identity, selection IDs and save confirmation available before model readiness', () => {
    let sessions!: ReturnType<typeof useDocumentSessions>;
    function Capture() { sessions = useDocumentSessions(); return null; }
    renderToStaticMarkup(createElement(Capture));
    sessions.add(view());
    sessions.setSelectedIds(['remembered']);
    sessions.setDocument({ ...view(), page: { ...metrics, id: 'p2' }, model: { status: 'loading' } });
    sessions.save(info.id, 11, { status: 'written', name: 'saved.pdf' });
    const saved = sessions.documentRef.current!;
    expect(saved.page.id).toBe('p2');
    expect(saved.info.revision).toBe(12);
    expect(saved.info.savedRevision).toBe(11);
    expect(saved.name).toBe('saved.pdf');
    expect(saved.model.status).toBe('loading');
    expect(sessions.current.current.documents.get(info.id)?.selectedIds).toEqual(['remembered']);
    expect(loadedDocument(saved)).toBeNull();
  });

  it('retains every page between anchor and focus, including backwards selections', () => {
    expect(selectionPageRange(info.pageOrder, 'p1', 'p4')).toEqual(info.pageOrder);
    expect(selectionPageRange(info.pageOrder, 'p4', 'p2')).toEqual(['p2', 'p3', 'p4']);
    expect(selectionPageRange(info.pageOrder, 'missing', 'p2')).toEqual([]);
  });

  it('renders geometry/raster and geometric tools without mounting a fake text or object model', () => {
    const engine = mockEngine(), editLayers = vi.fn(() => null), geometryLayer = vi.fn(() => createElement('div', { className: 'geometry-tool' }));
    const markup = renderToStaticMarkup(createElement(DocumentViewport, { engine, document: view(), zoom: 1.25, pixelRatio: 1,
      view: 'single', continuous: false, root: { current: null }, locked: false, pointer: 'select',
      onActive: vi.fn(), onUpdate: vi.fn(), onReleasePage: vi.fn(), onHost: vi.fn(), onEditText: vi.fn(), onInsertText: vi.fn(),
      onAnnotate: vi.fn(async () => {}), onError: vi.fn(), renderDisplayOverlay: geometryLayer, children: editLayers }));
    expect(markup).toContain('data-model-state="unloaded"');
    expect(markup).toContain('class="pdf-canvas"');
    expect(markup).toContain('class="geometry-tool"');
    expect(markup).not.toContain('pdf-text-layer');
    expect(editLayers).not.toHaveBeenCalled();
    expect(engine.describePage).not.toHaveBeenCalled();
  });
});

describe('first-paint idle scheduling', () => {
  it('defers and can cancel the initial recovery work rather than running it when scheduled', () => {
    let idle: (() => void) | undefined;
    const cancel = vi.fn();
    vi.stubGlobal('window', { requestIdleCallback: vi.fn((run: () => void) => { idle = run; return 8; }), cancelIdleCallback: cancel });
    const work = vi.fn();
    const dispose = scheduleIdleWork(work);
    expect(work).not.toHaveBeenCalled();
    idle?.();
    expect(work).toHaveBeenCalledOnce();
    dispose(); expect(cancel).toHaveBeenCalledExactlyOnceWith(8);
  });
});
