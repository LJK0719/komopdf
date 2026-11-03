export const MIN_VIEW_ZOOM = 0.25;
export const MAX_VIEW_ZOOM = 4;

export type ViewZoomMode = 'manual' | 'fit-width' | 'fit-page';
export type ViewZoomSize = { widthPt: number; heightPt: number; columns?: 1 | 2 };
export type ViewZoomViewport = { width: number; height: number; paddingX: number; paddingY: number; columnGap: number };

export function clampViewZoom(zoom: number): number {
  return Math.min(MAX_VIEW_ZOOM, Math.max(MIN_VIEW_ZOOM, zoom));
}

/** Accept a percentage, not a scale; incomplete/invalid input leaves the current view unchanged. */
export function parseZoomPercent(value: string): number | null {
  const text = value.trim().replace(/%$/, '').trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const percent = Number(text);
  return Number.isFinite(percent) && percent > 0 ? clampViewZoom(percent / 100) : null;
}

export function formatZoomPercent(zoom: number): string {
  return `${Number((zoom * 100).toFixed(2))}%`;
}

/** widthPt is the sum of the actual facing-page widths; heightPt is their maximum height. */
export function calculateFitZoom(mode: Exclude<ViewZoomMode, 'manual'>, page: ViewZoomSize, viewport: ViewZoomViewport): number | null {
  if (!(page.widthPt > 0 && page.heightPt > 0 && Number.isFinite(page.widthPt) && Number.isFinite(page.heightPt))) return null;
  const columns = page.columns ?? 1;
  // PageSurface rounds each page width up to a CSS pixel; leave room for that rounding.
  const width = viewport.width - viewport.paddingX - viewport.columnGap * (columns - 1) - columns;
  const height = viewport.height - viewport.paddingY;
  if (width <= 0 || (mode === 'fit-page' && height <= 0)) return null;
  const scale = mode === 'fit-width' ? width / page.widthPt : Math.min(width / page.widthPt, height / page.heightPt);
  return Number.isFinite(scale) ? clampViewZoom(scale) : null;
}

type ViewOrigin = { left: number; top: number };
export type ReadingZoomPoint = { x: number; y: number };
export type ReadingZoomAnchor = { xPt: number; yPt: number; offsetX: number; offsetY: number };

/** Pinch keeps the point under the pointer; Fit keeps the first visible PDF point. */
export function captureReadingZoomAnchor(page: ViewOrigin, viewport: ViewOrigin, zoom: number, point?: ReadingZoomPoint): ReadingZoomAnchor {
  if (point) return { xPt: (point.x - page.left) / zoom, yPt: (point.y - page.top) / zoom,
    offsetX: point.x - viewport.left, offsetY: point.y - viewport.top };
  const x = page.left - viewport.left, y = page.top - viewport.top;
  return { xPt: Math.max(0, -x) / zoom, yPt: Math.max(0, -y) / zoom,
    offsetX: Math.max(0, x), offsetY: Math.max(0, y) };
}

export function readingZoomScrollDelta(anchor: ReadingZoomAnchor, page: ViewOrigin, viewport: ViewOrigin, zoom: number) {
  return { left: page.left - viewport.left + anchor.xPt * zoom - anchor.offsetX,
    top: page.top - viewport.top + anchor.yPt * zoom - anchor.offsetY };
}
