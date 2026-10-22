import { describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, TextBlock } from '@pdf-editor/contracts';
import { findSearchRanges, nextSearchIndex } from '../src/ui/search-matching.js';
import { searchPdfDocument } from '../src/ui/PdfSearchPanel.js';

const matched = (text: string, query: string, options = {}) =>
  findSearchRanges(text, query, options).map(({ start, end }) => text.slice(start, end));

describe('search matching options', () => {
  it('defaults to case-insensitive literal search and optionally matches case', () => {
    expect(matched('Cat cat CAT concatenate', 'cat')).toEqual(['Cat', 'cat', 'CAT', 'cat']);
    expect(matched('Cat cat CAT concatenate', 'cat', { matchCase: true })).toEqual(['cat', 'cat']);
    expect(matched('a.b a*b a.b', 'a.b')).toEqual(['a.b', 'a.b']);
    expect(findSearchRanges('abc', '')).toEqual([]);
  });

  it('combines whole-word and case matching, treating numbers and underscores as word characters', () => {
    expect(matched('Cat cat CAT concatenate cat2 2cat _cat cat_ (cat)', 'cat', { wholeWord: true }))
      .toEqual(['Cat', 'cat', 'CAT', 'cat']);
    expect(matched('Cat cat CAT concatenate cat2 _cat (cat)', 'cat', { wholeWord: true, matchCase: true }))
      .toEqual(['cat', 'cat']);
  });

  it('uses Unicode boundaries, including astral letters/numbers, marks and connector punctuation', () => {
    const text = 'écat caté Жcat catЖ 𐐀cat cat𐐀 𝟙cat cat𝟙 cat́ ́cat cat‿ cat‍ cat';
    expect(findSearchRanges(text, 'cat', { wholeWord: true })).toEqual([{ start: text.length - 3, end: text.length }]);
    expect(matched('Été été étés', 'été', { wholeWord: true })).toEqual(['Été', 'été']);
    expect(matched('😀cat😀', 'cat', { wholeWord: true })).toEqual(['cat']);
  });

  it('does not claim Chinese segmentation; contiguous letters form one word', () => {
    expect(matched('中文，中文。中文搜索 中文2 A中文', '中文', { wholeWord: true })).toEqual(['中文', '中文']);
    expect(matched('中文，中文。中文搜索 中文2 A中文', '中文')).toHaveLength(5);
  });

  it('keeps original UTF-16 ranges rather than lowercasing/normalizing the text', () => {
    expect(findSearchRanges('İ 😀 Ab aB', 'ab')).toEqual([{ start: 5, end: 7 }, { start: 8, end: 10 }]);
    expect(findSearchRanges('😀 x😀.*x 😀.*', '😀.*', { wholeWord: true })).toEqual([{ start: 10, end: 14 }]);
  });

  it('applies options across text runs/pages without changing the existing search API', async () => {
    const describePage = vi.fn(async (_docId: string, pageId: string) => {
      const bounds = { x: 20, y: 20, width: 150, height: 12 };
      return { id: pageId, widthPt: 600, heightPt: 800, rotation: 0, objects: [{ id: 'o1', pageId, bounds,
        transform: [1, 0, 0, 1, 0, 0], locator: { pageId, containerPath: [], objectIndex: 0 },
        textBlock: { id: 'block', pageId, bounds, runs: [{ text: '😀 C', style: { fontSize: 12 }, sourceObjectIds: ['o1'] }, { text: 'at cat cat2', style: { fontSize: 12 }, sourceObjectIds: ['o1'] }] } }] };
    });
    const engine = { describePage } as unknown as Pick<EngineAdapter, 'describePage'>;
    const snapshot = { id: 'doc', revision: 1, pageOrder: ['p1', 'p2'] };
    const matches = await searchPdfDocument(engine, snapshot, 'cat', new AbortController().signal, vi.fn(),
      { matchCase: true, wholeWord: true });
    expect(matches.map(({ pageId, range }) => ({ pageId, range }))).toEqual([
      { pageId: 'p1', range: { start: 7, end: 10 } }, { pageId: 'p2', range: { start: 7, end: 10 } },
    ]);
    expect(await searchPdfDocument(engine, snapshot, '', new AbortController().signal, vi.fn())).toEqual([]);
    expect(describePage).toHaveBeenCalledTimes(2);
  });
});

describe('search result navigation', () => {
  it('wraps both directions and chooses an endpoint when not yet selected', () => {
    expect(nextSearchIndex(-1, 3, 1)).toBe(0);
    expect(nextSearchIndex(-1, 3, -1)).toBe(2);
    expect(nextSearchIndex(2, 3, 1)).toBe(0);
    expect(nextSearchIndex(0, 3, -1)).toBe(2);
    expect(nextSearchIndex(0, 1, 1)).toBe(0);
    expect(nextSearchIndex(0, 1, -1)).toBe(0);
    expect(nextSearchIndex(-1, 0, 1)).toBe(-1);
    expect(nextSearchIndex(-1, 0, -1)).toBe(-1);
  });
});
