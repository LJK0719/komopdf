import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_LIMITS, type AiRequest } from '@pdf-editor/contracts';
import { AccountStore, FREE_TOKENS } from '../src/account-store.js';
import { AccountService } from '../src/accounts.js';
import type { AnthropicForwarder } from '../src/anthropic.js';
import type { GatewayConfig } from '../src/config.js';
import type { ProviderAdapter } from '../src/provider-types.js';
import { buildGateway } from '../src/server.js';

const config: GatewayConfig = {
  provider: { baseUrl: 'https://example.invalid', model: 'gemini-3.8-flash-high', displayName: 'test' },
  credentialName: 'test',
  limits: { ...AI_LIMITS, agentBodyBytes: AI_LIMITS.imageBodyBytes, upstreamFrameBytes: AI_LIMITS.upstreamBytes,
    upstreamStreamBytes: AI_LIMITS.upstreamBytes * 4, agentMaxOutputTokens: 32_768 },
};
const usage = { promptTokenCount: 300, candidatesTokenCount: 20, totalTokenCount: 320 };
const largeText = 'x'.repeat(48_000);
const mimeShaped = { mimeType: 'image/png', data: largeText };
const imageShaped = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: largeText } };

// A complete PNG with uncompressed IDAT, large enough to detect counting base64 as text.
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
function pngData(): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(128); header.writeUInt32BE(128, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(128 * (1 + 128 * 3), 127);
  for (let row = 0; row < 128; row += 1) pixels[row * (1 + 128 * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels, { level: 0 })), pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
const imageData = pngData();
const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } };
const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'inspect', input: {} };
const tool = { name: 'inspect', input_schema: { type: 'object', properties: {} } };
const webRequest: AiRequest = {
  protocolVersion: 1, requestId: 'budget-test', feature: 'text.rewrite', document: { id: 'd1', revision: 1 },
  context: { scope: 'selection', evidence: [{ id: 'e1', docId: 'd1', revision: 1, pageId: 'p1', pageNumber: 1, blockId: 'b1', text: 'source' }] },
  instruction: 'rewrite', options: {},
};

const apps: ReturnType<typeof buildGateway>[] = [];
const stores: AccountStore[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function fixture() {
  const store = new AccountStore(':memory:'); stores.push(store);
  const prior = store.reserve('budget-user', 0, FREE_TOKENS - 20_000);
  store.settle(prior.lease, { totalTokenCount: FREE_TOKENS - 20_000 }, true);
  const token = store.createSession('budget-user');
  const accounts = new AccountService(store, {
    publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder', publicOrigin: 'https://example.invalid',
  });
  const reserve = vi.spyOn(accounts, 'reserve');
  const forward = vi.fn<AnthropicForwarder['forward']>(async request => {
    request.response.writeHead(200, { 'content-type': 'application/json' });
    request.response.end(JSON.stringify({ content: [], stop_reason: 'end_turn' }));
    return { usage, finishReason: 'end_turn', streamError: false };
  });
  const generate = vi.fn<ProviderAdapter['generate']>(async input => ({
    text: JSON.stringify(input.parts.some(part => 'inlineData' in part)
      ? { kind: 'answer', text: 'A grey square.', citations: [] }
      : { kind: 'textProposal', replacements: [{ targetEvidenceId: 'e1', text: 'rewritten' }] }),
    finishReason: 'STOP', usage,
  }));
  const app = buildGateway({ config, accounts, agentProxy: { forward },
    provider: { generate, async *stream() { throw new Error('Unexpected streaming request'); } }, runtimeLogger: { write() {} } });
  apps.push(app);
  return { app, store, forward, generate, reserve, headers: { authorization: `Bearer ${token}` } };
}

function agentBody(input: unknown) {
  return { max_tokens: 1000, tools: [tool], messages: [{ role: 'assistant', content: [{ ...toolUse, input }] }] };
}

describe('validated image sources in input token reservations (in-memory accounts, stub upstreams)', () => {
  it.each([
    ['ordinary data', { data: largeText }],
    ['MIME-shaped metadata', { metadata: mimeShaped }],
    ['arbitrary image MIME', { metadata: { mimeType: 'image/not-real', data: largeText } }],
    ['Anthropic-image-shaped JSON', { attachment: imageShaped }],
    ['nested tool-result-shaped JSON', { type: 'tool_result', content: [imageShaped] }],
  ])('counts all tool_use.input JSON: %s', async (_name, input) => {
    const { app, store, forward, reserve, headers } = fixture();
    const response = await app.inject({ method: 'POST', url: '/api/agent/v1/messages', headers, payload: agentBody(input) });
    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe('CREDITS_EXHAUSTED');
    expect(reserve.mock.calls[0]![1]).toBeGreaterThan(largeText.length);
    expect(forward).not.toHaveBeenCalled();
    expect(store.pending('budget-user')).toBe(0);
    expect(store.snapshot('budget-user').remainingCredits).toBe(2);
  });

  it.each([
    ['tool schema MIME object', { tools: [{ ...tool, input_schema: { type: 'object', default: mimeShaped } }] }],
    ['tool schema image object', { tools: [{ ...tool, input_schema: { type: 'object', default: imageShaped } }] }],
    ['text block metadata', { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', metadata: imageShaped }] }] }],
    ['image-shaped text', { messages: [{ role: 'user', content: JSON.stringify(imageShaped) }] }],
    ['tool result metadata', { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result', metadata: mimeShaped }] }] }],
  ])('does not recognize fake attachments in %s', async (_name, fields) => {
    const { app, forward, headers } = fixture();
    const response = await app.inject({ method: 'POST', url: '/api/agent/v1/messages', headers,
      payload: { max_tokens: 1000, messages: [], ...fields } });
    expect(response.statusCode).toBe(402);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    ['message', { messages: [{ role: 'user', content: [imageBlock] }] }],
    ['system', { system: [imageBlock], messages: [{ role: 'user', content: 'describe' }] }],
    ['tool result', { messages: [
      { role: 'assistant', content: [toolUse] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [imageBlock] }] },
    ] }],
  ])('forwards a validated %s image without charging base64 as text', async (_name, fields) => {
    const { app, store, forward, reserve, headers } = fixture();
    const payload = { max_tokens: 32_768, tools: [tool], ...fields };
    const response = await app.inject({ method: 'POST', url: '/api/agent/v1/messages', headers, payload });
    expect(response.statusCode).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
    const inputBound = reserve.mock.calls[0]![1];
    expect(inputBound).toBeGreaterThan(16_384);
    expect(inputBound).toBeLessThan(20_000);
    const sent = JSON.parse(forward.mock.calls[0]![0].body.toString('utf8'));
    expect(sent).toMatchObject(fields);
    expect(sent.max_tokens).toBe(20_000 - inputBound);
    expect(store.pending('budget-user')).toBe(0);
    expect(store.snapshot('budget-user').remainingCredits).toBe(1.968);
  });

  it('counts fake image metadata alongside a real image', async () => {
    const { app, forward, headers } = fixture();
    const response = await app.inject({ method: 'POST', url: '/api/agent/v1/messages', headers,
      payload: { max_tokens: 1000, messages: [{ role: 'user', content: [{ ...imageBlock, metadata: mimeShaped }] }] } });
    expect(response.statusCode).toBe(402);
    expect(forward).not.toHaveBeenCalled();
  });

  it('does not treat an object-valued tool result content as an attachment list', async () => {
    const { app, forward, headers } = fixture();
    const response = await app.inject({ method: 'POST', url: '/api/agent/v1/messages', headers,
      payload: { max_tokens: 1000, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: imageShaped }] }] } });
    expect(response.statusCode).toBe(402);
    expect(forward).not.toHaveBeenCalled();
  });

  it('preserves web text-route reservation and actual usage settlement', async () => {
    const { app, store, generate, reserve, headers } = fixture();
    const response = await app.inject({ method: 'POST', url: '/api/v1/ai/requests', headers, payload: webRequest });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"done"');
    expect(reserve.mock.calls[0]![1]).toBe(Buffer.byteLength(JSON.stringify(webRequest)) + 8192);
    expect(generate).toHaveBeenCalledOnce();
    expect(store.snapshot('budget-user').remainingCredits).toBe(1.968);
  });

  it('excludes only schema-validated context.images on the web image route', async () => {
    const { app, store, generate, reserve, headers } = fixture();
    const payload: AiRequest = { ...webRequest, feature: 'image.explain',
      context: { scope: 'selection', evidence: [], images: [{ mimeType: 'image/png', data: imageData }] } };
    const response = await app.inject({ method: 'POST', url: '/api/v1/ai/image-requests', headers, payload });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"done"');
    const inputBound = reserve.mock.calls[0]![1];
    expect(inputBound).toBeGreaterThan(16_384);
    expect(inputBound).toBeLessThan(20_000);
    expect(generate.mock.calls[0]![0].parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: imageData } });
    expect(generate.mock.calls[0]![0].maxOutputTokens).toBe(20_000 - inputBound);
    expect(store.snapshot('budget-user').remainingCredits).toBe(1.968);
  });

  it('counts image-shaped strings in web text fields', async () => {
    const { app, generate, headers } = fixture();
    const payload: AiRequest = { ...webRequest, options: { terminology: { fakeImage: JSON.stringify(mimeShaped) } } };
    const response = await app.inject({ method: 'POST', url: '/api/v1/ai/requests', headers, payload });
    expect(response.statusCode).toBe(402);
    expect(generate).not.toHaveBeenCalled();
  });
});
