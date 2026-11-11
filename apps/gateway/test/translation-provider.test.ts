import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../src/config.js';
import { TranslationProvider } from '../src/translation-provider.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
const input = { systemInstruction: 'Translate. Return JSON.', parts: [{ text: 'Hello' }], responseSchema: {}, maxOutputTokens: 65536 };

describe('low-effort translation provider', () => {
  it('sends the exact Chat Completions effort and streams only visible content, stopping at finish', async () => {
    let received: unknown;
    const server = createServer(async (req, res) => {
      expect(req.url).toBe('/v1/chat/completions');
      expect(req.headers.authorization).toBe('Bearer test-key');
      expect(req.headers['x-goog-api-key']).toBeUndefined();
      let body = ''; for await (const chunk of req) body += chunk;
      received = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'private reasoning' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      // Deliberately leave HTTP open: finish_reason must complete this unbilled request.
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
    const config = { provider: { baseUrl: `http://127.0.0.1:${address.port}`, model: 'gemini-3.8-flash-high' },
      limits: { connectTimeoutMs: 1000, upstreamFrameBytes: 10000, upstreamStreamBytes: 10000 } } as GatewayConfig;
    const events = [];
    for await (const event of new TranslationProvider(config, 'test-key').stream(input, AbortSignal.timeout(2000))) events.push(event);
    expect(events).toEqual([{ type: 'text', text: '你好' }, { type: 'finish', finishReason: 'STOP' }]);
    expect(received).toEqual({ model: 'gemini-3.8-flash-high', reasoning_effort: 'low', stream: true, max_tokens: 65536,
      response_format: { type: 'json_object' }, messages: [{ role: 'system', content: input.systemInstruction }, { role: 'user', content: 'Hello' }] });
  });
});
