import { describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, TextBlock } from '@pdf-editor/contracts';
import { searchPdfDocument } from '../src/ui/PdfSearchPanel.js';

const block = (id: string, pageId: string, ...runs: string[]) => ({
  id, pageId, runs: runs.map(text => ({ text })),
}) as TextBlock;

const snapshot = (pageOrder: string[]) => ({ id: 'doc-1', revision: 7, pageOrder });

describe('PDF search', () => {
  it('finds every occurrence per block and beyond the first 100 blocks, preserving page and UTF-16 ranges', async () => {
    const firstPage = [block('b1', 'page-1', '😀 A', 'b AB aB')];
    const secondPage = Array.from({ length: 101 }, (_, index) => block(`b${index + 2}`, 'page-2', 'ab'));
    const extract = vi.fn(async ({ pageIds }: { pageIds: string[] }) => pageIds[0] === 'page-1' ? firstPage : secondPage);
    const progress = vi.fn();

    const matches = await searchPdfDocument({ extract } as Pick<EngineAdapter, 'extract'>,
      snapshot(['page-1', 'page-2']), 'ab', new AbortController().signal, progress);

    expect(matches).toHaveLength(104);
    expect(matches.slice(0, 3).map(({ blockId, pageNumber, range }) => ({ blockId, pageNumber, range }))).toEqual([
      { blockId: 'b1', pageNumber: 1, range: { start: 3, end: 5 } },
      { blockId: 'b1', pageNumber: 1, range: { start: 6, end: 8 } },
      { blockId: 'b1', pageNumber: 1, range: { start: 9, end: 11 } },
    ]);
    expect(matches.at(-1)).toMatchObject({ pageId: 'page-2', blockId: 'b102', pageNumber: 2,
      range: { start: 0, end: 2 } });
    expect(progress.mock.calls.map(([found, scannedPages]) => [found.length, scannedPages])).toEqual([[3, 1], [104, 2]]);
    expect(extract.mock.calls.map(([request]) => request.pageIds)).toEqual([['page-1'], ['page-2']]);
  });

  it('searches literal special characters, including astral characters, without changing original offsets', async () => {
    const extract = vi.fn(async () => [block('b1', 'page-1', 'prefix 😀.* more 😀.*')]);
    const matches = await searchPdfDocument({ extract } as Pick<EngineAdapter, 'extract'>,
      snapshot(['page-1']), '😀.*', new AbortController().signal, vi.fn());

    expect(matches.map(match => match.range)).toEqual([{ start: 7, end: 11 }, { start: 17, end: 21 }]);
  });

  it('stops before starting another page when cancelled during progress', async () => {
    const controller = new AbortController();
    const extract = vi.fn(async () => [block('b1', 'page-1', 'hit')]);
    const progress = vi.fn(() => controller.abort());

    const matches = await searchPdfDocument({ extract } as Pick<EngineAdapter, 'extract'>,
      snapshot(['page-1', 'page-2']), 'hit', controller.signal, progress);

    expect(matches).toHaveLength(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it('discards an in-flight extraction result after cancellation', async () => {
    const controller = new AbortController();
    let resolveExtract!: (blocks: TextBlock[]) => void;
    const extract = vi.fn(() => new Promise<TextBlock[]>(resolve => { resolveExtract = resolve; }));
    const progress = vi.fn();
    const pending = searchPdfDocument({ extract } as Pick<EngineAdapter, 'extract'>,
      snapshot(['page-1', 'page-2']), 'hit', controller.signal, progress);

    controller.abort();
    resolveExtract([block('b1', 'page-1', 'hit')]);

    expect(await pending).toEqual([]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
  });
});
