import { describe, expect, it, vi } from 'vitest';
import type { DocumentInfo, EngineAdapter, TextBlock } from '@pdf-editor/contracts';
import { AiWorkflow, DocumentAiAuthorization } from '@pdf-editor/ai-client';
import { prepareChatContext, CHAT_COPY_RESTRICTED, CHAT_TEXT_LIMIT, type ChatScope, type ChatVisualMode, type ChatTurn } from '../src/ui/komo-chat-context.js';

vi.mock('../src/ui/AiPanelImage.js', () => ({ encodeRenderedImage: () => 'aW1hZ2U=' }));

const document: DocumentInfo = { id: 'd1', revision: 1, savedRevision: 1, sourceIds: ['source'],
  pageOrder: ['p1', 'p2', 'p3'], permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false }, capabilities: [] };
const block = (pageId: string, text = 'Page text'): TextBlock => ({
  id: `b-${pageId}`, pageId, sourceId: 'source', sourceObjectIds: ['o1'],
  runs: [{ text, style: { fontId: 'f1', fontSize: 12, color: [0, 0, 0] }, sourceObjectIds: ['o1'] }],
  bounds: { x: 0, y: 0, width: 120, height: 20 }, transform: [1, 0, 0, 1, 0, 0], editability: 'direct',
});
function options(extract = vi.fn(async ({ pageIds }: { pageIds?: string[] }) => [block(pageIds![0]!)])) {
  const engine = { extract, render: vi.fn(), describePage: vi.fn(async (_docId: string, pageId: string) => ({ id: pageId, widthPt: 600, heightPt: 800, rotation: 0, objects: [] })) } as unknown as EngineAdapter;
  return { engine, document, page: { id: 'p2', widthPt: 600, heightPt: 800, rotation: 0 as const, objects: [] },
    scope: 'document' as const, selectedIds: [], instruction: 'Summarize', history: [] as ChatTurn[], signal: new AbortController().signal };
}

describe('lightweight komo context', () => {
  it.each(['document', 'page', 'selection'] as ChatScope[])('blocks copy-restricted %s context before extraction, rendering or sending, even with sharing consent', async scope => {
    for (const visualMode of ['auto', 'always', 'text'] as ChatVisualMode[]) {
      const input = options();
      input.document = { ...document, permissions: { ...document.permissions, copy: false } };
      const authorization = new DocumentAiAuthorization(document.id);
      authorization.enable(document.sourceIds);
      const send = vi.fn().mockRejectedValue(new Error('Unexpected gateway request'));
      const workflow = new AiWorkflow({ endpoint: '/api/v1/ai/requests', authorization,
        getCurrentDocument: () => input.document, nextTransactionId: () => 'unused',
        apply: async () => { throw new Error('Read-only chat'); }, fetch: send });
      await expect((async () => {
        const prepared = await prepareChatContext({ ...input, scope, visualMode, selectedIds: ['o1'] });
        await workflow.run({ request: prepared.request, snapshot: prepared.snapshot, sourceIds: document.sourceIds });
      })()).rejects.toThrow(CHAT_COPY_RESTRICTED);
      expect(input.engine.extract).not.toHaveBeenCalled();
      expect(input.engine.describePage).not.toHaveBeenCalled();
      expect(input.engine.render).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('does not treat a missing copy permission as authorization', async () => {
    const input = options();
    const { copy: _copy, ...permissions } = document.permissions;
    input.document = { ...document, permissions } as DocumentInfo;
    await expect(prepareChatContext(input)).rejects.toThrow(CHAT_COPY_RESTRICTED);
    expect(input.engine.extract).not.toHaveBeenCalled();
    expect(input.engine.render).not.toHaveBeenCalled();
  });

  it('keeps page evidence and the latest six exchanges without creating stored tasks', async () => {
    const input = options();
    input.history = Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `turn ${index}` }));
    const result = await prepareChatContext(input);
    expect(result.pageNumbers).toEqual([1, 2, 3]);
    expect(result.request.context.evidence.map(item => item.pageNumber)).toEqual([1, 2, 3]);
    expect(result.request.context.history).toEqual(input.history.slice(4));
    expect(result.request.feature).toBe('document.ask');
    expect(result.scanned).toBe(false);
  });

  it('uses only the selected current page', async () => {
    const input = options();
    const result = await prepareChatContext({ ...input, scope: 'page' });
    expect(input.engine.extract).toHaveBeenCalledTimes(1);
    expect(result.pageNumbers).toEqual([2]);
    expect(result.request.context.evidence[0]?.pageId).toBe('p2');
  });

  it('does not silently send just the first two pages of a longer scan', async () => {
    const input = options(vi.fn(async () => []));
    input.document = { ...document, pageOrder: Array.from({ length: 200 }, (_, index) => `p${index + 1}`) };
    await expect(prepareChatContext(input)).rejects.toMatchObject({ scanned: true, action: 'page', message: expect.stringContaining('More than two pages') });
    expect(input.engine.extract).toHaveBeenCalledTimes(3);
    expect(input.engine.render).not.toHaveBeenCalled();
  });

  it('includes the image of a mixed page even when its header has extractable text', async () => {
    const input = options();
    const page = { ...input.page, objects: [{ id: 'scan', pageId: 'p2', type: 'image' as const,
      bounds: { x: 0, y: 0, width: 600, height: 800 }, transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
      locator: { pageId: 'p2', containerPath: [], objectIndex: 0 } }] };
    vi.mocked(input.engine.render).mockResolvedValue({ width: 1, height: 1, stride: 4, format: 'rgba', pixels: new ArrayBuffer(4), revision: 1 });
    const result = await prepareChatContext({ ...input, page, scope: 'page' });
    expect(result.request.feature).toBe('image.explain');
    expect(result.request.context.images).toHaveLength(1);
    expect(result.request.context.evidence).toHaveLength(1);
  });

  it('lets the user explicitly include an image for a text/vector page', async () => {
    const input = options();
    vi.mocked(input.engine.render).mockResolvedValue({ width: 1, height: 1, stride: 4, format: 'rgba', pixels: new ArrayBuffer(4), revision: 1 });
    const result = await prepareChatContext({ ...input, scope: 'page', visualMode: 'always' });
    expect(result.imagePageNumbers).toEqual([2]);
    expect(input.engine.render).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized text rather than claiming a partial summary is exhaustive', async () => {
    const input = options(vi.fn(async () => [block('p1', 'a'.repeat(CHAT_TEXT_LIMIT + 1))]));
    await expect(prepareChatContext(input)).rejects.toThrow('no partial document was sent');
  });

  it('does not collect document content after cancellation', async () => {
    const input = options();
    await expect(prepareChatContext({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(input.engine.extract).not.toHaveBeenCalled();
  });
});
