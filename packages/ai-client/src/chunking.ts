import { graphemeBoundaries } from '@pdf-editor/contracts';

export interface TextChunk {
  readonly text: string;
  readonly range: readonly [number, number];
  readonly graphemeCount: number;
}

/** 优先在段落/换行后切分；超长段落只在完整 grapheme 边界切分。 */
export function chunkText(text: string, maxGraphemes: number): readonly TextChunk[] {
  if (!Number.isInteger(maxGraphemes) || maxGraphemes <= 0) {
    throw new Error('maxGraphemes must be a positive integer');
  }
  if (text.length === 0) return Object.freeze([]);

  const boundaries = [...graphemeBoundaries(text)].sort((a, b) => a - b);
  const boundaryIndex = new Map(boundaries.map((offset, index) => [offset, index]));
  const paragraphEnds = new Set<number>();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') paragraphEnds.add(index + 1);
  }
  paragraphEnds.add(text.length);

  const chunks: TextChunk[] = [];
  let startBoundaryIndex = 0;
  while (startBoundaryIndex < boundaries.length - 1) {
    const maximumBoundaryIndex = Math.min(
      startBoundaryIndex + maxGraphemes,
      boundaries.length - 1,
    );
    const start = boundaries[startBoundaryIndex];
    const maximumEnd = boundaries[maximumBoundaryIndex];
    if (start === undefined || maximumEnd === undefined) throw new Error('Unable to compute grapheme boundary');

    let end = maximumEnd;
    for (const paragraphEnd of paragraphEnds) {
      if (paragraphEnd > start && paragraphEnd <= maximumEnd && paragraphEnd > (end === maximumEnd ? start : end)) {
        end = paragraphEnd;
      }
    }
    // 没有段落边界时使用预算内最后一个完整 grapheme。
    if (end === start) end = maximumEnd;
    const endBoundaryIndex = boundaryIndex.get(end);
    if (endBoundaryIndex === undefined || endBoundaryIndex <= startBoundaryIndex) {
      throw new Error('Paragraph boundary is not a complete grapheme boundary');
    }
    chunks.push(Object.freeze({
      text: text.slice(start, end),
      range: Object.freeze([start, end]) as readonly [number, number],
      graphemeCount: endBoundaryIndex - startBoundaryIndex,
    }));
    startBoundaryIndex = endBoundaryIndex;
  }
  return Object.freeze(chunks);
}
