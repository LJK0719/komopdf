import { WEB_LIMITS, type EngineAdapter, type PageModel, type Rect, type RenderResult } from '@pdf-editor/contracts';

const TILE_SIZE = 512;
// At most ~59 MiB of visible canvas pixels; an inactive tab can retain a <=32 MiB full render.
const MAX_VISIBLE_TILES = 56;

export async function renderPage(engine: EngineAdapter, docId: string, page: PageModel, scale: number, revision: number): Promise<RenderResult> {
  const width = Math.ceil(page.widthPt * scale);
  const height = Math.ceil(page.heightPt * scale);
  if (width * height <= WEB_LIMITS.renderPixels && width <= 8192 && height <= 8192) {
    return engine.render({ docId, pageId: page.id, scale });
  }
  // RenderResult carries full-page dimensions for the selection and inline-edit layers,
  // but no full-page bitmap is allocated. Pixels live only in visible tile canvases.
  return { width, height, stride: width * 4, format: 'rgba', pixels: new ArrayBuffer(0), revision };
}

export function tileClip(page: PageModel, scale: number, column: number, row: number): Rect {
  const left = Math.max(0, column * TILE_SIZE - 1);
  const top = Math.max(0, row * TILE_SIZE - 1);
  const right = Math.min(page.widthPt, ((column + 1) * TILE_SIZE + 1) / scale);
  const bottom = Math.min(page.heightPt, ((row + 1) * TILE_SIZE + 1) / scale);
  return { x: left / scale, y: top / scale, width: right - left / scale, height: bottom - top / scale };
}

export function mountVisiblePageTiles(
  layer: HTMLElement,
  stage: HTMLElement,
  engine: EngineAdapter,
  docId: string,
  page: PageModel,
  scale: number,
  render: RenderResult,
  onError: (error: unknown) => void,
  onViewportLimitChange: (limited: boolean) => void,
): () => void {
  const tiles = new Map<string, HTMLCanvasElement>();
  let frame = 0;
  let rendering = false;
  let disposed = false;
  let viewportLimited = false;

  const drawNext = () => {
    if (disposed || rendering) return;
    const pending = [...tiles].find(([, canvas]) => canvas.width === 0);
    if (!pending) return;
    const [key, canvas] = pending;
    const [column, row] = key.split(',').map(Number);
    const clip = tileClip(page, scale, column!, row!);
    rendering = true;
    void engine.render({ docId, pageId: page.id, scale, clip }).then(bitmap => {
      if (disposed || tiles.get(key) !== canvas) return;
      if (bitmap.revision !== render.revision) throw new Error('Page changed while rendering a tile');
      canvas.style.left = `${Math.floor(clip.x * scale)}px`;
      canvas.style.top = `${Math.floor(clip.y * scale)}px`;
      drawRender(canvas, bitmap);
    }).catch(error => {
      if (disposed || tiles.get(key) !== canvas) return;
      tiles.delete(key);
      canvas.remove();
      onError(error);
    }).finally(() => { rendering = false; drawNext(); });
  };

  const update = () => {
    frame = 0;
    if (disposed) return;
    const bounds = layer.getBoundingClientRect();
    const viewport = stage.getBoundingClientRect();
    const left = Math.max(0, Math.floor(viewport.left - bounds.left));
    const top = Math.max(0, Math.floor(viewport.top - bounds.top));
    const right = Math.min(render.width, Math.ceil(viewport.right - bounds.left));
    const bottom = Math.min(render.height, Math.ceil(viewport.bottom - bounds.top));
    const visible: { column: number; row: number; distance: number }[] = [];
    for (let row = Math.floor(top / TILE_SIZE); row < Math.ceil(bottom / TILE_SIZE); row++) {
      for (let column = Math.floor(left / TILE_SIZE); column < Math.ceil(right / TILE_SIZE); column++) {
        const distance = Math.abs((column + 0.5) * TILE_SIZE - (left + right) / 2)
          + Math.abs((row + 0.5) * TILE_SIZE - (top + bottom) / 2);
        visible.push({ column, row, distance });
      }
    }
    visible.sort((a, b) => a.distance - b.distance);
    const limited = visible.length > MAX_VISIBLE_TILES;
    if (limited !== viewportLimited) {
      viewportLimited = limited;
      onViewportLimitChange(limited);
    }
    const wanted = new Set(visible.slice(0, MAX_VISIBLE_TILES).map(tile => `${tile.column},${tile.row}`));
    for (const [key, canvas] of tiles) {
      if (wanted.has(key)) continue;
      tiles.delete(key);
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }
    for (const tile of visible.slice(0, MAX_VISIBLE_TILES)) {
      const key = `${tile.column},${tile.row}`;
      if (tiles.has(key)) continue;
      const canvas = document.createElement('canvas');
      canvas.width = 0;
      canvas.height = 0;
      canvas.className = 'pdf-tile';
      canvas.setAttribute('aria-hidden', 'true');
      layer.append(canvas);
      tiles.set(key, canvas);
    }
    drawNext();
  };
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(update); };
  stage.addEventListener('scroll', schedule, { passive: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(stage);
  update();
  return () => {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    stage.removeEventListener('scroll', schedule);
    resize.disconnect();
    for (const canvas of tiles.values()) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
    tiles.clear();
  };
}


export function drawRender(canvas: HTMLCanvasElement | null, render: RenderResult): void {
  if (!canvas) return;
  canvas.width = render.width;
  canvas.height = render.height;
  const context = canvas.getContext('2d');
  if (!context) return;

  const rowBytes = render.width * 4;
  let pixels: Uint8ClampedArray<ArrayBuffer>;
  if (render.stride === rowBytes) {
    pixels = new Uint8ClampedArray(render.pixels);
  } else {
    pixels = new Uint8ClampedArray(rowBytes * render.height);
    const source = new Uint8Array(render.pixels);
    for (let row = 0; row < render.height; row += 1) {
      pixels.set(source.subarray(row * render.stride, row * render.stride + rowBytes), row * rowBytes);
    }
  }
  context.putImageData(new ImageData(pixels, render.width, render.height), 0, 0);
}
