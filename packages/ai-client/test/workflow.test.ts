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
  it('构建证据后文档版本变化，不发送旧版次请求', async () => {
    const request: AiRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'request-stale',
      feature: 'document.ask',
      document: { id: 'doc-1', revision: 2 },
      context: { scope: 'page', evidence: [{
        id: 'e-1', docId: 'doc-1', revision: 2, pageId: 'page-1', pageNumber: 1,
        blockId: 'block-1', text: '旧版原文',
      }] },
      instruction: '问题',
      options: {},
    };
    const snapshot = createEvidenceSnapshot(request, [{
      evidenceId: 'e-1', sourceId: 'source-1', blockText: '旧版原文',
    }]);
    const authorization = new DocumentAiAuthorization('doc-1');
    authorization.enable(['source-1']);
    const fetch = vi.fn(async () => sseResponse([]));
    const workflow = new AiWorkflow({
      endpoint: 'https://gateway.invalid/api/v1/ai/requests', authorization,
      getCurrentDocument: () => ({ id: 'doc-1', revision: 3 }),
      apply: async () => ({ revision: 4 }), nextTransactionId: () => 'tx-stale', fetch,
    });

    await expect(workflow.run({ request, snapshot, sourceIds: ['source-1'] }))
      .rejects.toThrow('Document changed before AI request');
    expect(fetch).not.toHaveBeenCalled();
  });

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

  it('awaits an async command plan builder before preview and rejects changes during page loading', async () => {
    const request: AiRequest = { protocolVersion: PROTOCOL_VERSION, requestId: 'async-plan',
      feature: 'commands.plan', document: { id: 'doc-1', revision: 2 },
      context: { scope: 'pages', evidence: [], pages: [{ id: 'p1', pageNumber: 1 }],
        availableCommands: ['pages.decorate'] }, instruction: 'Number the page', options: {} };
    const snapshot = createEvidenceSnapshot(request, []);
    const events: AiEvent[] = [
      { type: 'result', response: { protocolVersion: PROTOCOL_VERSION, requestId: 'async-plan',
        feature: 'commands.plan', document: { id: 'doc-1', baseRevision: 2 },
        result: { kind: 'commandPlan', explanation: 'Number page',
          commands: [{ type: 'pages.decorate', pageIds: ['p1'], decoration: 'number' }] } } },
      { type: 'done', requestId: 'async-plan' },
    ];
    const authorization = new DocumentAiAuthorization('doc-1');
    authorization.enable(['source-1']);
    const apply = vi.fn(async () => ({ revision: 3 }));
    const builder = vi.fn(async () => {
      await Promise.resolve();
      return { id: 'tx-async', docId: 'doc-1', baseRevision: 2, source: 'ai' as const,
        commands: [{ type: 'pages.rotate' as const, pageIds: ['p1'], degrees: 90 as const }] };
    });
    const workflow = new AiWorkflow({ endpoint: 'https://gateway.invalid/api/v1/ai/requests', authorization,
      getCurrentDocument: () => ({ id: 'doc-1', revision: 2 }), apply,
      nextTransactionId: () => 'tx-async', fetch: async () => sseResponse(events),
      buildCommandPlanTransaction: builder });
    const result = await workflow.run({ request, snapshot, sourceIds: ['source-1'] });
    expect(builder).toHaveBeenCalledTimes(1);
    expect(result.preview?.transaction.id).toBe('tx-async');
    expect(apply).not.toHaveBeenCalled();

    let lookup = 0;
    const stale = new AiWorkflow({ endpoint: 'https://gateway.invalid/api/v1/ai/requests', authorization,
      getCurrentDocument: () => ({ id: 'doc-1', revision: ++lookup === 1 ? 2 : 3 }), apply,
      nextTransactionId: () => 'tx-async', fetch: async () => sseResponse(events),
      buildCommandPlanTransaction: builder });
    await expect(stale.run({ request, snapshot, sourceIds: ['source-1'] }))
      .rejects.toThrow('Document changed while preparing AI preview');
    expect(apply).not.toHaveBeenCalled();
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
