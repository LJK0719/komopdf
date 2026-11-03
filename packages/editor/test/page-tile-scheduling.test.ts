import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, PageModel, RenderRequest, RenderResult } from '@pdf-editor/contracts';
import { mountVisiblePageTiles, pageRenderGeometry } from '../src/ui/draw-render.js';
import { renderWork } from '../src/ui/render-work.js';

const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); });
const page: PageModel = { id: 'page', widthPt: 10000, heightPt: 10000, rotation: 0, objects: [] };
class Canvas {
  width = 0; height = 0; draws = 0; className = '';
  style: Record<string, string> = {};
  owner: Layer | null = null;
  setAttribute() {}
  getContext() { return { putImageData: () => { this.draws++; } }; }
  remove() { if (this.owner) this.owner.children = this.owner.children.filter(child => child !== this); }
}
class Layer {
  children: Canvas[] = [];
  top = 0;
  append(canvas: Canvas) { canvas.owner = this; this.children.push(canvas); }
  getBoundingClientRect() { return { left: 0, top: this.top, right: 10000, bottom: 10000 + this.top }; }
}
function bitmap(request: RenderRequest): RenderResult {
  const clip = request.clip!;
  const width = Math.ceil((clip.x + clip.width) * request.scale) - Math.floor(clip.x * request.scale);
  const height = Math.ceil((clip.y + clip.height) * request.scale) - Math.floor(clip.y * request.scale);
  // These tests exercise geometry/scheduling; browser tests verify the actual pixel data.
  return { width, height, stride: width * 4, format: 'rgba', pixels: new ArrayBuffer(4), revision: 3 };
}
function setup(width = 500, height = 300) {
  const layer = new Layer();
  const stage = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height }) });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('document', { createElement: () => new Canvas() });
  vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  const render = vi.fn(async (request: RenderRequest) => bitmap(request));
  const version = { value: 3 };
  const onError = vi.fn();
  const engine = { render, getPageVersion: () => version.value } as unknown as EngineAdapter;
  const mount = (ratio: number) => {
    const dispose = mountVisiblePageTiles(layer as unknown as HTMLElement, stage as unknown as HTMLElement,
      engine, 'doc', page, pageRenderGeometry(page, 1, 3, ratio), onError);
    disposals.push(dispose);
    return dispose;
  };
  const scroll = () => {
    stage.dispatchEvent(new Event('scroll'));
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0));
  };
  return { layer, render, mount, scroll, version, onError, engine };
}

describe('visible physical-pixel tiles', () => {
  it('queues the next active tile before yielding the engine to pending thumbnails', async () => {
    const { render, mount, engine } = setup(1024, 512);
    const order: string[] = [];
    let resolve!: (value: RenderResult) => void;
    render.mockImplementation(async request => { order.push('tile'); return bitmap(request); });
    render.mockImplementationOnce(() => { order.push('tile'); return new Promise<RenderResult>(done => { resolve = done; }); });
    mount(1); await Promise.resolve();
    const background = renderWork(engine, async () => { order.push('thumbnail'); }, { priority: 'thumbnail' });
    resolve(bitmap(render.mock.calls[0]![0]));
    await background;
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(order).toEqual(['tile', 'tile', 'thumbnail']);
  });

  it('ignores failures from an obsolete page version without scheduling more stale work', async () => {
    const { render, mount, version, onError } = setup();
    let reject!: (error: Error) => void;
    const pending = new Promise<RenderResult>((_resolve, fail) => { reject = fail; });
    render.mockImplementationOnce(() => pending);
    mount(1); await Promise.resolve();
    version.value = 4;
    reject(new Error('obsolete tile'));
    await pending.catch(() => undefined); await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a current render failure instead of leaving a silent blank tile', async () => {
    const { render, mount, layer, onError } = setup();
    const failure = new Error('renderer unavailable');
    render.mockRejectedValueOnce(failure);
    mount(1);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(render).toHaveBeenCalledTimes(1);
    expect(layer.children).toHaveLength(0);
  });

  it('renders the whole viewport even when it needs more than 56 tiles', async () => {
    const { layer, render, mount } = setup(4096, 2048);
    const dispose = mount(2);
    await vi.waitFor(() => {
      expect(layer.children).toHaveLength(128);
      expect(layer.children.every(canvas => canvas.width > 0)).toBe(true);
    });
    expect(render).toHaveBeenCalledTimes(128);
    for (const canvas of layer.children) {
      expect(canvas.width / Number.parseFloat(canvas.style.width!)).toBe(2);
      expect(canvas.height / Number.parseFloat(canvas.style.height!)).toBe(2);
    }
    const canvases = [...layer.children]; dispose();
    expect(layer.children).toHaveLength(0);
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it('keeps one render in flight across density changes and ignores the old bitmap', async () => {
    const { layer, render, mount } = setup();
    let resolve!: (value: RenderResult) => void;
    render.mockImplementationOnce(() => new Promise<RenderResult>(done => { resolve = done; }));
    const old = mount(1); await Promise.resolve(); const stale = [...layer.children]; old();
    mount(2);
    expect(render).toHaveBeenCalledTimes(1);
    resolve(bitmap(render.mock.calls[0]![0]));
    await vi.waitFor(() => expect(layer.children.every(canvas => canvas.width > 0)).toBe(true));
    expect(render).toHaveBeenCalledTimes(5);
    expect(stale.every(canvas => canvas.draws === 0 && canvas.width === 0)).toBe(true);
    expect(layer.children.every(canvas => canvas.width / Number.parseFloat(canvas.style.width!) === 2)).toBe(true);
  });

  it('drops a scrolled-away tile before continuing with the latest visible region', async () => {
    const { layer, render, mount, scroll } = setup();
    let resolve!: (value: RenderResult) => void;
    render.mockImplementationOnce(() => new Promise<RenderResult>(done => { resolve = done; }));
    mount(1); await Promise.resolve(); const stale = [...layer.children];
    layer.top = -1800; scroll();
    expect(render).toHaveBeenCalledTimes(1);
    resolve(bitmap(render.mock.calls[0]![0]));
    await vi.waitFor(() => expect(layer.children.every(canvas => canvas.width > 0)).toBe(true));
    expect(render.mock.calls[1]![0].clip!.y).toBeGreaterThan(1000);
    expect(stale.every(canvas => canvas.draws === 0 && canvas.width === 0)).toBe(true);
  });
});
