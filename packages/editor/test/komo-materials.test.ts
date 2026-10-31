import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiRequest, DocumentInfo, EngineAdapter, TextBlock } from '@pdf-editor/contracts';
import type { EditorAiContext } from '../src/ui/EditorShell.js';
import type { AiHandoff, AiMaterial } from '../src/ui/text-actions.js';
import { KomoChatPanel } from '../src/ui/KomoChatPanel.js';
import { attachChatHandoff, canRetryContext, chatHistory, createChatSession, createKomoChatStore, freezeChatRequestContext, synchronizeChatOwner } from '../src/ui/komo-chat-state.js';
import { needsFullDocument, prepareChatContext } from '../src/ui/komo-chat-context.js';
import { isMaterialCurrent, materialPassages, prepareMaterials, refreshMaterial, readDocumentMaterial, resolveMaterialCitation, MATERIAL_CLOSED, MATERIAL_SELECTION_CHANGED } from '../src/ui/komo-materials.js';
import { selectionMaterial } from '../src/ui/text-actions.js';

function info(id: string, pages = [`${id}-page`]): DocumentInfo {
  return { id, revision: 2, savedRevision: 2, pageOrder: pages, sourceIds: [`${id}-source`],
    permissions: { copy: true, modify: true, annotate: true, fillForms: true, encrypted: false, signed: false }, capabilities: [] };
}
function block(docId: string, pageId: string, text: string): TextBlock {
  return { id: `${pageId}-block`, pageId, sourceId: `${docId}-source`, sourceObjectIds: ['object'], runs: [{ text, style: {}, sourceObjectIds: ['object'] }],
    bounds: { x: 0, y: 0, width: 100, height: 20 }, transform: [1, 0, 0, 1, 0, 0], editability: 'direct' };
}
function fixture() {
  const primary = info('main'); const reference = info('ref');
  const documents = new Map([[primary.id, primary], [reference.id, reference]]);
  const extract = vi.fn(async ({ docId, pageIds }: { docId: string; pageIds: string[] }) => [block(docId, pageIds[0]!, docId === 'main' ? 'Main original' : 'Reference original')]);
  const engine = { extract, describePage: vi.fn(), render: vi.fn() } as unknown as EngineAdapter;
  const context: EditorAiContext = { document: primary, page: null, name: 'Main.pdf', selectedIds: [], engine, disabled: false,
    documents: [{ id: primary.id, name: 'Main.pdf', info: primary }, { id: reference.id, name: 'Reference.pdf', info: reference }],
    getDocumentInfo: id => documents.get(id) ?? null, onCommitted: vi.fn(), openDocument: vi.fn(), saveDocument: vi.fn(), locateMaterial: vi.fn() };
  const material: AiMaterial = { id: 'material-ref', documentId: reference.id, revision: reference.revision, name: 'Reference.pdf', kind: 'selection',
    text: 'Reference original', generatedText: '参考译文', action: 'translate', sourceLanguage: 'en', targetLanguage: 'zh',
    locations: [{ pageId: 'ref-page', pageNumber: 1, blockId: 'ref-page-block', range: [0, 18], text: 'Reference original' }] };
  return { primary, reference, documents, extract, context, material };
}
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

describe('KOMO material prefill and draft isolation', () => {
  it('adds a handoff without changing the draft or transcript or making requests', () => {
    const { material, context } = fixture();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const session = createChatSession(); session.instruction = 'Existing draft';
    session.exchanges = [{ id: 'past', status: 'complete', prompt: 'Earlier question', answer: 'Earlier answer' }];
    const handoff: AiHandoff = { id: 'handoff', materials: [material], question: 'Explain the translation' };
    const next = attachChatHandoff(session, handoff);
    expect(next.instruction).toBe('Existing draft'); expect(next.exchanges).toBe(session.exchanges);
    expect(next.suggestedQuestions).toEqual(['Explain the translation']);
    expect(attachChatHandoff(next, handoff).materials).toHaveLength(1);
    expect(next.materials[0]?.generatedText).toBe('参考译文');
    expect(next.materials[0]?.locations[0]?.range).toEqual([0, 18]);
    expect(fetch).not.toHaveBeenCalled(); expect(context.engine.extract).not.toHaveBeenCalled();
  });
  it('keeps anonymous prefill across initial login/loading and balance refresh, but isolates other accounts', () => {
    const { material } = fixture();
    const store = createKomoChatStore(); const session = createChatSession();
    session.instruction = 'Unsent draft'; session.materials = [material]; store.sessions.main = session;
    synchronizeChatOwner(store, null); synchronizeChatOwner(store, undefined); synchronizeChatOwner(store, 'alice');
    expect(store.sessions.main?.instruction).toBe('Unsent draft'); expect(store.sessions.main?.materials).toEqual([material]);
    store.sessions.main!.exchanges = [{ id: 'old', prompt: 'Private question', status: 'complete', answer: 'Private answer' }];
    synchronizeChatOwner(store, undefined); synchronizeChatOwner(store, 'alice');
    expect(store.sessions.main?.exchanges).toHaveLength(1);
    synchronizeChatOwner(store, 'bob'); expect(store.sessions).toEqual({});
    expect(store.generation).toBe(1);
    store.sessions.main = { ...createChatSession(), instruction: 'Bob private draft' };
    synchronizeChatOwner(store, null); expect(store.sessions).toEqual({});
  });
  it('shows material cards and keeps the composer editable at zero credits without sending', () => {
    const { material, context } = fixture(); const store = createKomoChatStore();
    store.sessions.main = attachChatHandoff({ ...createChatSession(), instruction: 'Saved draft' }, { id: 'handoff', materials: [material] });
    const fetch = vi.fn();
    const html = renderToStaticMarkup(createElement(KomoChatPanel, { context: { ...context, disabled: true }, store, fetch,
      disabledReason: 'Not enough credits. Open Account to continue.' }));
    expect(html).toContain('Saved draft'); expect(html).toContain('PDF original'); expect(html).toContain('Generated text');
    expect(html).toContain('Reference original'); expect(html).toContain('参考译文'); expect(html).toContain('Remove material');
    expect(html).not.toMatch(/id="komo-question"[^>]*disabled=""/); expect(html).toMatch(/type="submit"[^>]*disabled=""/);
    expect(fetch).not.toHaveBeenCalled(); expect(context.openDocument).not.toHaveBeenCalled();
  });
});

describe('multi-file reference snapshots, versions and retries', () => {
  it('extracts an explicitly chosen background PDF without switching the active document', async () => {
    const { reference, context } = fixture();
    const material = await readDocumentMaterial({ engine: context.engine, document: reference, name: 'Reference.pdf', signal: signal(), currentDocument: () => reference });
    expect(material.documentId).toBe('ref'); expect(material.text).toBe('Reference original');
    expect(context.engine.extract).toHaveBeenCalledWith({ docId: 'ref', pageIds: ['ref-page'] });
    expect(context.document?.id).toBe('main'); expect(context.openDocument).not.toHaveBeenCalled();
  });
  it('keeps real identities and differentiates generated text from verified PDF source', async () => {
    const { context, primary, material } = fixture();
    const prepared = await prepareChatContext({ engine: context.engine, document: primary, page: null, selectedIds: [], scope: 'document',
      visualMode: 'text', instruction: 'Compare', history: [], signal: signal(), materials: [material], materialContext: context });
    expect(prepared.request.document.id).toBe('main');
    expect(prepared.request.context.evidence.every(item => item.docId === 'main')).toBe(true);
    expect(prepared.request.context.referenceEvidence).toMatchObject([
      { docId: 'ref', revision: 2, sourceId: 'ref-source', kind: 'source', text: 'Reference original', characterRange: [0, 18] },
      { docId: 'ref', revision: 2, kind: 'generated', text: '参考译文' },
    ]);
    expect(prepared.request.context.referenceEvidence?.[1]?.characterRange).toBeUndefined();
    expect(prepared.sourceIds).toEqual(['main-source', 'ref-source']);
    const source = resolveMaterialCitation(prepared.request, { evidenceId: 'r1', quote: 'original' }, context);
    expect(source).toMatchObject({ documentId: 'ref', pageId: 'ref-page', kind: 'source', range: { start: 10, end: 18 } });
    const generated = resolveMaterialCitation(prepared.request, { evidenceId: 'r2' }, context);
    expect(generated?.kind).toBe('generated'); expect(generated?.pageId).toBeUndefined(); expect(generated?.range).toBeUndefined();
    expect(resolveMaterialCitation(prepared.request, { evidenceId: 'r1', quote: 'invented' }, context)).toBeNull();
  });
  it('freezes sent materials and the exact request for retry while accepting another handoff', async () => {
    const { context, primary, material, documents, reference } = fixture();
    const prepared = await prepareChatContext({ engine: context.engine, document: primary, page: null, selectedIds: [], scope: 'document', visualMode: 'text',
      instruction: 'Compare', history: [], signal: signal(), materials: [material], materialContext: context });
    const saved = freezeChatRequestContext({ documentId: primary.id, revision: primary.revision, scope: 'document', pageId: null,
      selectedIds: [], visualMode: 'text', materials: [material], prepared });
    const next = attachChatHandoff({ ...createChatSession(), instruction: 'Next question' }, { id: 'next', materials: [{ ...material, id: 'new-material', generatedText: 'New result' }] });
    expect(next.instruction).toBe('Next question'); expect(saved.materials?.[0]?.generatedText).toBe('参考译文');
    expect(saved.prepared?.request).toBe(prepared.request); expect(Object.isFrozen(saved.prepared?.request)).toBe(true);
    expect(canRetryContext(saved, primary, context.getDocumentInfo)).toBe(true);
    const oldAnswer = { id: 'answer', prompt: 'Compare', status: 'complete' as const, answer: 'Saved answer', requestContext: saved };
    documents.set(reference.id, { ...reference, revision: 3 });
    expect(canRetryContext(saved, primary, context.getDocumentInfo)).toBe(false);
    expect(resolveMaterialCitation(prepared.request, { evidenceId: 'r1' }, context)).toBeNull();
    expect(chatHistory([oldAnswer], primary.revision, context.getDocumentInfo)).toEqual([]);
    expect(oldAnswer.answer).toBe('Saved answer'); expect(saved.prepared?.request.context.referenceEvidence?.[0]?.revision).toBe(2);
  });
  it('retains an explicitly attached draft snapshot after its PDF revision changes without fabricating PDF locations', async () => {
    const { context, primary } = fixture();
    const draft: AiMaterial = { id: 'draft', documentId: primary.id, revision: 1, name: 'Draft passage', kind: 'text',
      text: 'Uncommitted paragraph draft', generatedText: '译文草稿', locations: [{ pageId: 'old-page', pageNumber: 1 }] };
    expect(isMaterialCurrent(draft, context)).toBe(true);
    const prepared = await prepareChatContext({ engine: context.engine, document: primary, page: null, selectedIds: [], scope: 'document', visualMode: 'text',
      instruction: 'Discuss this draft', history: [], signal: signal(), materials: [draft], materialContext: context });
    expect(prepared.request.context.sourceDocuments?.filter(source => source.id === primary.id).map(source => source.revision)).toEqual([2, 1]);
    expect(prepared.request.context.referenceEvidence).toMatchObject([
      { docId: primary.id, revision: 1, kind: 'generated', role: 'attached', text: draft.text },
      { docId: primary.id, revision: 1, kind: 'generated', role: 'result', text: draft.generatedText },
    ]);
    const citation = resolveMaterialCitation(prepared.request, { evidenceId: 'r1' }, context);
    expect(citation).toMatchObject({ kind: 'generated', role: 'attached', revision: 1 });
    expect(citation?.pageId).toBeUndefined(); expect(citation?.range).toBeUndefined();
    expect(canRetryContext({ documentId: primary.id, revision: 2, scope: 'document', pageId: null, selectedIds: [], visualMode: 'text', materials: [draft], prepared }, primary, context.getDocumentInfo)).toBe(true);
  });
  it('rejects protected, changed or inaccurately mapped reference material', async () => {
    const { context, material, reference, documents } = fixture();
    await expect(materialPassages({ ...material, text: 'forged' }, context, signal())).rejects.toThrow();
    await expect(materialPassages({ ...material, locations: [{ ...material.locations[0]!, range: [0, 3] }] }, context, signal())).rejects.toThrow();
    documents.set(reference.id, { ...reference, permissions: { ...reference.permissions, copy: false } });
    expect(isMaterialCurrent(material, context)).toBe(false);
    await expect(materialPassages(material, context, signal())).rejects.toThrow();
  });
  it('detects revision changes during background extraction before any send', async () => {
    const { context, material, reference, documents } = fixture();
    vi.mocked(context.engine.extract).mockImplementationOnce(async () => {
      documents.set(reference.id, { ...reference, revision: 4 });
      return [block('ref', 'ref-page', 'Reference original')];
    });
    await expect(materialPassages(material, context, signal())).rejects.toThrow();
  });
});

describe('updated material save and continue', () => {
  function changed() {
    const state = fixture();
    state.documents.set(state.reference.id, { ...state.reference, revision: 3 });
    state.context.confirmMaterialUpdate = vi.fn(async () => 'save' as const);
    state.context.prepareDocument = vi.fn(async docId => ({ status: 'ready' as const,
      document: state.documents.get(docId)!, saveStatus: 'written' as const }));
    return state;
  }
  it('saves the changed reference, remaps its selection and continues without changing the task target', async () => {
    const { context, material, extract } = changed();
    extract.mockImplementation(async ({ docId, pageIds }) => [block(docId, pageIds[0]!, 'Added: Reference original')]);
    const prepared = await prepareMaterials([material], context, signal());
    expect(context.confirmMaterialUpdate).toHaveBeenCalledExactlyOnceWith(['Reference.pdf'], expect.any(AbortSignal));
    expect(context.prepareDocument).toHaveBeenCalledExactlyOnceWith('ref', expect.any(AbortSignal));
    expect(prepared?.[0]).toMatchObject({ id: material.id, revision: 3, generatedText: '参考译文', generatedFromRevision: 2,
      locations: [{ pageId: 'ref-page', blockId: 'ref-page-block', range: [7, 25], text: 'Reference original' }] });
    expect(context.document?.id).toBe('main'); expect(material.revision).toBe(2);
    expect(context.openDocument).not.toHaveBeenCalled();
    const request = await prepareChatContext({ engine: context.engine, document: context.document!, page: null, selectedIds: [], scope: 'document',
      visualMode: 'text', instruction: 'Compare', history: [], signal: signal(), materials: prepared!, materialContext: context });
    expect(request.request.context.referenceEvidence).toMatchObject([
      { revision: 3, kind: 'source', text: 'Reference original', characterRange: [7, 25] },
      { revision: 2, kind: 'generated', text: '参考译文' },
    ]);
  });
  it.each(['download-started', 'written'] as const)('continues after %s without changing savedRevision itself', async saveStatus => {
    const { context, material, documents } = changed();
    context.prepareDocument = vi.fn(async id => ({ status: 'ready', document: documents.get(id)!, saveStatus }));
    expect(await prepareMaterials([material], context, signal())).toHaveLength(1);
    expect(documents.get('ref')?.savedRevision).toBe(2);
  });
  it('keeps materials untouched and does not read or save when confirmation is cancelled', async () => {
    const { context, material, extract } = changed();
    context.confirmMaterialUpdate = vi.fn(async () => 'cancel');
    expect(await prepareMaterials([material], context, signal())).toBeNull();
    expect(context.prepareDocument).not.toHaveBeenCalled(); expect(extract).not.toHaveBeenCalled(); expect(material.revision).toBe(2);
  });
  it('does not continue when the file picker is cancelled or saving fails', async () => {
    const { context, material, extract } = changed();
    context.prepareDocument = vi.fn(async () => ({ status: 'cancelled' }));
    expect(await prepareMaterials([material], context, signal())).toBeNull();
    expect(extract).not.toHaveBeenCalled();
    context.prepareDocument = vi.fn(async () => { throw new Error('Save failed'); });
    await expect(prepareMaterials([material], context, signal())).rejects.toThrow('Save failed');
    expect(material.revision).toBe(2);
  });
  it('rereads the full reference rather than only changing its revision', async () => {
    const { context, material, extract } = changed();
    extract.mockImplementation(async ({ docId, pageIds }) => [block(docId, pageIds[0]!, 'Updated reference')]);
    const prepared = await prepareMaterials([{ ...material, kind: 'document' }], context, signal());
    expect(prepared?.[0]).toMatchObject({ revision: 3, text: 'Updated reference', locations: [{ text: 'Updated reference' }] });
  });
  it('finds the same passage on its stable page after block identities change', async () => {
    const { context, material, extract } = changed();
    extract.mockImplementation(async ({ docId, pageIds }) => [{ ...block(docId, pageIds[0]!, 'Reference original'), id: 'new-block' }]);
    expect((await refreshMaterial(material, context, signal())).locations[0]).toMatchObject({ blockId: 'new-block', range: [0, 18] });
  });
  it.each(['missing', 'ambiguous', 'deleted-page'])('rejects a %s source instead of inventing updated quotation offsets', async scenario => {
    const { context, material, extract, documents, reference } = changed();
    if (scenario === 'deleted-page') documents.set(reference.id, { ...reference, revision: 3, pageOrder: ['new-page'] });
    else extract.mockImplementation(async ({ docId, pageIds }) => [block(docId, pageIds[0]!, scenario === 'missing' ? 'Rewritten passage' : 'Reference original Reference original')]);
    await expect(refreshMaterial(material, context, signal())).rejects.toThrow(MATERIAL_SELECTION_CHANGED);
  });
  it('distinguishes a closed or restricted PDF from a version that can be saved', async () => {
    const { context, material, documents, reference } = changed();
    documents.delete(reference.id);
    await expect(prepareMaterials([material], context, signal())).rejects.toThrow(MATERIAL_CLOSED);
    documents.set(reference.id, { ...reference, permissions: { ...reference.permissions, copy: false } });
    await expect(prepareMaterials([material], context, signal())).rejects.toThrow('does not allow copying');
    expect(context.confirmMaterialUpdate).not.toHaveBeenCalled();
  });
  it('preserves exact source whitespace in selection materials while normalizing action input separately', async () => {
    const { context, material, extract } = fixture();
    const text = 'Reference  original\n';
    const attached = selectionMaterial({ id: 'selection', documentId: 'ref', revision: 2, name: 'Reference.pdf', action: 'explain', targets: [
      { id: 'target', pageId: 'ref-page', pageNumber: 1, objectId: 'object', blockId: 'ref-page-block', range: [0, text.length], text, blockText: text, rects: [], style: {} },
    ] });
    extract.mockImplementation(async ({ docId, pageIds }) => [block(docId, pageIds[0]!, text)]);
    expect(attached.sourceText).toBe(text);
    expect(attached.text).toBe(text.trim());
    expect(await materialPassages(attached, context, signal())).toMatchObject([{ text, range: [0, text.length] }]);
    expect(material.revision).toBe(2);
  });
});

describe('long-document coverage', () => {
  it('uses relevant late-page excerpts rather than failing at the old hard limit', async () => {
    const document = info('long-excerpts', Array.from({ length: 6 }, (_, i) => `p${i + 1}`));
    const engine = { extract: vi.fn(async ({ pageIds }: { pageIds: string[] }) => [block(document.id, pageIds[0]!,
      pageIds[0] === 'p6' ? `Payment terms are net thirty. ${'x'.repeat(7850)}` : 'General introduction. '.repeat(370))]) } as unknown as EngineAdapter;
    const prepared = await prepareChatContext({ engine, document, page: null, selectedIds: [], scope: 'document', visualMode: 'text',
      instruction: 'What are the payment terms?', history: [], signal: signal() });
    expect(prepared.request.context.evidence.some(item => item.pageId === 'p6')).toBe(true);
    expect(prepared.coverage[0]?.kind).toBe('excerpts'); expect(prepared.coverage[0]?.pagesScanned).toBe(6);
    expect(prepared.request.context.sourceDocuments?.[0]?.coverage?.kind).toBe('excerpts');
    expect(engine.extract).toHaveBeenCalledTimes(6);
  });
  it('runs the existing real batch pipeline through the injected authenticated fetch for a full summary', async () => {
    const document = info(`long-batch-${crypto.randomUUID()}`, Array.from({ length: 5 }, (_, i) => `p${i + 1}`));
    const engine = { extract: vi.fn(async ({ pageIds }: { pageIds: string[] }) => [block(document.id, pageIds[0]!, `${pageIds[0]} ${'x'.repeat(7900)}`)]) } as unknown as EngineAdapter;
    const requests: AiRequest[] = [];
    const realFetch = vi.fn(); vi.stubGlobal('fetch', realFetch);
    const authenticatedFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(init!.body as string) as AiRequest; requests.push(request);
      const result = { kind: 'answer', text: request.instruction.includes('Combine these section summaries') ? 'Overview of every page' : `Summary ${request.context.evidence[0]?.pageId}`,
        citations: [{ evidenceId: 'e1' }] };
      const response = { protocolVersion: 1, requestId: request.requestId, document: { id: request.document.id, baseRevision: request.document.revision }, feature: request.feature, result };
      return new Response(`event: result\ndata: ${JSON.stringify({ type: 'result', response })}\n\nevent: done\ndata: ${JSON.stringify({ type: 'done', requestId: request.requestId })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const prepared = await prepareChatContext({ engine, document, page: null, selectedIds: [], scope: 'document', visualMode: 'text',
      instruction: 'Summarize this document', history: [], signal: signal(), endpoint: '/api/v1/ai/requests', fetch: authenticatedFetch });
    expect(needsFullDocument('Summarize this document')).toBe(true);
    expect(requests.length).toBeGreaterThan(1);
    for (const pageId of document.pageOrder) expect(requests.some(request => request.context.evidence.some(item => item.pageId === pageId))).toBe(true);
    expect(prepared.request.context.referenceEvidence?.[0]).toMatchObject({ kind: 'analysis', text: 'Overview of every page' });
    expect(prepared.request.context.referenceEvidence?.[0]?.characterRange).toBeUndefined();
    expect(prepared.coverage[0]).toMatchObject({ kind: 'analysis', pagesScanned: 5 });
    expect(realFetch).not.toHaveBeenCalled();
  });
});
