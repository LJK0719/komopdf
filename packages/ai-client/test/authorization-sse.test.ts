import { describe, expect, it } from 'vitest';
import { AI_LIMITS, PROTOCOL_VERSION, type AiEvent, type AiRequest } from '@pdf-editor/contracts';
import {
  AiAuthorizationError,
  AiClientError,
  DocumentAiAuthorization,
  postAiRequest,
} from '../src/index.js';

const request: AiRequest = {
  protocolVersion: PROTOCOL_VERSION,
  requestId: 'request-1',
  feature: 'document.ask',
  document: { id: 'doc-1', revision: 2 },
  context: { scope: 'document', evidence: [] },
  instruction: '问题',
  options: {},
};

describe('文档授权', () => {
  it('新增来源需要补充授权，撤回会中止所有在途请求', () => {
    const authorization = new DocumentAiAuthorization('doc-1');
    authorization.enable(['source-1']);
    expect(() => authorization.beginRequest('doc-1', ['source-1', 'source-2']))
      .toThrow(expect.objectContaining<Partial<AiAuthorizationError>>({
        code: 'SOURCE_AUTHORIZATION_REQUIRED',
        missingSourceIds: ['source-2'],
      }));

    authorization.authorizeAdditionalSources(['source-2']);
    const first = authorization.beginRequest('doc-1', ['source-1']);
    const second = authorization.beginRequest('doc-1', ['source-2']);
    authorization.revoke();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(authorization.enabled).toBe(false);
    first.release();
    second.release();
  });
});

describe('POST SSE 客户端', () => {
  it('最终 result 不重复计入已经展示过的 delta 预算', async () => {
    const text = 'x'.repeat(300 * 1024);
    const events: AiEvent[] = [
      { type: 'delta', text },
      { type: 'result', response: { protocolVersion: 1, requestId: request.requestId,
        document: { id: 'doc-1', baseRevision: 2 }, feature: 'document.ask', result: { kind: 'answer', text, citations: [] } } },
      { type: 'done', requestId: request.requestId },
    ];
    const result = await postAiRequest({ endpoint: 'https://gateway.invalid/api/v1/ai/requests', request, fetch: async () => sseResponse(events) });
    expect(result.response.result.kind).toBe('answer');
    expect(result.deltaText.length).toBe(text.length);
  });
  it('流结束但缺少 done/error 时不伪装成功', async () => {
    const events: AiEvent[] = [
      { type: 'accepted', requestId: 'request-1' },
      {
        type: 'result',
        response: {
          protocolVersion: PROTOCOL_VERSION,
          requestId: 'request-1',
          document: { id: 'doc-1', baseRevision: 2 },
          feature: 'document.ask',
          result: { kind: 'answer', text: '回答', citations: [] },
        },
      },
    ];
    const fetch = async (): Promise<Response> => sseResponse(events);

    await expect(postAiRequest({ endpoint: 'https://gateway.invalid/api/v1/ai/requests', request, fetch }))
      .rejects.toMatchObject<Partial<AiClientError>>({ code: 'TRUNCATED_SSE' });
  });

  it('result 的请求身份或版本不匹配时立即拒绝', async () => {
    const events: AiEvent[] = [{
      type: 'result',
      response: {
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'request-1',
        document: { id: 'doc-1', baseRevision: 3 },
        feature: 'document.ask',
        result: { kind: 'answer', text: '回答', citations: [] },
      },
    }, { type: 'done', requestId: 'request-1' }];

    await expect(postAiRequest({
      endpoint: 'https://gateway.invalid/api/v1/ai/requests',
      request,
      fetch: async () => sseResponse(events),
    })).rejects.toMatchObject<Partial<AiClientError>>({ code: 'IDENTITY_MISMATCH' });
  });

  it('解析错误提前退出时取消 reader', async () => {
    let cancelled = false;
    const invalidIdentity: AiEvent = {
      type: 'result',
      response: {
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'request-1',
        document: { id: 'doc-1', baseRevision: 99 },
        feature: 'document.ask',
        result: { kind: 'answer', text: '回答', citations: [] },
      },
    };
    const bytes = new TextEncoder().encode(
      `event: result\ndata: ${JSON.stringify(invalidIdentity)}\n\n`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); },
      cancel() { cancelled = true; },
    });

    await expect(postAiRequest({
      endpoint: 'https://gateway.invalid/api/v1/ai/requests',
      request,
      fetch: async () => new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    })).rejects.toMatchObject<Partial<AiClientError>>({ code: 'IDENTITY_MISMATCH' });
    expect(cancelled).toBe(true);
  });

  it('拒绝超过共享聚合可见结果上限的 delta', async () => {
    const half = 'x'.repeat(Math.floor(AI_LIMITS.visibleResultBytes / 2) + 1);
    const events: AiEvent[] = [
      { type: 'delta', text: half },
      { type: 'delta', text: half },
      { type: 'done', requestId: 'request-1' },
    ];
    await expect(postAiRequest({
      endpoint: 'https://gateway.invalid/api/v1/ai/requests',
      request,
      fetch: async () => sseResponse(events),
    })).rejects.toMatchObject<Partial<AiClientError>>({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('拒绝超过共享单帧上限的 SSE 并取消流', async () => {
    let cancelled = false;
    const oversized = `event: progress\ndata: ${'x'.repeat(AI_LIMITS.upstreamBytes + 1)}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(oversized)); },
      cancel() { cancelled = true; },
    });

    await expect(postAiRequest({
      endpoint: 'https://gateway.invalid/api/v1/ai/requests',
      request,
      fetch: async () => new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    })).rejects.toMatchObject<Partial<AiClientError>>({ code: 'RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });
});

function sseResponse(events: readonly AiEvent[]): Response {
  const body = events.map(event =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  ).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}
