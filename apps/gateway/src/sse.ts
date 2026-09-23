import { aiEventSchema, type AiEvent } from '@pdf-editor/contracts';
import type { ServerResponse } from 'node:http';

export class SseClosedError extends Error {
  constructor() {
    super('SSE connection closed');
    this.name = 'SseClosedError';
  }
}

function eventFrame(event: AiEvent): string {
  const checked = aiEventSchema.parse(event);
  return `event: ${checked.type}\ndata: ${JSON.stringify(checked)}\n\n`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted', 'AbortError');
}

export function startSse(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
  response.flushHeaders();
}

export async function sendEvent(response: ServerResponse, event: AiEvent, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  if (response.destroyed || response.writableEnded) throw new SseClosedError();
  if (response.write(eventFrame(event))) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.removeListener('drain', onDrain);
      response.removeListener('close', onClose);
      response.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new SseClosedError()); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onAbort = (): void => { cleanup(); reject(abortReason(signal)); };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function sendEventBestEffort(response: ServerResponse, event: AiEvent): void {
  if (response.destroyed || response.writableEnded) return;
  if (!response.write(eventFrame(event))) response.destroy();
}

export async function finishSse(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (response.writableFinished) return;
  if (response.destroyed) throw new SseClosedError();
  if (signal.aborted) {
    response.destroy(abortReason(signal));
    throw abortReason(signal);
  }

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
      else reject(new SseClosedError());
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onAbort = (): void => {
      const error = abortReason(signal);
      cleanup();
      response.destroy(error);
      reject(error);
    };
    response.once('finish', onFinish);
    response.once('close', onClose);
    response.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (!response.writableEnded) response.end();
  });
}

export function splitUtf8(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text ? [text] : [];
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (current && bytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function extractAnswerTextPrefix(json: string): string | null {
  const answer = /"kind"\s*:\s*"answer"/.exec(json);
  const match = /"text"\s*:\s*"/.exec(json);
  if (!answer || !match || answer.index > match.index) return null;
  let index = match.index + match[0].length;
  let output = '';
  while (index < json.length) {
    const character = json[index];
    if (character === '"') return output;
    if (character !== '\\') {
      if (character === undefined || character.charCodeAt(0) < 0x20) return output;
      output += character;
      index += 1;
      continue;
    }
    const escape = json[index + 1];
    if (escape === undefined) return output;
    if (escape === 'u') {
      const hex = json.slice(index + 2, index + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return output;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    const escaped: Record<string, string> = {
      '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
    };
    const decoded = escaped[escape];
    if (decoded === undefined) return output;
    output += decoded;
    index += 2;
  }
  return output;
}
