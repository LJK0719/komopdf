import { CommandRegistry, validateTransaction } from '@pdf-editor/commands';
import type { CommitResult, DocumentInfo, EditCommand, EditTransaction, EngineAdapter, PageModel, PdfAnnotationInfo, Rect } from '@pdf-editor/contracts';

export type AnnotationDrawingOptions = {
  tool: 'text' | 'rectangle' | 'ink';
  color: string;
  opacity: number;
  strokeWidth: number;
  text: string;
};
export type AnnotationPoint = [number, number];
export type AnnotationCommand = Extract<EditCommand, { type: 'annotation.add' }>;

/** Commands use displayed page-space points, top-left origin. The core applies crop/rotation and PDF's Y flip. */
export function annotationPointFromClient(
  clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  page: Pick<PageModel, 'widthPt' | 'heightPt'>,
): AnnotationPoint {
  return [
    Math.max(0, Math.min(page.widthPt, (clientX - rect.left) * page.widthPt / rect.width)),
    Math.max(0, Math.min(page.heightPt, (clientY - rect.top) * page.heightPt / rect.height)),
  ];
}

export function annotationBounds(points: AnnotationPoint[], page: PageModel, padding = 0): Rect {
  let left = page.widthPt, top = page.heightPt, right = 0, bottom = 0;
  for (const [x, y] of points) {
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  left = Math.max(0, left - padding); top = Math.max(0, top - padding);
  right = Math.min(page.widthPt, right + padding); bottom = Math.min(page.heightPt, bottom + padding);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function annotationNoteBounds(point: AnnotationPoint, page: PageModel): Rect {
  const width = Math.min(24, page.widthPt), height = Math.min(24, page.heightPt);
  return { x: Math.max(0, Math.min(page.widthPt - width, point[0] - width / 2)),
    y: Math.max(0, Math.min(page.heightPt - height, point[1] - height / 2)), width, height };
}

/** Null means an empty gesture; it must never create a history entry. */
export function buildDrawnAnnotation(page: PageModel, options: AnnotationDrawingOptions, points: AnnotationPoint[]): AnnotationCommand | null {
  if (!points.length) return null;
  if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > page.widthPt || y > page.heightPt)) {
    throw new Error('Annotation points must fit within the page.');
  }
  if (!/^#[0-9a-f]{6}$/i.test(options.color)) throw new Error('Color must use #RRGGBB');
  if (!Number.isFinite(options.strokeWidth) || options.strokeWidth <= 0) throw new Error('Stroke width must be positive');
  if (!Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 1) throw new Error('Opacity must be between 0 and 1');
  const bounds = options.tool === 'text' ? annotationNoteBounds(points[0]!, page)
    : annotationBounds(points, page, options.tool === 'ink' ? options.strokeWidth / 2 : 0);
  if (options.tool === 'text' && !options.text.trim()) return null;
  if (options.tool === 'rectangle' && (bounds.width === 0 || bounds.height === 0)) return null;
  if (options.tool === 'ink' && !points.some(([x, y]) => x !== points[0]![0] || y !== points[0]![1])) return null;
  const color = [1, 3, 5].map(offset => parseInt(options.color.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  return {
    type: 'annotation.add', pageId: page.id, annotationId: crypto.randomUUID(), subtype: options.tool,
    bounds, color, opacity: options.opacity,
    ...(options.text.trim() ? { text: options.text.trim() } : {}),
    ...(options.tool !== 'text' ? { strokeWidth: options.strokeWidth } : {}),
    ...(options.tool === 'ink' ? { points } : {}),
  };
}

export async function commitDrawnAnnotation(
  engine: EngineAdapter, document: DocumentInfo, page: PageModel, command: AnnotationCommand,
  isCurrent: () => boolean, onCommitted: (result: CommitResult) => Promise<void>,
): Promise<void> {
  if (!isCurrent()) return;
  const transaction: EditTransaction = {
    id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual', commands: [command],
  };
  const context = { document, pages: new Map([[page.id, page]]) };
  validateTransaction(transaction, context);
  await engine.previewTransaction(transaction);
  if (!isCurrent()) return;
  const result = await new CommandRegistry(engine).execute(transaction, context);
  // A completed engine write must always be reported, even if the view was closed meanwhile.
  await onCommitted(result);
}

export type AnnotationFilter = { pageId: string; subtype: string; text: string };
export function filterAnnotations(annotations: PdfAnnotationInfo[], filter: AnnotationFilter): PdfAnnotationInfo[] {
  const text = filter.text.trim().toLocaleLowerCase();
  return annotations.filter(annotation => (!filter.pageId || annotation.pageId === filter.pageId)
    && (!filter.subtype || annotation.subtype === filter.subtype)
    && (!text || annotation.text.toLocaleLowerCase().includes(text)));
}

export const annotationTypeLabels: Record<PdfAnnotationInfo['subtype'], string> = {
  text: 'Note', rectangle: 'Rectangle', ink: 'Freehand', highlight: 'Highlight', link: 'Link', other: 'Other',
};
