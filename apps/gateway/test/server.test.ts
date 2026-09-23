import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiRequest } from '@pdf-editor/contracts';
import { buildGateway } from '../src/server.js';
import type { GatewayConfig } from '../src/config.js';
import type { ProviderAdapter, ProviderEvent, ProviderInput, ProviderResult } from '../src/provider-types.js';

const config: GatewayConfig = {
  provider: { baseUrl: 'https://example.invalid', model: 'gemini-3.8-flash-high', displayName: 'Gemini Test' },
  credentialName: 'gemini-api-key',
  limits: {
    inFlight: 12, imageInFlight: 2, perIpInFlight: 2, perIpPerMinute: 60,
    textBodyBytes: 512 * 1024, imageBodyBytes: 3 * 1024 * 1024, agentBodyBytes: 3 * 1024 * 1024,
    imageCount: 2, imageFileBytes: 2 * 1024 * 1024, imageLongestEdge: 1536,
    connectTimeoutMs: 10_000, requestTimeoutMs: 2_000,
    upstreamFrameBytes: 1024 * 1024, upstreamStreamBytes: 4 * 1024 * 1024,
    visibleResultBytes: 512 * 1024, maxOutputTokens: 8192, agentMaxOutputTokens: 32_768,
  },
};

const requestBody: AiRequest = {
  protocolVersion: 1,
  requestId: 'request-1',
  feature: 'text.rewrite',
  document: { id: 'doc-1', revision: 3 },
  context: {
    scope: 'selection',
    evidence: [{ id: 'e1', docId: 'doc-1', revision: 3, pageId: 'p1', pageNumber: 1, blockId: 'b1', text: 'source' }],
  },
  instruction: 'rewrite',
  options: {},
};

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body.split(/\n\n/).flatMap(frame => {
    const data = frame.split('\n').find(line => line.startsWith('data: '));
    return data ? [JSON.parse(data.slice(6)) as Record<string, unknown>] : [];
  });
}

function fakeProvider(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    async generate(): Promise<ProviderResult> {
      return {
        text: JSON.stringify({ kind: 'textProposal', replacements: [{ targetEvidenceId: 'e1', text: 'rewritten' }] }),
        finishReason: 'STOP',
        usage: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
      };
    },
    async *stream(): AsyncIterable<ProviderEvent> {
      throw new Error('unexpected stream');
    },
    ...overrides,
  };
}

const openApps: Array<ReturnType<typeof buildGateway>> = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map(app => app.close()));
});

function appWith(provider: ProviderAdapter, overrideConfig = config) {
  const app = buildGateway({ config: overrideConfig, provider, runtimeLogger: { write() {} } });
  openApps.push(app);
  return app;
}

describe('gateway routes', () => {
  it('returns capabilities for all twelve features', async () => {
    const app = appWith(fakeProvider());
    const response = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.features).toHaveLength(12);
    expect(body.model.id).toBe('gemini-3.8-flash-high');
    expect(body.limits.textBodyBytes).toBe(512 * 1024);
  });

  it('emits a validated result envelope, usage, and done', async () => {
    const app = appWith(fakeProvider());
    const response = await app.inject({ method: 'POST', url: '/api/v1/ai/requests', payload: requestBody });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = sseEvents(response.body);
    expect(events.map(event => event.type)).toEqual(['accepted', 'progress', 'result', 'usage', 'done']);
    expect((events[2]?.response as { requestId: string }).requestId).toBe('request-1');
    expect((events[2]?.response as { document: { baseRevision: number } }).document.baseRevision).toBe(3);
  });

  it('rejects an oversized body before invoking the provider', async () => {
    const generate = vi.fn<ProviderAdapter['generate']>();
    const smallConfig: GatewayConfig = { ...config, limits: { ...config.limits, textBodyBytes: 128 } };
    const app = appWith(fakeProvider({ generate }), smallConfig);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/ai/requests',
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify(requestBody),
    });
    expect(response.statusCode).toBe(413);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects schema errors and image-route mismatches', async () => {
    const generate = vi.fn<ProviderAdapter['generate']>();
    const app = appWith(fakeProvider({ generate }));
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/ai/requests', payload: { feature: 'unknown' } });
    expect(invalid.statusCode).toBe(400);

    const imageMismatch = await app.inject({ method: 'POST', url: '/api/v1/ai/image-requests', payload: requestBody });
    expect(imageMismatch.statusCode).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects a second in-flight request from the same IP before provider work', async () => {
    let unblock: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    let calls = 0;
    const provider = fakeProvider({
      async generate(): Promise<ProviderResult> {
        calls += 1;
        markStarted?.();
        await blocked;
        return { text: JSON.stringify({ kind: 'textProposal', replacements: [{ targetEvidenceId: 'e1', text: 'rewritten' }] }), finishReason: 'STOP', usage: null };
      },
    });
    const limitedConfig: GatewayConfig = { ...config, limits: { ...config.limits, perIpInFlight: 1 } };
    const app = appWith(provider, limitedConfig);
    const first = app.inject({ method: 'POST', url: '/api/v1/ai/requests', payload: requestBody });
    await started;
    const second = await app.inject({ method: 'POST', url: '/api/v1/ai/requests', payload: { ...requestBody, requestId: 'request-2' } });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('IP_CONCURRENCY_LIMIT');
    expect(calls).toBe(1);
    unblock?.();
    expect((await first).statusCode).toBe(200);
  });

  it('streams only decoded answer.text fragments and then a cited result', async () => {
    const raw = JSON.stringify({ kind: 'answer', text: 'A "quoted" answer', citations: [{ evidenceId: 'e1', quote: 'source' }] });
    const chunks = [raw.slice(0, 31), raw.slice(31, 36), raw.slice(36, 44), raw.slice(44)];
    const provider = fakeProvider({
      async *stream(_input: ProviderInput): AsyncIterable<ProviderEvent> {
        for (const text of chunks) yield { type: 'text', text };
        yield { type: 'finish', finishReason: 'STOP' };
        yield { type: 'usage', usage: { totalTokenCount: 20 } };
      },
    });
    const app = appWith(provider);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/ai/requests', payload: { ...requestBody, feature: 'document.ask', instruction: 'question' },
    });
    const events = sseEvents(response.body);
    const deltas = events.filter(event => event.type === 'delta').map(event => event.text).join('');
    expect(deltas).toBe('A "quoted" answer');
    expect(events.some(event => event.type === 'result')).toBe(true);
    expect(events.find(event => event.type === 'usage')?.usage).toEqual({ totalTokenCount: 20 });
  });

  it('fails closed when a streamed result is truncated', async () => {
    const provider = fakeProvider({
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: 'text', text: '{"kind":"answer","text":"partial' };
        yield { type: 'finish', finishReason: 'MAX_TOKENS' };
      },
    });
    const app = appWith(provider);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/ai/requests', payload: { ...requestBody, feature: 'document.ask' },
    });
    const events = sseEvents(response.body);
    expect(events.some(event => event.type === 'result')).toBe(false);
    expect(events.find(event => event.type === 'error')?.code).toBe('INVALID_MODEL_OUTPUT');
    expect(events.find(event => event.type === 'usage')?.usage).toBeNull();
    expect(events.findIndex(event => event.type === 'usage')).toBeLessThan(events.findIndex(event => event.type === 'error'));
    expect(events.some(event => event.type === 'done')).toBe(false);
  });

  it('propagates a real client disconnect to the provider signal', async () => {
    let cancelled = false;
    const provider = fakeProvider({
      async *stream(_input: ProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            cancelled = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    });
    const app = appWith(provider);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1', port: address.port, path: '/api/v1/ai/requests', method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, response => {
        response.once('data', () => {
          response.destroy();
          resolve();
        });
      });
      request.once('error', reject);
      request.end(JSON.stringify({ ...requestBody, feature: 'document.ask' }));
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});
