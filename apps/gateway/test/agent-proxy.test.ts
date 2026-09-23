import {
  createServer, request as httpRequest,
  type IncomingMessage, type Server, type ServerResponse,
} from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway, type RuntimeLogRecord } from '../src/server.js';
import type { GatewayConfig } from '../src/config.js';
import type { ProviderAdapter, ProviderResult } from '../src/provider-types.js';

const servers: Server[] = [];
const apps: Array<ReturnType<typeof buildGateway>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

async function mockServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing mock address');
  return `http://127.0.0.1:${address.port}`;
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const value of request) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function config(baseUrl: string, overrides: Partial<GatewayConfig['limits']> = {}): GatewayConfig {
  return {
    provider: { baseUrl, model: 'gemini-3.8-flash-high', displayName: 'Gemini Test' },
    credentialName: 'gemini-api-key',
    limits: {
      inFlight: 12, imageInFlight: 2, perIpInFlight: 4, perIpPerMinute: 60,
      textBodyBytes: 512 * 1024, imageBodyBytes: 3 * 1024 * 1024, agentBodyBytes: 3 * 1024 * 1024,
      imageCount: 2, imageFileBytes: 2 * 1024 * 1024, imageLongestEdge: 1536,
      connectTimeoutMs: 1_000, requestTimeoutMs: 2_000,
      upstreamFrameBytes: 1024 * 1024, upstreamStreamBytes: 4 * 1024 * 1024,
      visibleResultBytes: 512 * 1024, maxOutputTokens: 8192, agentMaxOutputTokens: 32_768,
      ...overrides,
    },
  };
}

const provider: ProviderAdapter = {
  async generate(): Promise<ProviderResult> {
    return { text: '{}', finishReason: 'STOP', usage: null };
  },
  async *stream(): AsyncIterable<never> {
    throw new Error('unexpected web provider request');
  },
};

function appFor(baseUrl: string, overrides: Partial<GatewayConfig['limits']> = {}, logs: RuntimeLogRecord[] = []) {
  const app = buildGateway({
    config: config(baseUrl, overrides),
    provider,
    apiKey: 'server-secret',
    runtimeLogger: { write(record) { logs.push(record); } },
  });
  apps.push(app);
  return app;
}

describe('restricted Anthropic agent proxy', () => {
  it('forwards SDK messages, tool results, SSE events, and count_tokens while fixing model and auth', async () => {
    const received: Array<{ path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];
    const stream = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"inspect_page","input":{}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const baseUrl = await mockServer((request, response) => {
      void requestBody(request).then(body => {
        received.push({ path: request.url ?? '', headers: request.headers, body });
        if (request.url === '/v1/messages/count_tokens') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ input_tokens: 19 }));
          return;
        }
        response.setHeader('content-type', 'text/event-stream');
        response.end(stream);
      });
    });
    const logs: RuntimeLogRecord[] = [];
    const app = appFor(baseUrl, {}, logs);
    const tool = {
      name: 'inspect_page', description: 'Inspect one page',
      input_schema: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] },
    };
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_0', name: 'inspect_page', input: { page: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'page result' }] },
    ];
    const response = await app.inject({
      method: 'POST', url: '/api/agent/v1/messages',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer client-secret',
        'x-api-key': 'public-placeholder',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      payload: { model: 'client-chosen-model', max_tokens: 4096, stream: true, system: 'system', tools: [tool], messages },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toBe(stream);
    expect(received[0]?.path).toBe('/v1/messages');
    expect(received[0]?.body).toMatchObject({
      model: 'gemini-3.8-flash-high', max_tokens: 4096, stream: true, system: 'system', tools: [tool], messages,
    });
    expect(received[0]?.headers['x-api-key']).toBe('server-secret');
    expect(received[0]?.headers.authorization).toBeUndefined();
    expect(received[0]?.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');

    const count = await app.inject({
      method: 'POST', url: '/api/agent/v1/messages/count_tokens',
      headers: { 'content-type': 'application/json', 'x-api-key': 'public-placeholder' },
      payload: { model: 'another-client-model', system: 'system', tools: [tool], messages },
    });
    expect(count.statusCode).toBe(200);
    expect(count.json()).toEqual({ input_tokens: 19 });
    expect(received[1]?.path).toBe('/v1/messages/count_tokens');
    expect(received[1]?.body.model).toBe('gemini-3.8-flash-high');
    expect(logs.map(log => [log.feature, log.usage])).toEqual([
      ['agent.messages', { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }],
      ['agent.count_tokens', { promptTokenCount: 19 }],
    ]);
  });

  it('rejects non-JSON, raw PDF documents, server tools, and requests above the output budget', async () => {
    let upstreamCalls = 0;
    const baseUrl = await mockServer((_request, response) => {
      upstreamCalls += 1;
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    });
    const app = appFor(baseUrl, { agentMaxOutputTokens: 64, imageFileBytes: 4 });

    const nonJson = await app.inject({
      method: 'POST', url: '/api/agent/v1/messages',
      headers: { 'content-type': 'text/plain' }, payload: '{}',
    });
    expect(nonJson.statusCode).toBe(415);

    const pdf = await app.inject({
      method: 'POST', url: '/api/agent/v1/messages',
      payload: {
        model: 'ignored', max_tokens: 32, messages: [{ role: 'user', content: [{
          type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
        }] }],
      },
    });
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json().error.message).toContain('document attachments');

    const oversizedImage = await app.inject({
      method: 'POST', url: '/api/agent/v1/messages',
      payload: {
        model: 'ignored', max_tokens: 32, messages: [{ role: 'user', content: [{
          type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.alloc(5).toString('base64') },
        }] }],
      },
    });
    expect(oversizedImage.statusCode).toBe(400);
    expect(oversizedImage.json().error.message).toContain('Image attachment exceeds');

    const serverTool = await app.inject({
      method: 'POST', url: '/api/agent/v1/messages',
      payload: {
        model: 'ignored', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      },
    });
    expect(serverTool.statusCode).toBe(400);

    const oversized = await app.inject({
      method: 'POST', url: '/api/agent/v1/messages',
      payload: { model: 'ignored', max_tokens: 65, messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error.message).toContain('service limit of 64');
    expect(upstreamCalls).toBe(0);
  });

  it('does not expose upstream error bodies or either credential', async () => {
    const baseUrl = await mockServer((_request, response) => {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        error: { message: 'server-secret client-secret Authorization x-api-key' },
      }));
    });
    const app = appFor(baseUrl);
    const response = await app.inject({
      method: 'POST', url: '/api/agent/v1/messages',
      headers: { authorization: 'Bearer client-secret', 'x-api-key': 'client-secret' },
      payload: { model: 'ignored', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('server-secret');
    expect(response.body).not.toContain('client-secret');
    expect(response.body).not.toContain('Authorization');
    expect(response.body).not.toContain('x-api-key');
  });

  it('shares the image concurrency slot and releases it after client cancellation', async () => {
    let startedFirst: (() => void) | undefined;
    let closedFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>(resolve => { startedFirst = resolve; });
    const firstClosed = new Promise<void>(resolve => { closedFirst = resolve; });
    const baseUrl = await mockServer((request, response) => {
      if (request.url === '/v1/messages/count_tokens') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ input_tokens: 2 }));
        return;
      }
      startedFirst?.();
      response.once('close', () => closedFirst?.());
    });
    let cancelled: (() => void) | undefined;
    const cancelledLog = new Promise<void>(resolve => { cancelled = resolve; });
    const app = buildGateway({
      config: config(baseUrl, { imageInFlight: 1 }), provider, apiKey: 'server-secret',
      runtimeLogger: { write(record) { if (record.feature === 'agent.messages' && record.status === 'cancelled') cancelled?.(); } },
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing gateway address');
    const body = Buffer.from(JSON.stringify({
      model: 'ignored', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hold' }],
    }));
    const client = httpRequest({
      host: '127.0.0.1', port: address.port, path: '/api/agent/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) },
    });
    client.on('error', () => {});
    client.end(body);
    await firstStarted;

    const busy = await app.inject({
      method: 'POST', url: '/api/v1/ai/image-requests', payload: {},
    });
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error.code).toBe('GATEWAY_BUSY');

    client.destroy();
    await Promise.all([firstClosed, cancelledLog]);
    const afterCancel = await app.inject({
      method: 'POST', url: '/api/agent/v1/messages/count_tokens',
      payload: { model: 'ignored', messages: [{ role: 'user', content: 'count' }] },
    });
    expect(afterCancel.statusCode).toBe(200);
    expect(afterCancel.json()).toEqual({ input_tokens: 2 });
    expect(client.destroyed).toBe(true);
  });
});
