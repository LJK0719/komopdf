import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AiRequest } from '@pdf-editor/contracts';
import { parseAiEventStream, postAiRequest } from '../../../packages/ai-client/src/sse.js';
import { loadGatewayConfig } from '../src/config.js';
import { GeminiNativeAdapter, ProviderError } from '../src/gemini.js';
import { mergeUsage, type ProviderAdapter, type ProviderEvent } from '../src/provider-types.js';
import { buildGateway, type RuntimeLogRecord } from '../src/server.js';
import { AccountStore } from '../src/account-store.js';
import type { AccountService } from '../src/accounts.js';
import { prepareProviderInput } from '../src/templates.js';
import { parseAndValidateResult } from '../src/validation.js';

const config = () => loadGatewayConfig(fileURLToPath(new URL('../gateway.config.json', import.meta.url)));
const request: AiRequest = { protocolVersion: 1, requestId: 'lifecycle', feature: 'document.ask', document: { id: 'd', revision: 1 },
  context: { scope: 'document', evidence: [{ id: 'e1', docId: 'd', revision: 1, pageId: 'p', pageNumber: 1, blockId: 'b', text: 'Source text' }] },
  instruction: 'Explain the document', options: {} };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const input = prepareProviderInput(request, 1000).input;
const answer = JSON.stringify({ kind: 'answer', text: 'Complete answer', citations: [] });

async function withProviderServer(send: (response: import('node:http').ServerResponse) => void, run: (adapter: GeminiNativeAdapter) => Promise<void>) {
  const server = createServer((request, response) => { request.resume(); response.setHeader('content-type', 'text/event-stream'); send(response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const cfg = await config(); cfg.provider.baseUrl = `http://127.0.0.1:${address.port}`;
  try { await run(new GeminiNativeAdapter(cfg, 'test-only')); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const collect = async (adapter: GeminiNativeAdapter) => {
  const events: ProviderEvent[] = [];
  for await (const event of adapter.stream(input, AbortSignal.timeout(3000))) events.push(event);
  return events;
};

describe('conversation completion and accounting', () => {
  it('finishes on STOP plus final usage without waiting for HTTP EOF', async () => {
    await withProviderServer(response => response.write(frame({ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 9 } })), async adapter => {
      const events = await collect(adapter);
      expect(events).toContainEqual({ type: 'finish', finishReason: 'STOP' });
      expect(events).toContainEqual({ type: 'usage', usage: { totalTokenCount: 9 } });
    });
  });
  it('retains separate trailing usage and honors DONE without EOF', async () => {
    await withProviderServer(response => {
      response.write(frame({ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] }));
      setTimeout(() => response.write(frame({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 6 } }) + 'data: [DONE]\n\n'), 10);
    }, async adapter => {
      const events = await collect(adapter);
      expect(events.at(-1)).toEqual({ type: 'usage', usage: { promptTokenCount: 3, candidatesTokenCount: 6 } });
    });
  });
  it('bounds the post-STOP wait when a proxy never sends usage or EOF', async () => {
    await withProviderServer(response => response.write(frame({ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] })),
      async adapter => { expect((await collect(adapter)).at(-1)).toEqual({ type: 'finish', finishReason: 'STOP' }); });
  });
  it('does not synthesize STOP for a prematurely terminated stream', async () => {
    await withProviderServer(response => response.write(frame({ candidates: [{ content: { parts: [{ text: answer }] } }] }) + 'data: [DONE]\n\n'),
      async adapter => { expect((await collect(adapter)).some(event => event.type === 'finish')).toBe(false); });
  });
  it('preserves an upstream HTTP status without exposing its body', async () => {
    await withProviderServer(response => { response.statusCode = 429; response.end('private body'); }, async adapter => {
      await expect(collect(adapter)).rejects.toMatchObject({ code: 'UPSTREAM_HTTP', upstreamStatus: 429, message: 'Upstream returned error status' });
    });
  });
  it('merges cumulative usage fields without adding duplicate frames or losing partial fields', () => {
    let usage = mergeUsage(null, { promptTokenCount: 1000 });
    usage = mergeUsage(usage, { candidatesTokenCount: 100 });
    expect(mergeUsage(usage, { candidatesTokenCount: 100 })).toEqual({ promptTokenCount: 1000, candidatesTokenCount: 100 });
    expect(mergeUsage(usage, { totalTokenCount: 1100 })).toEqual({ promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 });
    expect(mergeUsage(null, { totalTokenCount: 0 })).toEqual({ totalTokenCount: 0 });
  });
  it.each(['text.rewrite', 'document.translate', 'document.extract', 'commands.plan'] as const)('keeps %s at one root object while enforcing its output contract', feature => {
    const current = { ...request, feature, context: { ...request.context, availableCommands: ['pages.rotate'], pages: [{ id: 'p', pageNumber: 1 }] } };
    const prepared = prepareProviderInput(current, 1000);
    expect(prepared.input.responseSchema.type).toBe('OBJECT');
    expect(prepared.input.responseSchema).not.toHaveProperty('anyOf');
    expect(parseAndValidateResult('{"kind":"clarification","question":"Which page?"}', current, prepared.expectedKind, prepared.allowedCommands, 10000).kind).toBe('clarification');
    expect(() => parseAndValidateResult(JSON.stringify({ kind: prepared.expectedKind }), current, prepared.expectedKind, prepared.allowedCommands, 10000)).toThrow();
  });
  it('returns after client result/done and cancels the still-open reader', async () => {
    let cancelled = false;
    const events = [{ type: 'accepted', requestId: request.requestId }, { type: 'result', response: { protocolVersion: 1, requestId: request.requestId,
      document: { id: 'd', baseRevision: 1 }, feature: request.feature, result: { kind: 'answer', text: 'Complete', citations: [] } } },
      { type: 'done', requestId: request.requestId }];
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')));
    }, cancel() { cancelled = true; } });
    const outcome = await postAiRequest({ endpoint: '/fixture', request,
      fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
    expect(outcome.response.result).toMatchObject({ text: 'Complete' }); expect(cancelled).toBe(true);
  });
  it.each([[429, 'RATE_LIMIT'], [413, 'PAYLOAD_TOO_LARGE'], [400, 'INVALID_REQUEST'], [504, 'UPSTREAM_TIMEOUT']] as const)('classifies upstream HTTP %s through SSE', async (status, code) => {
    const app = buildGateway({ config: await config(), allowUnauthenticatedForTests: true, runtimeLogger: { write() {} }, provider: {
      async generate() { throw new Error('unused'); }, async *stream() { throw new ProviderError('UPSTREAM_HTTP', 'private', status); },
    } });
    try {
      await expect(postAiRequest({ endpoint: '/fixture', request, fetch: async (_url, init) => {
        const response = await app.inject({ method: 'POST', url: '/api/v1/ai/requests', headers: { 'content-type': 'application/json' }, payload: init?.body as string });
        return new Response(response.body, { headers: { 'content-type': 'text/event-stream' } });
      } })).rejects.toMatchObject({ code: 'REMOTE_ERROR', message: expect.stringContaining(`${code}:`) });
    } finally { await app.close(); }
  });
  it('holds unrecognized identity claims across chunks until final protection', async () => {
    const cfg = await config();
    const raw = JSON.stringify({ kind: 'answer', text: `Here is a description. I am ${cfg.provider.model}. ${'More text. '.repeat(40)}`, citations: [] });
    const provider: ProviderAdapter = { async generate() { throw new Error('unused'); }, async *stream() {
      for (const text of raw) yield { type: 'text', text };
      yield { type: 'finish', finishReason: 'STOP' };
    } };
    const app = buildGateway({ config: cfg, allowUnauthenticatedForTests: true, provider, runtimeLogger: { write() {} } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/ai/requests', payload: request });
      expect(response.body).not.toContain(cfg.provider.model);
      expect(response.body).toContain('clarification');
    } finally { await app.close(); }
  });
  it('bills only delivered output on cancellation without usage, once and bounded', async () => {
    const store = new AccountStore(':memory:');
    const accounts = { store, register() {}, authenticate: async () => 'u',
      reserve: (id: string, bytes: number, output: number, minimum: number) => store.reserve(id, bytes, output, minimum),
    } as unknown as AccountService;
    let resolve!: (value: RuntimeLogRecord) => void;
    const finished = new Promise<RuntimeLogRecord>(done => { resolve = done; });
    const provider: ProviderAdapter = { async generate() { throw new Error('unused'); }, async *stream(_input, signal) {
      yield { type: 'text', text: '{"kind":"answer","text":"' + 'Useful answer. '.repeat(40) };
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } };
    const app = buildGateway({ config: await config(), accounts, provider, runtimeLogger: { write: resolve } });
    const abort = new AbortController();
    try {
      const url = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${url}/api/v1/ai/requests`, { method: 'POST', signal: abort.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      let text = '';
      for await (const event of parseAiEventStream(response.body!)) if (event.type === 'delta') { text += event.text; abort.abort(); break; }
      const log = await finished;
      expect(store.user('u').spent).toBe(Math.ceil(Buffer.byteLength(text) / 4));
      expect(log.estimatedOutputTokens).toBe(store.user('u').spent);
      const lease = store.reserve('zero', 100, 100).lease;
      store.settle(lease, { totalTokenCount: 0 }, false, 50); expect(store.user('zero').spent).toBe(0);
      const bounded = store.reserve('bounded', 100, 100).lease;
      store.settle(bounded, null, false, 999); store.settle(bounded, null, false, 999);
      expect(store.user('bounded').spent).toBe(200);
    } finally { abort.abort(); await app.close(); store.close(); }
  });
});
