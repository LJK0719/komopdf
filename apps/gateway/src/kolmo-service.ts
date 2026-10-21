import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { KolmoJob, KolmoTranslationOptions } from '@pdf-editor/contracts';

const ORIGIN = 'https://www.kolmopdf.com';
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_GLOSSARY_BYTES = 2 * 1024 * 1024;
const STATUSES = new Set(['queued', 'processing', 'succeeded', 'failed', 'cancelled']);

type Options = {
  admit: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  fetch?: typeof fetch;
};
class KolmoError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function invalid(message: string): never { throw new KolmoError(400, message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid KolmoPDF request');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) invalid(`Invalid ${name}`);
  return value;
}
function jobId(value: unknown): string {
  const id = text(value, 'job id', 200);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) invalid('Invalid job id');
  return id;
}
function keyOf(request: FastifyRequest): string {
  return text(request.headers['x-kolmo-api-key'], 'KolmoPDF API key', 512).trim();
}
function optionsOf(value: unknown): KolmoTranslationOptions {
  const valueRecord = record(value);
  const sourceLanguage = text(valueRecord.sourceLanguage, 'source language', 32);
  const targetLanguage = text(valueRecord.targetLanguage, 'target language', 32);
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(sourceLanguage) || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(targetLanguage)) invalid('Invalid language');
  const modes = valueRecord.layoutModes;
  if (!Array.isArray(modes) || modes.length < 1 || modes.length > 2 || new Set(modes).size !== modes.length
    || modes.some(mode => mode !== 'translated_only' && mode !== 'side_by_side')) invalid('Invalid layout modes');
  if (typeof valueRecord.translateImages !== 'boolean' || typeof valueRecord.translateTables !== 'boolean') invalid('Invalid translation options');
  const options: KolmoTranslationOptions = { sourceLanguage, targetLanguage, layoutModes: modes,
    translateImages: valueRecord.translateImages, translateTables: valueRecord.translateTables };
  if (valueRecord.glossary !== undefined) {
    const glossary = record(valueRecord.glossary);
    const name = text(glossary.name, 'glossary filename');
    if (typeof glossary.text !== 'string' || Buffer.byteLength(glossary.text, 'utf8') > MAX_GLOSSARY_BYTES) invalid('Glossary must be UTF-8 CSV up to 2 MiB');
    options.glossary = { name, text: glossary.text };
  }
  return options;
}
function balancePoints(value: unknown): number | null {
  const data = record(value);
  for (const field of ['points', 'available_points', 'balance', 'remaining_points']) {
    if (typeof data[field] === 'number' && Number.isFinite(data[field])) return data[field];
  }
  return null;
}
/** Keep only the public job contract; never relay arbitrary links, headers or upstream diagnostics. */
function publicJob(value: unknown, key: string): KolmoJob {
  const data = record(value);
  const id = jobId(data.id);
  if (typeof data.status !== 'string' || !STATUSES.has(data.status)) throw new KolmoError(502, 'Invalid KolmoPDF job response');
  const clean = (value: unknown): string | undefined => typeof value === 'string' ? value.split(key).join('[redacted]') : undefined;
  const job: KolmoJob = { id, status: data.status as KolmoJob['status'] };
  if (data.progress === null || (typeof data.progress === 'number' && Number.isFinite(data.progress))) job.progress = data.progress;
  for (const field of ['phase', 'message'] as const) { const value = clean(data[field]); if (value !== undefined) job[field] = value; }
  for (const field of ['points_deducted', 'remaining_points'] as const) {
    if (typeof data[field] === 'number' && Number.isFinite(data[field])) job[field] = data[field];
  }
  if (data.error && typeof data.error === 'object') {
    const error = data.error as Record<string, unknown>;
    job.error = { ...(clean(error.message) !== undefined ? { message: clean(error.message)! } : {}),
      ...(clean(error.code) !== undefined ? { code: clean(error.code)! } : {}) };
  }
  if (data.result && typeof data.result === 'object') {
    const result = data.result as Record<string, unknown>;
    job.result = { filename: clean(text(result.filename, 'result filename'))!, kind: clean(text(result.kind, 'result kind', 32))!,
      download_url: `/api/v1/jobs/${id}/download` };
    if (typeof result.content_type === 'string') job.result.content_type = clean(result.content_type)!;
    if (typeof result.bytes === 'number') job.result.bytes = result.bytes;
    if (Array.isArray(result.files)) job.result.files = result.files.map(item => {
      const file = record(item); return { name: clean(text(file.name, 'result member'))!, kind: clean(text(file.kind, 'result member kind', 32))! };
    });
  }
  return job;
}

export function registerKolmoService(app: FastifyInstance, options: Options): void {
  const fetcher = options.fetch ?? globalThis.fetch;
  const route = (method: 'GET' | 'POST', url: string, run: (request: FastifyRequest, reply: FastifyReply, key: string, signal: AbortSignal) => Promise<unknown>, bodyLimit?: number) => {
    app.route({ method, url, ...(bodyLimit ? { bodyLimit } : {}), onRequest: options.admit, handler: async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => { if (!reply.raw.writableEnded) abort(); };
      request.raw.once('aborted', abort); reply.raw.once('close', close);
      try { return await run(request, reply, keyOf(request), controller.signal); }
      catch (error) {
        const status = error instanceof KolmoError ? error.status : 502;
        return reply.code(status).send({ error: { code: 'KOLMO_REQUEST_FAILED', message: error instanceof KolmoError ? error.message : 'Unable to reach KolmoPDF. Try again with the same submission.' } });
      } finally { request.raw.off('aborted', abort); reply.raw.off('close', close); }
    } });
  };
  const upstream = async (path: string, key: string, signal: AbortSignal, init: RequestInit = {}) => {
    const response = await fetcher(`${ORIGIN}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${key}` },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
    if (!response.ok) {
      // Upstream errors can echo credentials or request contents; don't forward them.
      const status = [401, 402, 403, 404, 409, 429].includes(response.status) ? response.status : 502;
      const message = response.status === 402 ? 'KolmoPDF credits or API-key allowance are insufficient.'
        : response.status === 401 || response.status === 403 ? 'Check your KolmoPDF API key.'
          : `KolmoPDF request failed (HTTP ${response.status}).`;
      await response.body?.cancel();
      throw new KolmoError(status, message);
    }
    return response;
  };
  route('GET', '/api/v1/kolmo/balance', async (_request, _reply, key, signal) => ({ configured: true,
    points: balancePoints(await (await upstream('/api/v1/balance', key, signal)).json()) }));
  route('POST', '/api/v1/kolmo/jobs/translate-pdf', async (request, _reply, key, signal) => {
    const body = record(request.body);
    const name = text(body.name, 'PDF filename');
    if (!Number.isInteger(body.pageCount) || (body.pageCount as number) < 1 || (body.pageCount as number) > 800) invalid('PDF must contain 1–800 pages');
    if (typeof body.pdfBase64 !== 'string' || !body.pdfBase64.length || body.pdfBase64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4
      || /[^A-Za-z0-9+/=]/.test(body.pdfBase64)) invalid('Invalid PDF data (maximum 50 MiB)');
    const bytes = Buffer.from(body.pdfBase64, 'base64');
    if (bytes.toString('base64') !== body.pdfBase64 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString() !== '%PDF-') invalid('Expected PDF data up to 50 MiB');
    const idempotencyKey = text(request.headers['idempotency-key'], 'Idempotency-Key', 200);
    const translation = optionsOf(body.options);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
    form.append('sourceLanguage', translation.sourceLanguage); form.append('targetLanguage', translation.targetLanguage);
    form.append('layoutModes', translation.layoutModes.join(','));
    form.append('enable_image_translation', String(translation.translateImages));
    form.append('enable_table_translation', String(translation.translateTables));
    if (translation.glossary) form.append('glossary', new Blob([translation.glossary.text], { type: 'text/csv;charset=utf-8' }), translation.glossary.name);
    return publicJob(await (await upstream('/api/v1/jobs/translate-pdf', key, signal,
      { method: 'POST', body: form, headers: { 'Idempotency-Key': idempotencyKey } })).json(), key);
  }, 74 * 1024 * 1024);
  const idOf = (request: FastifyRequest) => jobId((request.params as { id: string }).id);
  route('GET', '/api/v1/kolmo/jobs/:id', async (request, _reply, key, signal) =>
    publicJob(await (await upstream(`/api/v1/jobs/${idOf(request)}`, key, signal)).json(), key));
  route('POST', '/api/v1/kolmo/jobs/:id/cancel', async (request, _reply, key, signal) =>
    publicJob(await (await upstream(`/api/v1/jobs/${idOf(request)}/cancel`, key, signal, { method: 'POST' })).json(), key));
  route('GET', '/api/v1/kolmo/jobs/:id/download', async (request, reply, key, signal) => {
    const response = await upstream(`/api/v1/jobs/${idOf(request)}/download`, key, signal);
    const mime = response.headers.get('content-type')?.split(';')[0];
    // Result filename/kind come from GET job. Do not forward arbitrary upstream headers.
    const limit = 200 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new KolmoError(413, 'Translation result exceeds the 200 MiB web download limit'); }
    const reader = response.body?.getReader();
    const chunks: Buffer[] = []; let total = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          total += value.byteLength;
          if (total > limit) { await reader.cancel(); throw new KolmoError(413, 'Translation result exceeds the 200 MiB web download limit'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    return reply.type(mime === 'application/pdf' || mime === 'application/zip' ? mime : 'application/octet-stream').send(Buffer.concat(chunks, total));
  });
}
