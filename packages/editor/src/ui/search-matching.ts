export type SearchOptions = { matchCase?: boolean; wholeWord?: boolean };
export type SearchRange = { start: number; end: number };

// A word is a run of Unicode letters, numbers, combining marks, connector
// punctuation (including underscore) or join controls. This is not language-specific segmentation:
// adjacent Chinese characters are one run, not separate dictionary words.
const wordCharacter = /[\p{L}\p{N}\p{M}\p{Pc}\p{Join_Control}]/u;

function characterBefore(text: string, offset: number): string {
  const last = text.charCodeAt(offset - 1);
  const previous = text.charCodeAt(offset - 2);
  const width = last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? 2 : 1;
  return text.slice(Math.max(0, offset - width), offset);
}

/** Literal matching on the original text, preserving UTF-16 offsets for locate/replace. */
export function findSearchRanges(text: string, query: string, options: SearchOptions = {}): SearchRange[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.matchCase ? 'gu' : 'giu');
  const ranges: SearchRange[] = [];
  for (const hit of text.matchAll(pattern)) {
    const start = hit.index;
    const end = start + hit[0].length;
    if (options.wholeWord && (wordCharacter.test(characterBefore(text, start))
      || wordCharacter.test(String.fromCodePoint(text.codePointAt(end) ?? 0)))) continue;
    ranges.push({ start, end });
  }
  return ranges;
}

/** Cycle through results; an unselected list starts at the first/last result. */
export function nextSearchIndex(selected: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (selected < 0 || selected >= count) return direction === 1 ? 0 : count - 1;
  return (selected + direction + count) % count;
}
