import type { PageModel, Rect } from '@pdf-editor/contracts';

export type SignaturePoint = [number, number];
export type SignatureStroke = SignaturePoint[];
/** In-memory only. The editor owns this template so switching tools does not erase it. */
export type SignatureDraft = { strokes: SignatureStroke[]; strokeWidth: number };
type PageSize = Pick<PageModel, 'widthPt' | 'heightPt'>;
type ClientRect = { left: number; top: number; width: number; height: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function signaturePagePoint(clientX: number, clientY: number, rect: ClientRect, page: PageSize): SignaturePoint {
  return [
    clamp((clientX - rect.left) / rect.width * page.widthPt, 0, page.widthPt),
    clamp((clientY - rect.top) / rect.height * page.heightPt, 0, page.heightPt),
  ];
}

export function initialSignaturePlacement(page: PageSize): Rect {
  const width = Math.min(180, page.widthPt * 0.8, page.heightPt * 0.8 * 3);
  const height = width / 3;
  return { x: (page.widthPt - width) / 2, y: (page.heightPt - height) / 2, width, height };
}

export function moveSignaturePlacement(bounds: Rect, x: number, y: number, page: PageSize): Rect {
  return { ...bounds, x: clamp(x, 0, page.widthPt - bounds.width), y: clamp(y, 0, page.heightPt - bounds.height) };
}

/** Resize from the bottom-right, retaining the drawn signature's proportions. */
export function resizeSignaturePlacement(bounds: Rect, width: number, page: PageSize): Rect {
  const ratio = bounds.height / bounds.width;
  const maxWidth = Math.min(page.widthPt - bounds.x, (page.heightPt - bounds.y) / ratio);
  const nextWidth = clamp(width, Math.min(24, maxWidth), maxWidth);
  return { ...bounds, width: nextWidth, height: nextWidth * ratio };
}

export function signaturePreviewPoints(stroke: SignatureStroke, bounds: Rect): string {
  return stroke.map(([x, y]) => `${x * bounds.width},${y * bounds.height}`).join(' ');
}
