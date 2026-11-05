import { describe, expect, it, vi } from 'vitest';
import type { AiRequest, DocumentInfo, EngineAdapter, TextBlock } from '@pdf-editor/contracts';
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
  const metrics = async (_docId: string, pageId: string) => ({ id: pageId, widthPt: 600, heightPt: 800, rotation: 0 });
  const engine = { extract, render: vi.fn().mockResolvedValue({ width: 1, height: 1, stride: 4, format: 'rgba', pixels: new ArrayBuffer(4), revision: 1 }),
    describePageMetrics: vi.fn(metrics), describePage: vi.fn(async (docId: string, pageId: string) => ({ ...await metrics(docId, pageId), objects: [] })) } as unknown as EngineAdapter;
  return { engine, document, page: { id: 'p2', widthPt: 600, heightPt: 800, rotation: 0 as const, objects: [] },
    scope: 'document' as const, selectedIds: [], instruction: 'Summarize', history: [] as ChatTurn[], signal: new AbortController().signal };
}
function answerFetch(requests: AiRequest[]) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(init!.body as string) as AiRequest; requests.push(request);
    const pages = request.context.pages?.map(page => page.pageNumber).join(', ') || 'text';
    const events = [{ type: 'accepted', requestId: request.requestId }, { type: 'result', response: {
      protocolVersion: 1, requestId: request.requestId, document: { id: request.document.id, baseRevision: request.document.revision },
      feature: request.feature, result: { kind: 'answer', text: `Read pages ${pages}.`, citations: [] },
    } }, { type: 'done', requestId: request.requestId }];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
}

describe('lightweight komo context', () => {
  it.each(['document', 'page', 'selection'] as ChatScope[])('honors PDF copy permissions for %s context', async scope => {
    for (const visualMode of ['auto', 'always', 'text'] as ChatVisualMode[]) {
      const input = options(); input.document = { ...document, permissions: { ...document.permissions, copy: false } };
      const authorization = new DocumentAiAuthorization(document.id); authorization.enable(document.sourceIds);
      const send = vi.fn().mockRejectedValue(new Error('Unexpected gateway request'));
      const workflow = new AiWorkflow({ endpoint: '/api/v1/ai/requests', authorization,
        getCurrentDocument: () => input.document, nextTransactionId: () => 'unused',
        apply: async () => { throw new Error('Reading does not modify the PDF'); }, fetch: send });
      await expect((async () => {
        const prepared = await prepareChatContext({ ...input, scope, visualMode, selectedIds: ['o1'] });
        await workflow.run({ request: prepared.request, snapshot: prepared.snapshot, sourceIds: document.sourceIds });
      })()).rejects.toThrow(CHAT_COPY_RESTRICTED);
      expect(input.engine.extract).not.toHaveBeenCalled(); expect(input.engine.describePage).not.toHaveBeenCalled();
      expect(input.engine.render).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    }
  });
  it('does not treat a missing copy permission as authorization', async () => {
    const input = options(); const { copy: _copy, ...permissions } = document.permissions;
    input.document = { ...document, permissions } as DocumentInfo;
    await expect(prepareChatContext(input)).rejects.toThrow(CHAT_COPY_RESTRICTED);
    expect(input.engine.extract).not.toHaveBeenCalled(); expect(input.engine.render).not.toHaveBeenCalled();
  });
  it('keeps page evidence and the latest six exchanges without creating stored tasks', async () => {
    const input = options(); input.history = Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `turn ${index}` }));
    const result = await prepareChatContext(input);
    expect(result.pageNumbers).toEqual([1, 2, 3]); expect(result.request.context.evidence.map(item => item.pageNumber)).toEqual([1, 2, 3]);
    expect(result.request.context.history).toEqual(input.history.slice(4)); expect(result.request.feature).toBe('document.ask'); expect(result.scanned).toBe(false);
  });
  it('uses only the selected current page', async () => {
    const input = options(); const result = await prepareChatContext({ ...input, scope: 'page' });
    expect(input.engine.extract).toHaveBeenCalledTimes(1); expect(result.pageNumbers).toEqual([2]); expect(result.request.context.evidence[0]?.pageId).toBe('p2');
  });
  it('reads every page of a longer scan in visual batches instead of rejecting the question', async () => {
    const input = options(vi.fn(async () => [])), requests: AiRequest[] = [];
    const result = await prepareChatContext({ ...input, endpoint: '/api/v1/ai/requests', fetch: answerFetch(requests) });
    expect(input.engine.extract).toHaveBeenCalledTimes(3); expect(input.engine.render).toHaveBeenCalledTimes(3);
    expect(requests.map(request => request.context.pages?.map(page => page.pageNumber))).toEqual([[1, 2], [3]]);
    expect(requests.every(request => (request.context.images?.length ?? 0) <= 2)).toBe(true);
    expect(result.request.feature).toBe('document.ask');
    expect(result.request.context.referenceEvidence?.[0]?.text).toContain('Read pages 1, 2.');
    expect(result.request.context.referenceEvidence?.[0]?.text).toContain('Read pages 3.');
  });
  it('uses parsed full text for scanned PDFs and retains it for follow-up questions', async () => {
    const input = options(vi.fn(async () => []));
    const reading = { documentId: 'd1', revision: 1, jobId: 'read-one', name: 'Paper', filename: 'Paper.md', text: '# Paper\nThe full result is available.' };
    const readDocument = vi.fn(async () => reading);
    const result = await prepareChatContext({ ...input, readDocument });
    expect(readDocument).toHaveBeenCalledOnce(); expect(input.engine.render).not.toHaveBeenCalled();
    expect(result.reading).toEqual(reading); expect(result.request.context.referenceEvidence?.[0]?.text).toBe(reading.text);
    vi.mocked(input.engine.extract).mockClear();
    const followUp = await prepareChatContext({ ...input, reading, instruction: 'Explain the result.' });
    expect(input.engine.extract).not.toHaveBeenCalled(); expect(followUp.request.context.referenceEvidence?.[0]?.text).toBe(reading.text);
  });
  it('reuses extracted text for the same PDF version', async () => {
    const input = options(); const first = await prepareChatContext(input);
    await prepareChatContext({ ...input, instruction: 'What else?', sourceContext: first.sourceContext! });
    expect(input.engine.extract).toHaveBeenCalledTimes(3);
    await prepareChatContext({ ...input, document: { ...document, revision: 2 }, sourceContext: first.sourceContext! });
    expect(input.engine.extract).toHaveBeenCalledTimes(6);
  });
  it('includes the image of a mixed page even when its header has extractable text', async () => {
    const input = options();
    const page = { ...input.page, objects: [{ id: 'scan', pageId: 'p2', type: 'image' as const,
      bounds: { x: 0, y: 0, width: 600, height: 800 }, transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
      locator: { pageId: 'p2', containerPath: [], objectIndex: 0 } }] };
    const result = await prepareChatContext({ ...input, page, scope: 'page' });
    expect(result.request.feature).toBe('image.explain'); expect(result.request.context.images).toHaveLength(1); expect(result.request.context.evidence).toHaveLength(1);
  });
  it('can include an image for a text/vector page', async () => {
    const input = options(); const result = await prepareChatContext({ ...input, scope: 'page', visualMode: 'always' });
    expect(result.imagePageNumbers).toEqual([2]); expect(input.engine.render).toHaveBeenCalledTimes(1);
  });
  it('labels oversized ordinary-question context as excerpts', async () => {
    const input = options(vi.fn(async () => [block('p1', 'a'.repeat(CHAT_TEXT_LIMIT + 1))]));
    const result = await prepareChatContext({ ...input, instruction: 'What does this passage discuss?' });
    expect(result.coverage[0]?.kind).toBe('excerpts'); expect(result.request.context.sourceDocuments?.[0]?.coverage?.kind).toBe('excerpts');
    expect(result.request.context.evidence.reduce((total, evidence) => total + evidence.text.length, 0)).toBeLessThanOrEqual(CHAT_TEXT_LIMIT);
  });
  it('does not collect document content after cancellation', async () => {
    const input = options(); await expect(prepareChatContext({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(input.engine.extract).not.toHaveBeenCalled();
  });
});
