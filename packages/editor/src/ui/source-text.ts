import type { TextBlock, TextRange } from '@pdf-editor/contracts';

// The source has glyph-only ranges. A TJ gap becomes a real space only in the
// logical paragraph, never in a native range command sent to the source object.
export function logicalTextOffset(block: TextBlock, sourceOffset: number): number {
  return sourceOffset + (block.inferredSpaces?.filter(offset => offset <= sourceOffset).length ?? 0);
}

export function logicalTextRange(block: TextBlock, range: TextRange): TextRange {
  const start = logicalTextOffset(block, range[0]);
  // An end boundary belongs to the preceding glyph, not the inferred gap
  // before the next glyph. A caret instead uses the same affinity at both ends.
  const end = range[0] === range[1] ? start
    : range[1] + (block.inferredSpaces?.filter(offset => offset < range[1]).length ?? 0);
  return [start, end];
}

export function paragraphInputRange(block: TextBlock, range: TextRange, sourceOffset: number, logical = false): TextRange {
  const selection = logical ? range : logicalTextRange(block, range);
  return [sourceOffset + selection[0], sourceOffset + selection[1]];
}

export function sourceTextOffset(block: TextBlock, logicalOffset: number): number {
  let added = 0;
  for (const offset of block.inferredSpaces ?? []) {
    if (offset + added >= logicalOffset) break;
    added++;
  }
  return Math.max(0, logicalOffset - added);
}

const cache = new WeakMap<TextBlock, TextBlock>();
export function logicalTextBlock(block: TextBlock): TextBlock {
  if (!block.inferredSpaces?.length) return block;
  const cached = cache.get(block);
  if (cached) return cached;
  let start = 0;
  const runs = block.runs.map(run => {
    let text = '', previous = 0;
    for (const offset of block.inferredSpaces!) {
      if (offset < start || offset >= start + run.text.length) continue;
      const local = offset - start;
      text += run.text.slice(previous, local) + ' ';
      previous = local;
    }
    text += run.text.slice(previous);
    start += run.text.length;
    return { ...run, text };
  });
  const result: TextBlock = { ...block, runs, inferredSpaces: [],
    ...(block.characters ? { characters: block.characters.map(character => ({ ...character,
      range: logicalTextRange(block, character.range) })) } : {}) };
  cache.set(block, result);
  return result;
}
