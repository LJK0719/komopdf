import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { AiUsage } from '@pdf-editor/contracts';
import type { GatewayConfig } from './config.js';

export type AnthropicEndpoint = 'messages' | 'count_tokens';
export type AnthropicForwardHeaders = { version?: string; beta?: string };
export type AnthropicForwardResult = {
  usage: AiUsage | null;
  finishReason: string | null;
  streamError: boolean;
  errorType?: string;
};
export type AnthropicForwardRequest = {
  endpoint: AnthropicEndpoint;
  body: Buffer;
  headers: AnthropicForwardHeaders;
  stream: boolean;
  signal: AbortSignal;
  response: ServerResponse;
};

export interface AnthropicForwarder {
  forward(request: AnthropicForwardRequest): Promise<AnthropicForwardResult>;
}

export class AnthropicProxyError extends Error {
  constructor(
    public readonly code: 'CONNECT_TIMEOUT' | 'UPSTREAM_HTTP' | 'UPSTREAM_PROTOCOL' | 'UPSTREAM_LIMIT',
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'AnthropicProxyError';
  }
}

type UsageState = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  thinkingTokens?: number;
};

type StreamState = UsageState & { finishReason: string | null; streamError: boolean; errorType?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function observeUsage(value: unknown, state: UsageState): void {
  const usage = asRecord(value);
  if (!usage) return;
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  const cacheCreationInputTokens = nonNegativeInteger(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = nonNegativeInteger(usage.cache_read_input_tokens);
  const outputDetails = asRecord(usage.output_tokens_details);
  const thinkingTokens = nonNegativeInteger(outputDetails?.thinking_tokens);
  if (inputTokens !== undefined) state.inputTokens = inputTokens;
  if (outputTokens !== undefined) state.outputTokens = outputTokens;
  if (cacheCreationInputTokens !== undefined) state.cacheCreationInputTokens = cacheCreationInputTokens;
  if (cacheReadInputTokens !== undefined) state.cacheReadInputTokens = cacheReadInputTokens;
  if (thinkingTokens !== undefined) state.thinkingTokens = thinkingTokens;
}

function normalizedUsage(state: UsageState): AiUsage | null {
  const hasPromptUsage = state.inputTokens !== undefined;
  const promptTokenCount = (state.inputTokens ?? 0) +
    (state.cacheCreationInputTokens ?? 0) + (state.cacheReadInputTokens ?? 0);
  const candidatesTokenCount = state.outputTokens;
  if (!hasPromptUsage && candidatesTokenCount === undefined && state.thinkingTokens === undefined) return null;
  return {
    ...(hasPromptUsage ? { promptTokenCount } : {}),
    ...(candidatesTokenCount !== undefined ? { candidatesTokenCount } : {}),
    ...(state.thinkingTokens !== undefined ? { thoughtsTokenCount: state.thinkingTokens } : {}),
    ...(hasPromptUsage && candidatesTokenCount !== undefined ? { totalTokenCount: promptTokenCount + candidatesTokenCount } : {}),
  };
}

function observePayload(value: unknown, state: StreamState): void {
  const payload = asRecord(value);
  if (!payload) return;
  if (payload.type === 'error') {
    state.streamError = true;
    const type = asRecord(payload.error)?.type;
    state.errorType = typeof type === 'string' && /^[a-z_]{1,64}$/.test(type) ? type : 'upstream_stream_error';
  }
  const message = asRecord(payload.message);
  const delta = asRecord(payload.delta);
  observeUsage(payload.usage, state);
  observeUsage(message?.usage, state);
  const stopReason = typeof payload.stop_reason === 'string'
    ? payload.stop_reason
    : typeof message?.stop_reason === 'string'
      ? message.stop_reason
      : typeof delta?.stop_reason === 'string'
        ? delta.stop_reason
        : undefined;
  if (stopReason) state.finishReason = stopReason;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted', 'AbortError');
}

function openResponse(
  url: URL,
  body: Buffer,
  apiKey: string,
  headers: AnthropicForwardHeaders,
  signal: AbortSignal,
  connectTimeoutMs: number,
  stream: boolean,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST',
      headers: {
        accept: stream ? 'text/event-stream' : 'application/json',
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
        'x-api-key': apiKey,
        'anthropic-version': headers.version ?? '2023-06-01',
        ...(headers.beta ? { 'anthropic-beta': headers.beta } : {}),
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
        request.destroy(new AnthropicProxyError('CONNECT_TIMEOUT', 'Upstream connection timed out'));
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

async function readJson(response: IncomingMessage, maxBytes: number): Promise<{ bytes: Buffer; value: unknown }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      response.destroy();
      throw new AnthropicProxyError('UPSTREAM_LIMIT', 'Upstream response exceeded size limit');
    }
    chunks.push(chunk);
  }
  const result = Buffer.concat(chunks, bytes);
  try {
    return { bytes: result, value: JSON.parse(result.toString('utf8')) as unknown };
  } catch {
    throw new AnthropicProxyError('UPSTREAM_PROTOCOL', 'Upstream returned invalid JSON');
  }
}

function separator(buffer: Buffer): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function observeSseFrame(frame: Buffer, state: StreamState): void {
  const data = frame.toString('utf8').split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return;
  try {
    observePayload(JSON.parse(data) as unknown, state);
  } catch {
    throw new AnthropicProxyError('UPSTREAM_PROTOCOL', 'Upstream SSE frame is not valid JSON');
  }
}

async function writeChunk(response: ServerResponse, chunk: Buffer, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  if (response.destroyed || response.writableEnded) throw new Error('Downstream connection closed');
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.removeListener('drain', onDrain);
      response.removeListener('close', onClose);
      response.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new Error('Downstream connection closed')); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onAbort = (): void => { cleanup(); reject(abortError(signal)); };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function endResponse(response: ServerResponse, body: Buffer | undefined, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  if (response.destroyed) throw new Error('Downstream connection closed');
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.removeListener('finish', onFinish);
      response.removeListener('close', onClose);
      response.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onFinish = (): void => { cleanup(); resolve(); };
    const onClose = (): void => {
      cleanup();
      if (response.writableFinished) resolve();
      else reject(new Error('Downstream connection closed'));
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onAbort = (): void => {
      const error = abortError(signal);
      cleanup();
      response.destroy(error);
      reject(error);
    };
    response.once('finish', onFinish);
    response.once('close', onClose);
    response.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    response.end(body);
  });
}

function startResponse(response: ServerResponse, statusCode: number, contentType: string, contentLength?: number): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', contentType);
  response.setHeader('cache-control', 'no-store, no-transform');
  response.setHeader('x-accel-buffering', 'no');
  if (contentLength !== undefined) response.setHeader('content-length', String(contentLength));
  response.flushHeaders();
}

export class AnthropicMessagesProxy implements AnthropicForwarder {
  constructor(private readonly config: GatewayConfig, private readonly apiKey: string) {}

  async forward(request: AnthropicForwardRequest): Promise<AnthropicForwardResult> {
    const path = request.endpoint === 'messages' ? '/v1/messages' : '/v1/messages/count_tokens';
    const url = new URL(`${this.config.provider.baseUrl}${path}`);
    const upstream = await openResponse(
      url,
      request.body,
      this.apiKey,
      request.headers,
      request.signal,
      this.config.limits.connectTimeoutMs,
      request.stream,
    );
    const statusCode = upstream.statusCode ?? 502;
    if (statusCode < 200 || statusCode >= 300) {
      upstream.destroy();
      throw new AnthropicProxyError('UPSTREAM_HTTP', 'Upstream returned an error status', statusCode);
    }

    const contentType = String(upstream.headers['content-type'] ?? '').toLowerCase();
    if (request.stream) {
      if (!contentType.includes('text/event-stream')) {
        upstream.destroy();
        throw new AnthropicProxyError('UPSTREAM_PROTOCOL', 'Upstream did not return SSE');
      }
      startResponse(request.response, statusCode, 'text/event-stream; charset=utf-8');
      const state: StreamState = { finishReason: null, streamError: false };
      let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let received = 0;
      for await (const value of upstream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        received += chunk.byteLength;
        if (received > this.config.limits.upstreamStreamBytes) {
          upstream.destroy();
          throw new AnthropicProxyError('UPSTREAM_LIMIT', 'Upstream stream exceeded size limit');
        }
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk], pending.length + chunk.length);
        let boundary = separator(pending);
        while (boundary) {
          const frame = pending.subarray(0, boundary.index);
          pending = pending.subarray(boundary.index + boundary.length);
          if (frame.byteLength > this.config.limits.upstreamFrameBytes) {
            upstream.destroy();
            throw new AnthropicProxyError('UPSTREAM_LIMIT', 'Upstream SSE frame exceeded size limit');
          }
          observeSseFrame(frame, state);
          boundary = separator(pending);
        }
        if (pending.byteLength > this.config.limits.upstreamFrameBytes) {
          upstream.destroy();
          throw new AnthropicProxyError('UPSTREAM_LIMIT', 'Upstream SSE frame exceeded size limit');
        }
        await writeChunk(request.response, chunk, request.signal);
      }
      if (pending.toString('utf8').trim()) observeSseFrame(pending, state);
      await endResponse(request.response, undefined, request.signal);
      return { usage: normalizedUsage(state), finishReason: state.finishReason, streamError: state.streamError, ...(state.errorType ? { errorType: state.errorType } : {}) };
    }

    if (!contentType.includes('application/json')) {
      upstream.destroy();
      throw new AnthropicProxyError('UPSTREAM_PROTOCOL', 'Upstream did not return JSON');
    }
    const result = await readJson(upstream, this.config.limits.upstreamStreamBytes);
    const state: StreamState = { finishReason: null, streamError: false };
    observePayload(result.value, state);
    if (request.endpoint === 'count_tokens') observeUsage(result.value, state);
    startResponse(request.response, statusCode, 'application/json; charset=utf-8', result.bytes.byteLength);
    await endResponse(request.response, result.bytes, request.signal);
    return { usage: normalizedUsage(state), finishReason: state.finishReason, streamError: state.streamError, ...(state.errorType ? { errorType: state.errorType } : {}) };
  }
}
