import {
  AI_LIMITS,
  aiEventSchema,
  aiRequestSchema,
  type AiEvent,
  type AiRequest,
  type AiResponseEnvelope,
  type AiUsage,
} from '@pdf-editor/contracts';

export type AiClientErrorCode =
  | 'HTTP_ERROR'
  | 'INVALID_CONTENT_TYPE'
  | 'MISSING_RESPONSE_BODY'
  | 'INVALID_SSE'
  | 'TRUNCATED_SSE'
  | 'REMOTE_ERROR'
  | 'IDENTITY_MISMATCH'
  | 'RESPONSE_TOO_LARGE'
  | 'MISSING_RESULT';

export class AiClientError extends Error {
  constructor(
    public readonly code: AiClientErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AiClientError';
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PostAiRequestOptions {
  endpoint: string | URL;
  request: AiRequest;
  signal?: AbortSignal;
  fetch?: FetchLike;
  onEvent?: (event: AiEvent) => void;
  onDelta?: (text: string) => void;
}

export interface AiRequestOutcome {
  readonly response: AiResponseEnvelope;
  readonly usage: AiUsage | null | undefined;
  readonly usageReason: string | undefined;
  readonly deltaText: string;
}

export async function postAiRequest(options: PostAiRequestOptions): Promise<AiRequestOutcome> {
  const request = aiRequestSchema.parse(options.request);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(options.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(request),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    throw new AiClientError('HTTP_ERROR', `AI request failed (HTTP ${response.status})`, response.status);
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('text/event-stream')) {
    throw new AiClientError('INVALID_CONTENT_TYPE', 'AI response is not text/event-stream');
  }
  if (!response.body) throw new AiClientError('MISSING_RESPONSE_BODY', 'AI response is missing SSE body');

  let result: AiResponseEnvelope | undefined;
  let usage: AiUsage | null | undefined;
  let usageReason: string | undefined;
  let deltaText = '';
  let visibleBytes = 0;
  let terminal: 'done' | 'error' | undefined;

  for await (const event of parseAiEventStream(response.body)) {
    if (terminal) throw new AiClientError('INVALID_SSE', 'SSE received data after terminal event');
    options.onEvent?.(event);

    switch (event.type) {
      case 'accepted':
        assertRequestId(request, event.requestId);
        break;
      case 'delta':
        visibleBytes += utf8Bytes(event.text);
        if (visibleBytes > AI_LIMITS.visibleResultBytes) {
          throw new AiClientError('RESPONSE_TOO_LARGE', 'Aggregated visible SSE results exceed client limit');
        }
        deltaText += event.text;
        options.onDelta?.(event.text);
        break;
      case 'result':
        if (result) throw new AiClientError('INVALID_SSE', 'SSE returned multiple results');
        // result 重复包含已展示的 delta，不应重复扣减同一输出预算。
        if (utf8Bytes(JSON.stringify(event.response.result)) > AI_LIMITS.visibleResultBytes) {
          throw new AiClientError('RESPONSE_TOO_LARGE', 'Aggregated visible SSE results exceed client limit');
        }
        assertResponseIdentity(request, event.response);
        result = event.response;
        break;
      case 'usage':
        usage = event.usage;
        usageReason = event.reason;
        break;
      case 'done':
        assertRequestId(request, event.requestId);
        terminal = 'done';
        break;
      case 'error':
        terminal = 'error';
        throw new AiClientError('REMOTE_ERROR', `${event.code}: ${event.message}`);
      case 'progress':
        break;
    }
  }

  if (terminal !== 'done') {
    throw new AiClientError('TRUNCATED_SSE', 'SSE ended before done/error');
  }
  if (!result) throw new AiClientError('MISSING_RESULT', 'SSE finished without a complete result');
  return Object.freeze({ response: result, usage, usageReason, deltaText });
}

export async function* parseAiEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<AiEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let reachedEnd = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = findFrameBoundary(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        if (utf8Bytes(frame) > AI_LIMITS.upstreamBytes) {
          throw new AiClientError('RESPONSE_TOO_LARGE', 'Single SSE frame exceeds client limit');
        }
        const event = parseFrame(frame);
        if (event) yield event;
      }
      if (utf8Bytes(buffer) > AI_LIMITS.upstreamBytes) {
        throw new AiClientError('RESPONSE_TOO_LARGE', 'Incomplete SSE frame exceeds client limit');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      throw new AiClientError('TRUNCATED_SSE', 'SSE ended with an incomplete event');
    }
  } catch (error) {
    if (error instanceof AiClientError) throw error;
    throw new AiClientError('INVALID_SSE', error instanceof Error ? error.message : 'Unable to parse SSE');
  } finally {
    if (!reachedEnd) {
      try { await reader.cancel(); } catch { /* 原始协议错误优先。 */ }
    }
    reader.releaseLock();
  }
}

function parseFrame(frame: string): AiEvent | undefined {
  if (frame.trim().length === 0) return undefined;
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    else if (field !== 'id' && field !== 'retry' && field !== '') {
      throw new AiClientError('INVALID_SSE', `Unsupported SSE field: ${field}`);
    }
  }
  if (!eventName || dataLines.length === 0) {
    throw new AiClientError('INVALID_SSE', 'SSE event must include both event and data');
  }

  let data: unknown;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    throw new AiClientError('INVALID_SSE', 'SSE data is not valid JSON');
  }
  const parsed = aiEventSchema.safeParse(data);
  if (!parsed.success) throw new AiClientError('INVALID_SSE', 'SSE data does not match AiEvent schema');
  if (eventName !== parsed.data.type) {
    throw new AiClientError('INVALID_SSE', 'SSE event name does not match AiEvent.type');
  }
  return parsed.data;
}

function assertResponseIdentity(request: AiRequest, response: AiResponseEnvelope): void {
  if (
    response.requestId !== request.requestId ||
    response.document.id !== request.document.id ||
    response.document.baseRevision !== request.document.revision ||
    response.feature !== request.feature ||
    response.protocolVersion !== request.protocolVersion
  ) {
    throw new AiClientError('IDENTITY_MISMATCH', 'AI result identity or revision does not match request');
  }
}

function assertRequestId(request: AiRequest, requestId: string): void {
  if (requestId !== request.requestId) {
    throw new AiClientError('IDENTITY_MISMATCH', 'SSE request ID does not match local request');
  }
}

const utf8Encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function findFrameBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}
