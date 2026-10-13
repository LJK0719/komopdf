import type { EditableObject, Matrix, PageModel, Rect } from '@pdf-editor/contracts';

export type TextFrame = { width: number; height: number; transform: Matrix; objectIds: string[]; baseline?: number };
export type FrameHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

function point(matrix: Matrix, x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

export function localFrameDelta(frame: TextFrame, dx: number, dy: number): [number, number] {
  const [a, b, c, d] = frame.transform;
  const determinant = a * d - b * c;
  return [(d * dx - c * dy) / determinant, (-b * dx + a * dy) / determinant];
}

export function frameBounds(frame: TextFrame, box: Rect = { x: 0, y: 0, width: frame.width, height: frame.height }): Rect {
  const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]];
  const points = corners.map(([x, y]) => point(frame.transform, x!, y!));
  const minX = Math.min(...points.map(item => item[0])), minY = Math.min(...points.map(item => item[1]));
  return { x: minX, y: minY, width: Math.max(...points.map(item => item[0])) - minX,
    height: Math.max(...points.map(item => item[1])) - minY };
}

export function selectionTextFrame(page: PageModel, selected: EditableObject[]): TextFrame | null {
  if (selected.length !== 1) return null;
  const object = selected[0]!, block = object.textBlock;
  if (!block || block.isOcr || block.editability === 'geometry-only') return null;
  const ids = block.sourceObjectIds.length ? block.sourceObjectIds : [object.id];
  const frames = ids.map(id => page.objects.find(item => item.id === id)?.textBlock?.frame);
  const first = frames[0];
  if (!first || frames.some(frame => !frame)) return null;
  const [a, b, c, d, e, f] = first.transform;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-12) return null;
  const inverse: Matrix = [d / determinant, -b / determinant, -c / determinant, a / determinant,
    (c * f - d * e) / determinant, (b * e - a * f) / determinant];
  const points = frames.flatMap(frame => [[0, 0], [frame!.width, 0], [0, frame!.height], [frame!.width, frame!.height]]
    .map(([x, y]) => { const p = point(frame!.transform, x!, y!); return point(inverse, p[0], p[1]); }));
  const left = Math.min(...points.map(item => item[0])), top = Math.min(...points.map(item => item[1]));
  const origin = point(first.transform, left, top);
  return { width: Math.max(...points.map(item => item[0])) - left, height: Math.max(...points.map(item => item[1])) - top,
    transform: [a, b, c, d, origin[0], origin[1]], objectIds: ids,
    ...(first.baseline !== undefined ? { baseline: first.baseline - top } : {}) };
}

export function resizedTextFrame(frame: TextFrame, handle: FrameHandle, dx: number, dy: number): Rect {
  let left = 0, top = 0, right = frame.width, bottom = frame.height;
  if (handle.includes('w')) left = Math.min(dx, right - 1);
  if (handle.includes('e')) right = Math.max(1, right + dx);
  if (handle.includes('n')) top = Math.min(dy, bottom - 1);
  if (handle.includes('s')) bottom = Math.max(1, bottom + dy);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
