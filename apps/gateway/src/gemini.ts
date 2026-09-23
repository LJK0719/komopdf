import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { usageSchema, type AiUsage } from '@pdf-editor/contracts';
import type { GatewayConfig } from './config.js';
import type { ProviderAdapter, ProviderEvent, ProviderInput, ProviderResult } from './provider-types.js';

export class ProviderError extends Error {
  constructor(public readonly code: 'CONNECT_TIMEOUT' | 'UPSTREAM_HTTP' | 'UPSTREAM_PROTOCOL' | 'UPSTREAM_LIMIT', message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

type GeminiPayload = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
    finishReason?: unknown;
  }>;
  usageMetadata?: unknown;
};

function generationBody(input: ProviderInput): Buffer {
  return Buffer.from(JSON.stringify({
    systemInstruction: { parts: [{ text: input.systemInstruction }] },
    contents: [{ role: 'user', parts: input.parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: input.responseSchema,
      maxOutputTokens: input.maxOutputTokens,
    },
  }), 'utf8');
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted', 'AbortError');
}

function openResponse(url: URL, body: Buffer, apiKey: string, signal: AbortSignal, connectTimeoutMs: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST',
      headers: {
        accept: url.searchParams.get('alt') === 'sse' ? 'text/event-stream' : 'application/json',
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
        'x-goog-api-key': apiKey,
      },
    });
    let settled = false;
    let connectTimer: NodeJS.Timeout | undefined;

    const clearConnectTimer = (): void => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = undefined;
    };
    const onAbort = (): void => { request.destroy(abortError(signal)); };
    const removeAbortListener = (): void => signal.removeEventListener('abort', onAbort);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      removeAbortListener();
      reject(error);
    };

    request.once('socket', (socket: Socket | TLSSocket) => {
      const connected = (): void => clearConnectTimer();
      connectTimer = setTimeout(() => {
        request.destroy(new ProviderError('CONNECT_TIMEOUT', 'Upstream connection timed out'));
      }, connectTimeoutMs);
      connectTimer.unref();
      if (!socket.connecting) connected();
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected);
    });
    request.once('response', response => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      response.once('close', removeAbortListener);
      resolve(response);
    });
    request.once('error', error => fail(error));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    request.end(body);
  });
}

function visibleText(payload: GeminiPayload): string {
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter(part => part.thought !== true && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('');
}

function finishReason(payload: GeminiPayload): string | null {
  const value = payload.candidates?.[0]?.finishReason;
  return typeof value === 'string' ? value : null;
}

function usage(metadata: unknown): AiUsage | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const source = metadata as Record<string, unknown>;
  const candidate = {
    ...(Number.isSafeInteger(source.promptTokenCount) && (source.promptTokenCount as number) >= 0 ? { promptTokenCount: source.promptTokenCount as number } : {}),
    ...(Number.isSafeInteger(source.candidatesTokenCount) && (source.candidatesTokenCount as number) >= 0 ? { candidatesTokenCount: source.candidatesTokenCount as number } : {}),
    ...(Number.isSafeInteger(source.thoughtsTokenCount) && (source.thoughtsTokenCount as number) >= 0 ? { thoughtsTokenCount: source.thoughtsTokenCount as number } : {}),
    ...(Number.isSafeInteger(source.totalTokenCount) && (source.totalTokenCount as number) >= 0 ? { totalTokenCount: source.totalTokenCount as number } : {}),
  };
  return Object.keys(candidate).length > 0 ? usageSchema.parse(candidate) : null;
}

async function readJsonResponse(response: IncomingMessage, maxBytes: number): Promise<GeminiPayload> {
  if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
    response.destroy();
    throw new ProviderError('UPSTREAM_HTTP', 'Upstream returned error status');
  }
  const contentType = response.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    response.destroy();
    throw new ProviderError('UPSTREAM_PROTOCOL', 'Upstream returned invalid content type');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      response.destroy();
      throw new ProviderError('UPSTREAM_LIMIT', 'Upstream response exceeded size limit');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as GeminiPayload;
  } catch {
    throw new ProviderError('UPSTREAM_PROTOCOL', 'Upstream returned invalid JSON');
  }
}

function separator(buffer: Buffer): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseSseFrame(frame: Buffer): GeminiPayload | null {
  const data = frame.toString('utf8').split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data) as GeminiPayload;
  } catch {
    throw new ProviderError('UPSTREAM_PROTOCOL', 'Upstream SSE frame is not valid JSON');
  }
}

async function* readSseResponse(response: IncomingMessage, frameBytes: number, totalBytes: number): AsyncGenerator<GeminiPayload> {
  if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
    response.destroy();
    throw new ProviderError('UPSTREAM_HTTP', 'Upstream returned error status');
  }
  const contentType = response.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    response.destroy();
    throw new ProviderError('UPSTREAM_PROTOCOL', 'Upstream did not return SSE');
  }
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let received = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    received += chunk.byteLength;
    if (received > totalBytes) {
      response.destroy();
      throw new ProviderError('UPSTREAM_LIMIT', 'Upstream stream total bytes exceeded limit');
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk], pending.length + chunk.length);
    let boundary = separator(pending);
    while (boundary) {
      const frame = pending.subarray(0, boundary.index);
      pending = pending.subarray(boundary.index + boundary.length);
      if (frame.byteLength > frameBytes) {
        response.destroy();
        throw new ProviderError('UPSTREAM_LIMIT', 'Upstream SSE frame exceeded size limit');
      }
      const payload = parseSseFrame(frame);
      if (payload) yield payload;
      boundary = separator(pending);
    }
    if (pending.byteLength > frameBytes) {
      response.destroy();
      throw new ProviderError('UPSTREAM_LIMIT', 'Upstream SSE frame exceeded size limit');
    }
  }
  if (pending.toString('utf8').trim()) {
    if (pending.byteLength > frameBytes) {
      response.destroy();
      throw new ProviderError('UPSTREAM_LIMIT', 'Upstream SSE frame exceeded size limit');
    }
    const payload = parseSseFrame(pending);
    if (payload) yield payload;
  }
}

export class GeminiNativeAdapter implements ProviderAdapter {
  constructor(private readonly config: GatewayConfig, private readonly apiKey: string) {}

  async generate(input: ProviderInput, signal: AbortSignal): Promise<ProviderResult> {
    const url = new URL(`${this.config.provider.baseUrl}/v1beta/models/${encodeURIComponent(this.config.provider.model)}:generateContent`);
    const response = await openResponse(url, generationBody(input), this.apiKey, signal, this.config.limits.connectTimeoutMs);
    const payload = await readJsonResponse(response, this.config.limits.upstreamFrameBytes);
    return { text: visibleText(payload), finishReason: finishReason(payload), usage: usage(payload.usageMetadata) };
  }

  async *stream(input: ProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const url = new URL(`${this.config.provider.baseUrl}/v1beta/models/${encodeURIComponent(this.config.provider.model)}:streamGenerateContent?alt=sse`);
    const response = await openResponse(url, generationBody(input), this.apiKey, signal, this.config.limits.connectTimeoutMs);
    for await (const payload of readSseResponse(response, this.config.limits.upstreamFrameBytes, this.config.limits.upstreamStreamBytes)) {
      const text = visibleText(payload);
      if (text) yield { type: 'text', text };
      const reason = finishReason(payload);
      if (reason) yield { type: 'finish', finishReason: reason };
      const currentUsage = usage(payload.usageMetadata);
      if (currentUsage) yield { type: 'usage', usage: currentUsage };
    }
  }
}
