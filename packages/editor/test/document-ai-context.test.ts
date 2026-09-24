import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiRequest, DocumentInfo, EngineAdapter, TextBlock } from '@pdf-editor/contracts';
import { DocumentAiAuthorization } from '@pdf-editor/ai-client';
import { analyzeFullDocument, isExhaustiveQuestion, passageBatches, passagesForBlock,
  restoreFullDocumentAnalysis, selectRelevantPassages } from '../src/ui/document-ai-context.js';

function block(id: string, pageId: string, text: string): TextBlock {
  return { id, pageId, sourceId: 'source-1', sourceObjectIds: [id],
    runs: [{ text, style: {}, sourceObjectIds: [id] }],
    bounds: { x: 0, y: 0, width: 100, height: 20 },
    transform: [1, 0, 0, 1, 0, 0], editability: 'direct' };
}

const document = { id: 'doc', revision: 2, pageOrder: ['p1', 'p2'], sourceIds: ['source-1'] } as DocumentInfo;

afterEach(() => vi.unstubAllGlobals());

describe('document-wide AI context', () => {
  it('ranks a late-page match instead of silently using the first 24 blocks', () => {
    const passages = Array.from({ length: 30 }, (_, index) =>
      passagesForBlock(block(`b${index}`, index < 29 ? 'p1' : 'p2', index === 29
        ? 'Payment due in thirty days, with late fees.' : `General introduction section ${index}`),
      index < 29 ? 'p1' : 'p2', index < 29 ? 1 : 2, document.sourceIds)[0]!);
    const ranked = selectRelevantPassages(passages, 'When is payment due?');
    expect(ranked.some(item => item.pageId === 'p2')).toBe(true);
    expect(ranked.length).toBeLessThanOrEqual(24);
    expect(isExhaustiveQuestion('List all payment clauses')).toBe(true);
    expect(isExhaustiveQuestion('列出所有付款条款')).toBe(true);
  });

  it('splits long text at grapheme boundaries without losing content', () => {
    const text = `${'a'.repeat(7_999)}👨‍👩‍👧‍👦尾`;
    const passages = passagesForBlock(block('b1', 'p1', text), 'p1', 1, document.sourceIds);
    expect(passages.map(item => item.text).join('')).toBe(text);
    expect(passages).toHaveLength(2);
    expect(passages[1]?.text.startsWith('👨‍👩‍👧‍👦')).toBe(true);
    expect(passageBatches(passages).flat()).toEqual(passages);
  });

  it('analyzes every page and combines section results instead of silently truncating', async () => {
    const requests: AiRequest[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string) as AiRequest;
      requests.push(request);
      const isOverview = request.instruction.includes('Combine these section summaries');
      const response = {
        protocolVersion: 1, requestId: request.requestId,
        document: { id: request.document.id, baseRevision: request.document.revision },
        feature: request.feature,
        result: { kind: 'answer', text: isOverview ? 'Overview covering both pages'
          : `Section includes page ${request.context.evidence[0]?.pageNumber}`, citations: [{ evidenceId: 'e1' }] },
      };
      const frames = [
        `event: result\ndata: ${JSON.stringify({ type: 'result', response })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ type: 'done', requestId: request.requestId })}\n\n`,
      ].join('');
      return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
    }));
    const engine = { extract: vi.fn(async ({ pageIds }: { pageIds: string[] }) =>
      [block(pageIds[0]!, pageIds[0]!, `${pageIds[0]} ${'a'.repeat(7_900)}`)]) } as unknown as EngineAdapter;
    const authorization = new DocumentAiAuthorization(document.id);
    authorization.enable(document.sourceIds);
    const result = await analyzeFullDocument({ engine, document, authorization,
      endpoint: '/api/v1/ai/requests', feature: 'document.summarize', instruction: 'Provide an outline',
      signal: new AbortController().signal, currentDocument: () => ({ id: document.id, revision: document.revision }),
      onProgress() {},
    });
    expect(result.pagesScanned).toBe(2);
    expect(result.passagesScanned).toBe(2);
    expect(requests.some(request => request.context.evidence.some(item => item.pageId === 'p2'))).toBe(true);
    expect(result.overview).toBe('Overview covering both pages');
    expect(result.sections[0]?.citations[0]?.pageId).toBe('p1');
  });

  it('scans irrelevant sections for exhaustive questions without requiring fabricated citations', async () => {
    const requests: AiRequest[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string) as AiRequest;
      requests.push(request);
      const response = { protocolVersion: 1, requestId: request.requestId,
        document: { id: request.document.id, baseRevision: request.document.revision },
        feature: request.feature,
        result: { kind: 'answer', text: 'No relevant evidence in this section', citations: [] } };
      return new Response(`event: result\ndata: ${JSON.stringify({ type: 'result', response })}\n\nevent: done\ndata: ${JSON.stringify({ type: 'done', requestId: request.requestId })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }));
    const engine = { extract: vi.fn(async ({ pageIds }: { pageIds: string[] }) =>
      [block(pageIds[0]!, pageIds[0]!, `${pageIds[0]} ${'a'.repeat(7_900)}`)]) } as unknown as EngineAdapter;
    const authorization = new DocumentAiAuthorization(document.id);
    authorization.enable(document.sourceIds);
    const result = await analyzeFullDocument({ engine, document, authorization,
      endpoint: '/api/v1/ai/requests', feature: 'document.ask', instruction: 'List all payment clauses',
      signal: new AbortController().signal, currentDocument: () => ({ id: document.id, revision: document.revision }),
      onProgress() {},
    });
    expect(result.pagesScanned).toBe(2);
    expect(requests.every(request => request.feature === 'document.summarize')).toBe(true);
    expect(result.sections.every(section => section.citations.length === 0)).toBe(true);
    const restored = await restoreFullDocumentAnalysis(document.id);
    expect(restored?.feature).toBe('document.ask');
    expect(restored?.instruction).toBe('List all payment clauses');
  });

  it('暂停后恢复已完成章节，修订变化时仅重算变更章节和总览', async () => {
    const info = { ...document, id: 'summary-pause-and-refresh' } as DocumentInfo;
    const abort = new AbortController();
    const requests: AiRequest[] = [];
    let interruptSecondSection = true;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string) as AiRequest;
      requests.push(request);
      if (interruptSecondSection && request.context.evidence[0]?.pageId === 'p2') {
        interruptSecondSection = false;
        abort.abort();
        throw new DOMException('Paused', 'AbortError');
      }
      const overview = request.instruction.includes('Combine these section summaries');
      const response = {
        protocolVersion: 1, requestId: request.requestId,
        document: { id: request.document.id, baseRevision: request.document.revision },
        feature: request.feature,
        result: { kind: 'answer', text: overview ? 'Merged overview'
          : `Summary of ${request.context.evidence[0]?.pageId}`, citations: [{ evidenceId: 'e1' }] },
      };
      return new Response(`event: result\ndata: ${JSON.stringify({ type: 'result', response })}\n\nevent: done\ndata: ${JSON.stringify({ type: 'done', requestId: request.requestId })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }));
    let changedSecondPage = false;
    const engine = { extract: vi.fn(async ({ pageIds }: { pageIds: string[] }) => {
      const pageId = pageIds[0]!;
      return [block(pageId, pageId, `${pageId === 'p2' && changedSecondPage ? 'qx' : pageId} ${'a'.repeat(7_900)}`)];
    }) } as unknown as EngineAdapter;
    const authorization = new DocumentAiAuthorization(info.id);
    authorization.enable(info.sourceIds);
    const options = { engine, document: info, authorization, endpoint: '/api/v1/ai/requests',
      feature: 'document.summarize' as const, instruction: 'Provide an outline',
      currentDocument: () => ({ id: info.id, revision: info.revision }), onProgress() {} };

    await expect(analyzeFullDocument({ ...options, signal: abort.signal })).rejects.toThrow();
    const paused = await restoreFullDocumentAnalysis(info.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.analysis).toBeNull();
    expect(requests.map(request => request.context.evidence[0]?.pageId)).toEqual(['p1', 'p2']);

    const resumed = await analyzeFullDocument({ ...options, signal: new AbortController().signal });
    expect(resumed.sections).toHaveLength(2);
    expect(resumed.overview).toBe('Merged overview');
    expect(requests.map(request => request.context.evidence[0]?.pageId)).toEqual(['p1', 'p2', 'p2', 'p1']);
    const snapshot = await restoreFullDocumentAnalysis(info.id);
    expect(snapshot?.status).toBe('completed');
    expect(snapshot?.feature).toBe('document.summarize');
    expect(snapshot?.instruction).toBe('Provide an outline');
    expect(snapshot?.analysis).toEqual(resumed);

    changedSecondPage = true;
    const editedInfo = { ...info, revision: info.revision + 1 } as DocumentInfo;
    const refreshed = await analyzeFullDocument({ ...options, document: editedInfo,
      currentDocument: () => ({ id: editedInfo.id, revision: editedInfo.revision }),
      signal: new AbortController().signal });
    expect(refreshed.document.revision).toBe(editedInfo.revision);
    expect(requests.map(request => request.context.evidence[0]?.pageId)).toEqual(['p1', 'p2', 'p2', 'p1', 'p2', 'p1']);
  });
});
