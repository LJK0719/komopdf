import type { TextRange } from './engine.js';

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

export function graphemeBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([0, text.length]);
  for (const segment of graphemeSegmenter.segment(text)) boundaries.add(segment.index);
  return boundaries;
}

export function assertTextRange(text: string, range: TextRange, clusterBoundaries?: ReadonlySet<number>): void {
  const [start, end] = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) {
    throw new Error('Text range is out of UTF-16 half-open bounds');
  }
  const boundaries = graphemeBoundaries(text);
  if (!boundaries.has(start) || !boundaries.has(end) ||
      (clusterBoundaries && (!clusterBoundaries.has(start) || !clusterBoundaries.has(end)))) {
    throw new Error('Text range cannot split characters or grapheme clusters');
  }
}
