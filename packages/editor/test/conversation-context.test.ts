import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRequest, DocumentInfo, EngineAdapter, TextBlock } from '@pdf-editor/contracts';
import type { AiMaterial } from '../src/ui/text-actions.js';
import { prepareChatContext, relevantContextPassages } from '../src/ui/komo-chat-context.js';
import { prepareMaterials } from '../src/ui/komo-materials.js';
import { canRetryContext, compactChatContext, chatHistory, type ChatRequestContext } from '../src/ui/komo-chat-state.js';
import { askReading, condenseReading, PartialReadingError } from '../src/ui/reading-analysis.js';
import { analyzeFullDocument, passagesForBlock, type DocumentPassage } from '../src/ui/document-ai-context.js';

vi.mock('../src/ui/AiPanelImage.js', () => ({ encodeRenderedImage: () => 'aW1hZ2U=' }));
vi.mock('../src/ui/document-ai-context.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/ui/document-ai-context.js')>(), analyzeFullDocument: vi.fn(),
}));
beforeEach(() => { vi.mocked(analyzeFullDocument).mockReset(); });
const doc = (id: string): DocumentInfo => ({ id, revision: 1, savedRevision: 1, sourceIds: [`${id}-source`],
  pageOrder: [`${id}-page`], permissions: { modify: true, copy: true, annotate: true, fillForms: true,
    encrypted: false, signed: false }, capabilities: [] });
const main = doc('main'), reference = doc('reference');
const block = (document: DocumentInfo, index: number, text: string): TextBlock => ({
  id: `b${index}`, pageId: document.pageOrder[0]!, sourceId: document.sourceIds[0], sourceObjectIds: [`o${index}`],
  runs: [{ text, style: { fontId: 'font', fontSize: 12, color: [0, 0, 0] }, sourceObjectIds: [`o${index}`] }],
  bounds: { x: 0, y: index * 12, width: 100, height: 12 }, transform: [1, 0, 0, 1, 0, 0], editability: 'direct',
});
function options(referenceBlocks: TextBlock[] = [], materials: AiMaterial[] = []) {
  const extract = vi.fn(async ({ docId }: { docId: string }) => docId === main.id ? [block(main, 0, 'Primary text')] : referenceBlocks);
  const metrics = async (_docId: string, pageId: string) => ({ id: pageId, widthPt: 600, heightPt: 800, rotation: 0 });
  const engine = { extract, describePage: vi.fn(async (docId: string, pageId: string) => ({ ...await metrics(docId, pageId), objects: [] })),
    describePageMetrics: vi.fn(metrics), render: vi.fn(async () => ({ width: 1, height: 1, stride: 4, format: 'rgba', pixels: new ArrayBuffer(4), revision: 1 })) } as unknown as EngineAdapter;
  return { engine, document: main, page: null, currentPageId: main.pageOrder[0], scope: 'document' as const,
    selectedIds: [], visualMode: 'auto' as const, instruction: 'Compare the attached reference.', history: [] as {role: 'user' | 'assistant'; text: string}[],
    signal: new AbortController().signal, materials,
    materialContext: { document: main, passageCache: new Map<string, DocumentPassage[]>(),
      getDocumentInfo: (id: string): DocumentInfo | null => id === main.id ? main : id === reference.id ? reference : null } };
}
const material: AiMaterial = { id: 'reference-document', documentId: reference.id, revision: 1,
  kind: 'document', name: 'Reference.pdf', text: '', locations: [] };
function answerFetch(requests: AiRequest[], text: (request: AiRequest) => string) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(init!.body as string) as AiRequest; requests.push(request);
    const events = [{ type: 'accepted', requestId: request.requestId }, { type: 'result', response: {
      protocolVersion: 1, requestId: request.requestId, document: { id: request.document.id, baseRevision: request.document.revision }, feature: request.feature,
      result: { kind: 'answer', text: text(request), citations: [] } } }, { type: 'done', requestId: request.requestId }];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
}

describe('conversation context regressions', () => {
  it('fits a 257-block reference to the contract and keeps its relevant last block', async () => {
    const blocks = Array.from({ length: 257 }, (_, index) => block(reference, index, index === 256 ? 'unique-answer' : `Line ${index}`));
    const prepared = await prepareChatContext({ ...options(blocks, [material]), instruction: 'Find unique-answer' });
    expect(prepared.request.context.referenceEvidence!.length).toBeLessThanOrEqual(256);
    expect(prepared.request.context.referenceEvidence?.some(item => item.text === 'unique-answer')).toBe(true);
    expect(prepared.request.context.sourceDocuments?.find(item => item.id === reference.id)?.coverage?.kind).toBe('excerpts');
  });
  it('keeps real source pages when a same-version draft follows a selected PDF passage', async () => {
    const selection: AiMaterial = { ...material, id: 'selection', kind: 'selection', text: 'Reference text',
      locations: [{ pageId: reference.pageOrder[0]!, pageNumber: 1, blockId: 'b0', range: [0, 14], text: 'Reference text' }] };
    const draft: AiMaterial = { ...material, id: 'draft', kind: 'text', text: 'A draft from the same PDF.' };
    const prepared = await prepareChatContext(options([block(reference, 0, 'Reference text')], [selection, draft]));
    expect(prepared.request.context.sourceDocuments?.find(item => item.id === reference.id)?.pageIds).toEqual(reference.pageOrder);
    expect(prepared.request.context.referenceEvidence).toHaveLength(2);
  });
  it('actually reads a scanned reference rather than declaring empty full coverage', async () => {
    const requests: AiRequest[] = [];
    const prepared = await prepareChatContext({ ...options([], [material]), endpoint: '/fixture',
      fetch: answerFetch(requests, () => 'The reference contains an image.') });
    expect(requests).toHaveLength(1); expect(requests[0]?.document.id).toBe(reference.id);
    expect(requests[0]?.context.images).toHaveLength(1);
    expect(prepared.request.context.referenceEvidence?.[0]?.text).toContain('reference contains an image');
    expect(prepared.request.context.sourceDocuments?.find(item => item.id === reference.id)?.coverage?.kind).toBe('analysis');
  });
  it('reuses passages already extracted while validating an unchanged reference', async () => {
    const input = options([block(reference, 0, 'Reference text')], [material]);
    await prepareMaterials(input.materials, { ...input.materialContext, engine: input.engine }, input.signal);
    await prepareChatContext(input);
    expect(vi.mocked(input.engine.extract).mock.calls.filter(([value]) => value.docId === reference.id)).toHaveLength(1);
  });
  it.each(['この文書を要約', 'Dieses Dokument zusammenfassen'])('uses explicit summary intent for %s', async instruction => {
    const input = options();
    vi.mocked(input.engine.extract).mockResolvedValue([block(main, 0, 'Source. '.repeat(6000))]);
    vi.mocked(analyzeFullDocument).mockResolvedValue({ document: main, overview: 'Full overview', sections: [], pagesScanned: 1, pagesWithText: 1, passagesScanned: 6 });
    const prepared = await prepareChatContext({ ...input, instruction, intent: 'summary', endpoint: '/fixture' });
    expect(analyzeFullDocument).toHaveBeenCalledOnce();
    expect(prepared.request.context.referenceEvidence?.[0]?.text).toBe('Full overview');
  });
  it('reads every mixed scan page for an ordinary factual question', async () => {
    const input = options(); const document = { ...main, pageOrder: ['p1', 'p2', 'p3'] };
    input.materialContext.getDocumentInfo = id => id === main.id ? document : null;
    vi.mocked(input.engine.extract).mockImplementation(async ({ pageIds }) => [{ ...block(main, 0, 'Page header'), pageId: pageIds![0]! }]);
    vi.mocked(input.engine.describePage).mockImplementation(async (_doc, pageId) => ({ id: pageId, widthPt: 600, heightPt: 800, rotation: 0,
      objects: [{ id: 'scan', pageId, type: 'image', bounds: { x: 0, y: 0, width: 600, height: 800 }, transform: [1, 0, 0, 1, 0, 0],
        locator: { pageId, containerPath: [], objectIndex: 0 } }] }));
    const requests: AiRequest[] = [];
    await prepareChatContext({ ...input, document, instruction: 'What was the amount?', endpoint: '/fixture',
      fetch: answerFetch(requests, request => `Pages ${request.context.pages?.map(page => page.pageNumber).join(', ')}`) });
    expect(requests.flatMap(request => request.context.pages?.map(page => page.pageNumber) ?? [])).toEqual([1, 2, 3]);
  });
  it('budgets history by UTF-8 bytes and keeps the latest complete exchanges', async () => {
    const input = options();
    input.history = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, text: `Turn${index} ` + '中文'.repeat(8000) }));
    const prepared = await prepareChatContext(input);
    const history = prepared.request.context.history!;
    expect(history.length).toBeLessThan(12); expect(history[0]?.role).toBe('user');
    expect(history.at(-1)?.text).toContain('Turn11');
    expect(new TextEncoder().encode(JSON.stringify(prepared.request)).length).toBeLessThan(512 * 1024);
  });
  it('selects the highest-relevance later passages before applying the reduced material budget', () => {
    const passages = ['query ' + 'x'.repeat(7994), 'query ' + 'y'.repeat(7994), 'query '.repeat(1333), 'query '.repeat(1333)]
      .flatMap((text, index) => passagesForBlock(block(main, index, text), main.pageOrder[0]!, index + 1, main.sourceIds));
    const selected = relevantContextPassages(passages, 'query', 18000);
    expect(selected.map(passage => passage.pageNumber)).toContain(4);
    expect(selected.map(passage => passage.pageNumber)).toContain(3);
    expect(selected.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(18000);
  });
  it('releases successful snapshots but preserves reference-version and closed-generated-source checks', async () => {
    const prepared = await prepareChatContext(options([block(reference, 0, 'Reference text')], [material]));
    const saved: ChatRequestContext = { documentId: main.id, revision: main.revision, scope: 'document', pageId: main.pageOrder[0]!,
      selectedIds: [], visualMode: 'auto', prepared, materials: [material], history: [{ role: 'user', text: 'old text' }] };
    const compact = compactChatContext(saved);
    expect(compact).not.toHaveProperty('prepared'); expect(compact).not.toHaveProperty('materials'); expect(compact).not.toHaveProperty('history');
    expect(canRetryContext(compact, main, () => reference)).toBe(true);
    expect(canRetryContext(compact, main, () => ({ ...reference, revision: 2 }))).toBe(false);
    expect(chatHistory([{ id: 'a', prompt: 'question', status: 'complete', answer: 'answer', requestContext: compact }], 1,
      id => id === main.id ? main : null)).toEqual([]);
    const generated = { ...saved, prepared: undefined, materials: [{ ...material, kind: 'text' as const }] };
    expect(canRetryContext(generated, main, () => null)).toBe(false);
    expect(canRetryContext(generated, main, () => ({ ...reference, revision: 2 }))).toBe(true);
  });
  it('stops nonconverging compression and preserves usable section results', async () => {
    const requests: AiRequest[] = [];
    const summary = 'x'.repeat(12001);
    const result = condenseReading({ document: main, name: 'Test.pdf', endpoint: '/fixture',
      fetch: answerFetch(requests, () => summary), signal: new AbortController().signal,
      currentDocument: () => main, instruction: 'Summarize' }, `${'a'.repeat(12001)}\n\n${'b'.repeat(12001)}`, 1000);
    await expect(result).rejects.toBeInstanceOf(PartialReadingError);
    await expect(result).rejects.toMatchObject({ sections: [summary, summary, summary] });
    expect(requests.length).toBeLessThan(9);
  });
  it('bounds supplementary OCR text in a visual batch with hundreds of small blocks', async () => {
    const requests: AiRequest[] = [];
    await askReading({ document: main, name: 'Scan.pdf', endpoint: '/fixture', fetch: answerFetch(requests, () => 'Read the full image.'),
      signal: new AbortController().signal, currentDocument: () => main, instruction: 'Read the page' },
      Array.from({ length: 400 }, () => 'Text fragment. '.repeat(20)),
      { images: [{ mimeType: 'image/jpeg', data: 'aW1hZ2U=' }], pages: [{ id: main.pageOrder[0]!, pageNumber: 1 }] });
    expect(requests[0]?.context.referenceEvidence!.length).toBeLessThanOrEqual(256);
    expect(requests[0]?.context.referenceEvidence!.reduce((sum, evidence) => sum + evidence.text.length, 0)).toBeLessThanOrEqual(36000);
    expect(requests[0]?.context.images).toHaveLength(1);
  });
  it('does not accept an oversized single summary as a completed compression', async () => {
    const requests: AiRequest[] = [];
    await expect(condenseReading({ document: main, name: 'Test.pdf', endpoint: '/fixture', fetch: answerFetch(requests, () => 'x'.repeat(5000)),
      signal: new AbortController().signal, currentDocument: () => main, instruction: 'Summarize' }, 'x'.repeat(4000), 1000)).rejects.toBeInstanceOf(PartialReadingError);
    expect(requests).toHaveLength(1);
  });
});
