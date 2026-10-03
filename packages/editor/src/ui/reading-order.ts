import type { EditableObject, PageModel, Rect } from '@pdf-editor/contracts';
import { detectParagraphs } from './paragraph-detection.js';

export type ReadingRegion = { objects: EditableObject[]; text: string; bounds: Rect; sourceRanges: Record<string, [number, number]> };
const cache = new WeakMap<PageModel, ReadingRegion[]>();

function gap(regions: ReadingRegion[], axis: 'x' | 'y') {
  const size = axis === 'x' ? 'width' : 'height';
  const intervals = regions.map(region => [region.bounds[axis], region.bounds[axis] + region.bounds[size]] as const).sort((a, b) => a[0] - b[0]);
  let end = intervals[0]![1], best = { start: 0, end: 0, width: 0 };
  for (const interval of intervals.slice(1)) {
    if (interval[0] - end > best.width) best = { start: end, end: interval[0], width: interval[0] - end };
    end = Math.max(end, interval[1]);
  }
  return best;
}

// Recursive whitespace cuts preserve column order. A table rule takes priority
// over a vertical gutter so bordered tables remain in row-major order.
export function readingRegions(page: PageModel): ReadingRegion[] {
  const cached = cache.get(page);
  if (cached) return cached;
  const paragraphs = detectParagraphs(page), grouped = new Set(paragraphs.flatMap(region => region.objects.map(object => object.id)));
  const regions: ReadingRegion[] = [...paragraphs,
    ...page.objects.filter(object => object.textBlock && !grouped.has(object.id)).map(object => {
      const text = object.textBlock!.runs.map(run => run.text).join('');
      return { objects: [object], text, bounds: object.bounds, sourceRanges: { [object.id]: [0, text.length] as [number, number] } };
    })];
  const sizes = regions.flatMap(region => region.objects.map(object => object.textBlock!.runs[0]?.style.fontSize ?? 12)).sort((a, b) => a - b);
  const size = sizes[Math.floor(sizes.length / 2)] ?? 12;
  const order = (items: ReadingRegion[]): ReadingRegion[] => {
    if (items.length < 2) return items;
    const vertical = gap(items, 'x'), horizontal = gap(items, 'y');
    const left = Math.min(...items.map(item => item.bounds.x));
    const right = Math.max(...items.map(item => item.bounds.x + item.bounds.width));
    const tableRule = horizontal.width > 0 && page.objects.some(object => object.type === 'path' &&
      object.bounds.height < size * 0.4 && object.bounds.width > (right - left) * 0.65 &&
      object.bounds.y >= horizontal.start && object.bounds.y <= horizontal.end);
    const axis = tableRule ? 'y' : vertical.width >= size * 0.8 ? 'x' : horizontal.width >= size * 0.25 ? 'y' : null;
    if (axis) {
      const split = axis === 'x' ? vertical : horizontal, middle = (split.start + split.end) / 2;
      const before = items.filter(item => item.bounds[axis] < middle), after = items.filter(item => item.bounds[axis] >= middle);
      if (before.length && after.length) return [...order(before), ...order(after)];
    }
    return items.sort((a, b) => Math.abs(a.bounds.y - b.bounds.y) > size * 0.3 ? a.bounds.y - b.bounds.y : a.bounds.x - b.bounds.x);
  };
  const result = order(regions);
  cache.set(page, result);
  return result;
}
