import { describe, expect, it, vi } from 'vitest';
import type { PageModel, EditableObject, EngineAdapter } from '@pdf-editor/contracts';
import { searchPdfDocument } from '../src/ui/PdfSearchPanel.js';
import { searchPage, prepareSearchReplacement } from '../src/ui/page-search.js';

function object(id: string, text: string, x: number, y = 20): EditableObject {
  const bounds = { x, y, width: text.length * 6, height: 12 };
  return { id, pageId: 'p1', type: 'text', bounds, transform: [1, 0, 0, 1, 0, 0], locator: { pageId: 'p1', containerPath: [], objectIndex: 0 },
    textBlock: { id: `${id}:text`, pageId: 'p1', sourceId: 's1', sourceObjectIds: [id], bounds, transform: [1, 0, 0, 1, 0, 0], editability: 'direct',
      runs: [{ text, style: { fontId: 'Helvetica', fontSize: 12 }, sourceObjectIds: [id] }] } };
}
const page = (objects: EditableObject[]): PageModel => ({ id: 'p1', widthPt: 612, heightPt: 792, rotation: 0, objects });
const snapshot = { id: 'doc', revision: 1, pageOrder: ['p1', 'p2'] };

describe('PDF logical text search', () => {
  it('finds words spanning PDF objects and different font styles', () => {
    const first = object('a', 'Trans', 20), second = object('b', 'lation', 50);
    second.textBlock!.runs[0]!.style.weight = 700;
    const hits = searchPage(page([second, first]), 1, 'translation');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sources).toEqual([{ objectId: 'a', blockId: 'a:text', range: [0, 5] }, { objectId: 'b', blockId: 'b:text', range: [0, 6] }]);
    expect(hits[0]!.excerpt).toBe('Translation');
  });
  it('maps inferred whitespace and ligatures back to native source offsets', () => {
    const value = object('a', 'Theofﬁce', 20);
    value.textBlock!.inferredSpaces = [3];
    const hits = searchPage(page([value]), 1, 'the office');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sources[0]!.range).toEqual([0, 8]);
    expect(searchPage(page([value]), 1, 'office')[0]!.sources[0]!.range).toEqual([3, 8]);
  });
  it('normalizes line breaks and keeps literal UTF-16 offsets', () => {
    const value = object('a', '😀 Ab\n\n AB aB', 20);
    expect(searchPage(page([value]), 1, 'ab').map(hit => hit.sources[0]!.range)).toEqual([[3, 5], [8, 10], [11, 13]]);
    expect(searchPage(page([value]), 1, 'Ab AB')[0]!.sources[0]!.range).toEqual([3, 10]);
  });
  it('does not join different columns or independent paragraphs', () => {
    expect(searchPage(page([object('a', 'Trans', 20), object('b', 'lation', 350)]), 1, 'translation')).toEqual([]);
    expect(searchPage(page([object('a', 'Trans', 20), object('b', 'lation', 20, 100)]), 1, 'translation')).toEqual([]);
  });
  it('searches read-only container text without treating it as editable', () => {
    const value = object('a', 'Readable', 20);
    value.locator.containerPath = [0]; value.textBlock!.editability = 'geometry-only';
    expect(searchPage(page([value]), 1, 'read')[0]).toMatchObject({ replaceable: false });
  });
  it('searches every page and more than 100 text objects', async () => {
    const describePage = vi.fn(async (_doc: string, id: string) => id === 'p1' ? page([object('a', 'ab AB', 20)])
      : { ...page(Array.from({ length: 101 }, (_, i) => object(`b${i}`, 'ab', 20, i * 40))), id: 'p2' });
    const progress = vi.fn();
    const hits = await searchPdfDocument({ describePage }, snapshot, 'ab', new AbortController().signal, progress);
    expect(hits).toHaveLength(103); expect(progress).toHaveBeenCalledTimes(2);
    expect(describePage.mock.calls.map(call => call[1])).toEqual(['p1', 'p2']);
  });
  it('stops before another page and discards an in-flight result after cancellation', async () => {
    const controller = new AbortController();
    const describePage = vi.fn(async () => page([object('a', 'hit', 20)]));
    expect(await searchPdfDocument({ describePage }, snapshot, 'hit', controller.signal, () => controller.abort())).toHaveLength(1);
    expect(describePage).toHaveBeenCalledOnce();
    const cancelled = new AbortController();
    const read = vi.fn(async () => { cancelled.abort(); return page([object('a', 'hit', 20)]); });
    expect(await searchPdfDocument({ describePage: read }, snapshot, 'hit', cancelled.signal, vi.fn())).toEqual([]);
  });
  it('replaces a cross-object word as one transaction and preserves surrounding text', async () => {
    const source = page([object('a', 'A Trans', 20), object('b', 'lation Z', 62)]);
    const match = searchPage(source, 1, 'translation')[0]!;
    const engine = { describePage: vi.fn(async () => source), previewTransaction: vi.fn(async () => ({ pageOrder: ['p1'] })) } as unknown as EngineAdapter;
    const document = { ...snapshot, savedRevision: 0, sourceIds: ['s1'], capabilities: ['text.replace', 'text.reflow'],
      permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false } } as const;
    const transaction = await prepareSearchReplacement(engine, { ...document, capabilities: [...document.capabilities] }, match, 'Word');
    expect(transaction.source).toBe('manual');
    expect(transaction.commands).toHaveLength(2);
    expect(transaction.commands[0]).toMatchObject({ type: 'text.reflow', preserveSource: true, text: 'A Translation Z' });
    expect(transaction.commands[1]).toMatchObject({ type: 'text.replace', range: [2, 13], text: 'Word' });
  });
});
