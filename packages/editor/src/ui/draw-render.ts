import { WEB_LIMITS, type EngineAdapter, type PageModel, type Rect, type RenderResult } from '@pdf-editor/contracts';
import { isRenderCancelled, renderWork, type RenderPriority, type RenderWorkOptions } from './render-work.js';

const TILE_SIZE = 512;

export type PageRender = {
  width: number; height: number; zoom: number; pixelRatio: number; revision: number;
  mode: 'full' | 'tiles'; bitmap: RenderResult | null;
};
export type PageGeometry = Pick<PageRender, 'width' | 'height'>;

export function devicePixelRatio(): number {
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export function pageRenderGeometry(page: PageModel, zoom: number, revision: number, pixelRatio = devicePixelRatio()): PageRender {
  const width = page.widthPt * zoom, height = page.heightPt * zoom;
  const physicalWidth = Math.ceil(page.widthPt * (zoom * pixelRatio));
  const physicalHeight = Math.ceil(page.heightPt * (zoom * pixelRatio));
  const full = physicalWidth * physicalHeight <= WEB_LIMITS.renderPixels && physicalWidth <= 8192 && physicalHeight <= 8192;
  return { width, height, zoom, pixelRatio, revision, mode: full ? 'full' : 'tiles', bitmap: null };
}

export function matchesPageRender(render: PageRender, zoom: number, pixelRatio: number): boolean {
  return render.zoom === zoom && render.pixelRatio === pixelRatio && (render.mode === 'tiles' || render.bitmap !== null);
}

export async function renderPage(engine: EngineAdapter, docId: string, page: PageModel, zoom: number, revision: number,
  pixelRatio = devicePixelRatio(), options: RenderWorkOptions = {}): Promise<PageRender> {
  const render = pageRenderGeometry(page, zoom, revision, pixelRatio);
  if (render.mode === 'full') {
    render.bitmap = await renderWork(engine, () => engine.render({ docId, pageId: page.id, scale: zoom * pixelRatio }), options);
    render.revision = render.bitmap.revision;
  }
  return render;
}

export function tileClip(page: PageModel, scale: number, column: number, row: number): Rect {
  const left = Math.max(0, column * TILE_SIZE - 1);
  const top = Math.max(0, row * TILE_SIZE - 1);
  const right = Math.min(page.widthPt, ((column + 1) * TILE_SIZE + 1) / scale);
  const bottom = Math.min(page.heightPt, ((row + 1) * TILE_SIZE + 1) / scale);
  return { x: left / scale, y: top / scale, width: right - left / scale, height: bottom - top / scale };
}

type TileMount = (() => void) & { setPaused(paused: boolean): void };
type TileOptions = { paused?: boolean; priority?(): RenderPriority; onReady?(): void };

export function mountVisiblePageTiles(
  layer: HTMLElement,
  stage: HTMLElement,
  engine: EngineAdapter,
  docId: string,
  page: PageModel,
  render: PageRender,
  onError: (error: unknown) => void,
  options: TileOptions = {},
): TileMount {
  const version = engine.getPageVersion?.(docId, page.id) ?? render.revision;
  const scale = render.zoom * render.pixelRatio;
  const physicalWidth = Math.ceil(page.widthPt * scale), physicalHeight = Math.ceil(page.heightPt * scale);
  const tiles = new Map<string, HTMLCanvasElement>();
  let frame = 0;
  let disposed = false, failed = false, running = false, ready = false;
  let paused = options.paused ?? false;
  let pending: AbortController | null = null;
  const isCurrent = () => !disposed && !failed && version === (engine.getPageVersion?.(docId, page.id) ?? version);
  const release = (canvas: HTMLCanvasElement) => { canvas.width = 0; canvas.height = 0; canvas.remove(); };
  const reportReady = () => {
    if (!ready && tiles.size && [...tiles.values()].every(canvas => canvas.width > 0)) { ready = true; options.onReady?.(); }
  };
  const drawNext = () => {
    if (!isCurrent() || paused || running) return;
    const next = [...tiles].find(([, canvas]) => canvas.width === 0);
    if (!next) { reportReady(); return; }
    const [key, canvas] = next;
    const [column, row] = key.split(',').map(Number);
    const clip = tileClip(page, scale, column!, row!);
    const controller = new AbortController();
    pending = controller; running = true;
    const finish = () => { pending = null; running = false; drawNext(); };
    const fail = (error: unknown) => {
      if (isRenderCancelled(error) || !isCurrent() || tiles.get(key) !== canvas) return;
      failed = true; tiles.delete(key); release(canvas); onError(error);
    };
    void renderWork(engine, () => engine.render({ docId, pageId: page.id, scale, clip }),
      { signal: controller.signal, priority: options.priority?.() ?? 'active' }).then(bitmap => {
      try {
        if (!isCurrent() || tiles.get(key) !== canvas) return;
        if (version !== (engine.getPageVersion?.(docId, page.id) ?? bitmap.revision)) { failed = true; return; }
        canvas.style.left = `${Math.floor(clip.x * scale) / render.pixelRatio}px`;
        canvas.style.top = `${Math.floor(clip.y * scale) / render.pixelRatio}px`;
        drawRender(canvas, bitmap, { width: bitmap.width / render.pixelRatio, height: bitmap.height / render.pixelRatio });
        reportReady();
      } catch (error) { fail(error); }
      finally { finish(); }
    }, error => { try { fail(error); } finally { finish(); } });
  };

  const update = () => {
    frame = 0;
    if (!isCurrent() || paused) return;
    const bounds = layer.getBoundingClientRect();
    const viewport = stage.getBoundingClientRect();
    const displayScale = (bounds.right - bounds.left) / (page.widthPt * render.zoom);
    if (!(displayScale > 0)) return;
    const density = render.pixelRatio / displayScale;
    const left = Math.max(0, Math.floor((viewport.left - bounds.left) * density));
    const top = Math.max(0, Math.floor((viewport.top - bounds.top) * density));
    const right = Math.min(physicalWidth, Math.ceil((viewport.right - bounds.left) * density));
    const bottom = Math.min(physicalHeight, Math.ceil((viewport.bottom - bounds.top) * density));
    const visible: { column: number; row: number; distance: number }[] = [];
    if (right > left && bottom > top) {
      for (let row = Math.floor(top / TILE_SIZE); row < Math.ceil(bottom / TILE_SIZE); row++) {
        for (let column = Math.floor(left / TILE_SIZE); column < Math.ceil(right / TILE_SIZE); column++) {
          const distance = Math.abs((column + 0.5) * TILE_SIZE - (left + right) / 2)
            + Math.abs((row + 0.5) * TILE_SIZE - (top + bottom) / 2);
          visible.push({ column, row, distance });
        }
      }
    }
    visible.sort((a, b) => a.distance - b.distance);
    const wanted = new Set(visible.map(tile => `${tile.column},${tile.row}`));
    for (const [key, canvas] of tiles) {
      if (wanted.has(key)) continue;
      tiles.delete(key); release(canvas);
    }
    const ordered = new Map<string, HTMLCanvasElement>();
    for (const tile of visible) {
      const key = `${tile.column},${tile.row}`;
      let canvas = tiles.get(key);
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = 0; canvas.height = 0;
        canvas.className = 'pdf-tile'; canvas.setAttribute('aria-hidden', 'true');
        layer.append(canvas);
      }
      ordered.set(key, canvas);
    }
    tiles.clear();
    for (const [key, canvas] of ordered) tiles.set(key, canvas);
    drawNext();
  };
  const schedule = () => { if (!disposed && !paused && !frame) frame = requestAnimationFrame(update); };
  stage.addEventListener('scroll', schedule, { passive: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(stage); resize.observe(layer);
  update();
  const dispose = () => {
    disposed = true; pending?.abort();
    if (frame) cancelAnimationFrame(frame);
    stage.removeEventListener('scroll', schedule); resize.disconnect();
    for (const canvas of tiles.values()) release(canvas);
    tiles.clear();
  };
  return Object.assign(dispose, { setPaused(value: boolean) {
    if (paused === value) return;
    paused = value;
    if (paused) pending?.abort(); else update();
  } });
}

/** Native responses can share a buffer with their metadata prefix. */
export function rgbaPixels(render: RenderResult): Uint8ClampedArray<ArrayBuffer> {
  const offset = render.byteOffset ?? 0;
  const rowBytes = render.width * 4;
  if (render.stride === rowBytes) return new Uint8ClampedArray(render.pixels, offset);
  const pixels = new Uint8ClampedArray(rowBytes * render.height);
  const source = new Uint8Array(render.pixels, offset);
  for (let row = 0; row < render.height; row++) {
    pixels.set(source.subarray(row * render.stride, row * render.stride + rowBytes), row * rowBytes);
  }
  return pixels;
}

export function drawRender(canvas: HTMLCanvasElement | null, render: RenderResult, display?: PageGeometry): void {
  if (!canvas) return;
  canvas.width = render.width; canvas.height = render.height;
  if (display) { canvas.style.width = `${display.width}px`; canvas.style.height = `${display.height}px`; }
  const context = canvas.getContext('2d');
  if (context) context.putImageData(new ImageData(rgbaPixels(render), render.width, render.height), 0, 0);
}
