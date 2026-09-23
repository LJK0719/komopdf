import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type AiEvent, type AiRequest, type AiResponseEnvelope } from '@pdf-editor/contracts';
import {
  AiWorkflow,
  DocumentAiAuthorization,
  createEvidenceSnapshot,
} from '../src/index.js';

it('delta 只展示，完整 result 生成预览且明确接受后才 apply', async () => {
  const request: AiRequest = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: 'request-1',
    feature: 'text.rewrite',
    document: { id: 'doc-1', revision: 2 },
    context: {
      scope: 'selection',
      evidence: [{
        id: 'e-1', docId: 'doc-1', revision: 2, pageId: 'page-1', pageNumber: 1,
        blockId: 'block-1', text: '原文',
      }],
    },
    instruction: '改写',
    options: {},
  };
  const snapshot = createEvidenceSnapshot(request, [{
    evidenceId: 'e-1', sourceId: 'source-1', blockText: '原文',
  }]);
  const events: AiEvent[] = [
    { type: 'delta', text: '半截建议' },
    {
      type: 'result',
      response: {
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'request-1',
        document: { id: 'doc-1', baseRevision: 2 },
        feature: 'text.rewrite',
        result: { kind: 'textProposal', replacements: [{ targetEvidenceId: 'e-1', text: '新文' }] },
      },
    },
    { type: 'done', requestId: 'request-1' },
  ];
  const authorization = new DocumentAiAuthorization('doc-1');
  authorization.enable(['source-1']);
  const apply = vi.fn(async transaction => ({ revision: transaction.baseRevision + 1 }));
  const onDelta = vi.fn();
  const workflow = new AiWorkflow({
    endpoint: 'https://gateway.invalid/api/v1/ai/requests',
    authorization,
    getCurrentDocument: () => ({ id: 'doc-1', revision: 2 }),
    apply,
    nextTransactionId: () => 'tx-1',
    fetch: async () => sseResponse(events),
  });

  const result = await workflow.run({ request, snapshot, sourceIds: ['source-1'], onDelta });
  expect(result.deltaText).toBe('半截建议');
  expect(onDelta).toHaveBeenCalledWith('半截建议');
  expect(apply).not.toHaveBeenCalled();
  expect(result.preview?.transaction.commands[0]).toMatchObject({ type: 'text.replace', text: '新文' });

  await result.preview?.accept();
  expect(apply).toHaveBeenCalledTimes(1);
});

describe('请求与冻结证据绑定', () => {
  it.each(['changed-text', 'added-evidence'] as const)('%s 无法绕过冻结快照', async mutation => {
    const request: AiRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'request-bound',
      feature: 'document.ask',
      document: { id: 'doc-1', revision: 2 },
      context: {
        scope: 'document',
        evidence: [{
          id: 'e-1', docId: 'doc-1', revision: 2, pageId: 'page-1', pageNumber: 1,
          blockId: 'block-1', text: '冻结原文', bounds: [1, 2, 3, 4],
        }],
      },
      instruction: '问题',
      options: {},
    };
    const snapshot = createEvidenceSnapshot(request, [{
      evidenceId: 'e-1', sourceId: 'source-1', blockText: '冻结原文',
    }]);
    const changed = structuredClone(request);
    if (mutation === 'changed-text') {
      const evidence = changed.context.evidence[0];
      if (!evidence) throw new Error('测试证据缺失');
      evidence.text = '篡改文字';
    } else {
      changed.context.evidence.push({
        id: 'e-2', docId: 'doc-1', revision: 2, pageId: 'page-2', pageNumber: 2,
        blockId: 'block-2', text: '新增文字',
      });
    }
    const authorization = new DocumentAiAuthorization('doc-1');
    authorization.enable(['source-1']);
    const fetch = vi.fn(async () => sseResponse([]));
    const workflow = new AiWorkflow({
      endpoint: 'https://gateway.invalid/api/v1/ai/requests',
      authorization,
      getCurrentDocument: () => ({ id: 'doc-1', revision: 2 }),
      apply: async () => ({ revision: 3 }),
      nextTransactionId: () => 'tx-bound',
      fetch,
    });

    await expect(workflow.run({ request: changed, snapshot, sourceIds: ['source-1'] }))
      .rejects.toThrow('AI request content or identity does not match frozen evidence snapshot');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('含图片请求自动路由至 image-requests 路径', async () => {
    const request: AiRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'request-img',
      feature: 'image.explain',
      document: { id: 'doc-1', revision: 2 },
      context: {
        scope: 'selection',
        evidence: [],
        images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
      },
      instruction: '解释图表',
      options: {},
    };
    const snapshot = createEvidenceSnapshot(request, []);
    const events: AiEvent[] = [
      { type: 'result', response: {
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'request-img',
        document: { id: 'doc-1', baseRevision: 2 },
        feature: 'image.explain',
        result: { kind: 'answer', text: '柱状图', citations: [] },
      } },
      { type: 'done', requestId: 'request-img' },
    ];
    let calledUrl: string | URL | undefined;
    const fetch = vi.fn(async (url: string | URL) => {
      calledUrl = url;
      return sseResponse(events);
    });
    const authorization = new DocumentAiAuthorization('doc-1');
    authorization.enable(['source-1']);
    const workflow = new AiWorkflow({
      endpoint: 'https://gateway.invalid/api/v1/ai/requests',
      authorization,
      getCurrentDocument: () => ({ id: 'doc-1', revision: 2 }),
      apply: async () => ({ revision: 3 }),
      nextTransactionId: () => 'tx-img',
      fetch,
    });

    const result = await workflow.run({ request, snapshot, sourceIds: ['source-1'] });
    expect(calledUrl).toBe('https://gateway.invalid/api/v1/ai/image-requests');
    expect(result.response.result).toMatchObject({ kind: 'answer', text: '柱状图' });
  });

  it('createSubsetPreview 支持为部分候选创建预览并仅应用该子集', async () => {
    const request: AiRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'request-sub',
      feature: 'text.rewrite',
      document: { id: 'doc-1', revision: 2 },
      context: {
        scope: 'selection',
        evidence: [
          { id: 'e-1', docId: 'doc-1', revision: 2, pageId: 'p-1', pageNumber: 1, blockId: 'b-1', text: '段落1' },
          { id: 'e-2', docId: 'doc-1', revision: 2, pageId: 'p-1', pageNumber: 1, blockId: 'b-2', text: '段落2' },
        ],
      },
      instruction: '改写',
      options: {},
    };
    const snapshot = createEvidenceSnapshot(request, [
      { evidenceId: 'e-1', sourceId: 'source-1', blockText: '段落1' },
      { evidenceId: 'e-2', sourceId: 'source-1', blockText: '段落2' },
    ]);
    const response: AiResponseEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'request-sub',
      document: { id: 'doc-1', baseRevision: 2 },
      feature: 'text.rewrite',
      result: {
        kind: 'textProposal',
        replacements: [
          { targetEvidenceId: 'e-1', text: '新段落1' },
          { targetEvidenceId: 'e-2', text: '新段落2' },
        ],
      },
    };
    const authorization = new DocumentAiAuthorization('doc-1');
    const apply = vi.fn(async transaction => ({ revision: transaction.baseRevision + 1 }));
    const workflow = new AiWorkflow({
      endpoint: 'https://gateway.invalid/api/v1/ai/requests',
      authorization,
      getCurrentDocument: () => ({ id: 'doc-1', revision: 2 }),
      apply,
      nextTransactionId: () => 'tx-sub-1',
    });

    const subsetPreview = workflow.createSubsetPreview(snapshot, response, ['e-1']);
    expect(subsetPreview.transaction.commands).toHaveLength(1);
    expect(subsetPreview.transaction.commands[0]).toMatchObject({ blockId: 'b-1', text: '新段落1' });
    await subsetPreview.accept();
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

function sseResponse(events: readonly AiEvent[]): Response {
  return new Response(events.map(event =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  ).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}
