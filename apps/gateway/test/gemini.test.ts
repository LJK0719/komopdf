import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiNativeAdapter, ProviderError } from '../src/gemini.js';
import type { GatewayConfig } from '../src/config.js';
import type { ProviderInput } from '../src/provider-types.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
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

function config(baseUrl: string, overrides: Partial<GatewayConfig['limits']> = {}): GatewayConfig {
  return {
    provider: { baseUrl, model: 'gemini-3.8-flash-high', displayName: 'Gemini Test' },
    credentialName: 'gemini-api-key',
    limits: {
      inFlight: 12, imageInFlight: 2, perIpInFlight: 2, perIpPerMinute: 60,
      textBodyBytes: 512 * 1024, imageBodyBytes: 3 * 1024 * 1024, agentBodyBytes: 3 * 1024 * 1024,
      imageCount: 2, imageFileBytes: 2 * 1024 * 1024, imageLongestEdge: 1536,
      connectTimeoutMs: 1_000, requestTimeoutMs: 2_000,
      upstreamFrameBytes: 1024 * 1024, upstreamStreamBytes: 4 * 1024 * 1024,
      visibleResultBytes: 512 * 1024, maxOutputTokens: 8192, agentMaxOutputTokens: 32_768,
      ...overrides,
    },
  };
}

const input: ProviderInput = {
  systemInstruction: 'system',
  parts: [{ text: 'user' }],
  responseSchema: { type: 'OBJECT', properties: { kind: { type: 'STRING' } }, required: ['kind'] },
  maxOutputTokens: 100,
};

describe('GeminiNativeAdapter', () => {
  it('parses visible structured output, finish reason, and actual usage', async () => {
    let receivedBody = '';
    const baseUrl = await mockServer((request, response) => {
      expect(request.headers['x-goog-api-key']).toBe('test-key');
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { receivedBody += chunk; });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          candidates: [{
            content: { parts: [{ thought: true, text: 'private thought' }, { text: '{"kind":"answer","text":"visible","citations":[]}' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 7, totalTokenCount: 12 },
        }));
      });
    });
    const adapter = new GeminiNativeAdapter(config(baseUrl), 'test-key');
    const result = await adapter.generate(input, new AbortController().signal);
    expect(result.text).toBe('{"kind":"answer","text":"visible","citations":[]}');
    expect(result.finishReason).toBe('STOP');
    expect(result.usage).toEqual({ promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 7, totalTokenCount: 12 });
    const body = JSON.parse(receivedBody);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toEqual(input.responseSchema);
  });

  it('destroys an upstream error response instead of draining its body', async () => {
    let upstreamClosed = false;
    const baseUrl = await mockServer((_request, response) => {
      response.statusCode = 502;
      response.setHeader('content-type', 'text/plain');
      response.on('close', () => { upstreamClosed = true; });
      response.write('sensitive upstream body');
      const timer = setInterval(() => response.write('more'), 5);
      timer.unref();
      response.on('close', () => clearInterval(timer));
    });
    const adapter = new GeminiNativeAdapter(config(baseUrl), 'test-key');
    await expect(adapter.generate(input, new AbortController().signal)).rejects.toMatchObject<Partial<ProviderError>>({
      code: 'UPSTREAM_HTTP', message: 'Upstream returned error status',
    });
    await vi.waitFor(() => expect(upstreamClosed).toBe(true));
  });

  it('parses SSE frames split across arbitrary network chunks and drops thoughts', async () => {
    const payloads = [
      { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: '{"kind":"answer","text":"hel' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'lo","citations":[]}' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 9 } },
    ];
    const wire = payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('');
    const baseUrl = await mockServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.write(wire.slice(0, 7));
      response.write(wire.slice(7, 31));
      response.write(wire.slice(31, 83));
      response.end(wire.slice(83));
    });
    const adapter = new GeminiNativeAdapter(config(baseUrl), 'test-key');
    const events = [];
    for await (const event of adapter.stream(input, new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: 'text', text: '{"kind":"answer","text":"hel' },
      { type: 'text', text: 'lo","citations":[]}' },
      { type: 'finish', finishReason: 'STOP' },
      { type: 'usage', usage: { totalTokenCount: 9 } },
    ]);
  });

  it('rejects a truncated SSE JSON frame without exposing its body', async () => {
    const baseUrl = await mockServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.end('data: {"candidates":');
    });
    const adapter = new GeminiNativeAdapter(config(baseUrl), 'test-key');
    const consume = async (): Promise<void> => {
      for await (const _event of adapter.stream(input, new AbortController().signal)) { /* consume */ }
    };
    await expect(consume()).rejects.toMatchObject<Partial<ProviderError>>({ code: 'UPSTREAM_PROTOCOL' });
  });

  it('bounds total upstream streaming bytes', async () => {
    const baseUrl = await mockServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ candidates: [] })}\n\n`);
    });
    const adapter = new GeminiNativeAdapter(config(baseUrl, { upstreamStreamBytes: 8 }), 'test-key');
    const consume = async (): Promise<void> => {
      for await (const _event of adapter.stream(input, new AbortController().signal)) { /* consume */ }
    };
    await expect(consume()).rejects.toMatchObject<Partial<ProviderError>>({ code: 'UPSTREAM_LIMIT' });
  });
});
