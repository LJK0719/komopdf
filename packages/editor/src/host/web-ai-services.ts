import { unzipSync } from 'fflate';
import {
  WEB_LIMITS, textActionRequestSchema, textActionResultSchema,
  type EditorAiServices, type KolmoConnection, type KolmoDocumentInput, type KolmoFile,
  type KolmoJob, type KolmoSavedJob, type KolmoTranslationOptions, type TextActionRequest, type TextActionResult,
} from '@pdf-editor/contracts';

const STORAGE_KEY = 'komopdf.kolmo-jobs.v1';
const CONNECTION_KEY = 'komopdf.kolmo-key.v1';
const MAX_RESULT_BYTES = 200 * 1024 * 1024;
type JobStorage = Pick<Storage, 'getItem' | 'setItem'>;
type Options = { fetch?: typeof fetch; storage?: JobStorage | null };
function browserStorage(): JobStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
function idPath(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid KolmoPDF job id');
  return `/api/v1/kolmo/jobs/${id}`;
}
function base64(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  const parts: string[] = [];
  for (let offset = 0; offset < data.length; offset += 0x8000) parts.push(String.fromCharCode(...data.subarray(offset, offset + 0x8000)));
  return btoa(parts.join(''));
}
function clone<T>(value: T): T { return structuredClone(value); }

export class WebAiServices implements EditorAiServices {
  private key = '';
  private connectionVersion = 0;
  private readonly listeners = new Set<() => void>();
  private readonly fetcher: typeof fetch;
  private readonly storage: JobStorage | null;
  private readonly jobs = new Map<string, KolmoSavedJob>();

  constructor(options: Options = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    try {
      this.key = this.storage?.getItem(CONNECTION_KEY) ?? '';
      const stored: unknown = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? 'null');
      if (stored && typeof stored === 'object' && 'version' in stored && stored.version === 1 && 'jobs' in stored && Array.isArray(stored.jobs)) {
        for (const entry of stored.jobs as KolmoSavedJob[]) {
          if (entry?.job && /^[A-Za-z0-9_-]{1,200}$/.test(entry.job.id)
            && ['queued', 'processing', 'succeeded', 'failed', 'cancelled'].includes(entry.job.status)
            && typeof entry.name === 'string' && typeof entry.createdAt === 'number' && typeof entry.documentId === 'string' && Number.isInteger(entry.revision)) {
            this.jobs.set(entry.job.id, entry);
          }
        }
      }
    } catch { /* Retain current-session service access when storage is unavailable. */ }
  }

  async textAction(request: TextActionRequest, signal: AbortSignal): Promise<TextActionResult> {
    signal.throwIfAborted();
    const body = JSON.stringify(textActionRequestSchema.parse(request));
    try {
      const response = await this.request('/api/v1/ai/text-actions', { method: 'POST', body,
        headers: { 'content-type': 'application/json' }, signal });
      return textActionResultSchema.parse(await response.json());
    } catch (error) {
      if (!signal.aborted && error instanceof TypeError) throw new Error('Unable to connect to the AI service. Check your connection and try again.');
      throw error;
    }
  }

  async kolmoConnection(signal?: AbortSignal): Promise<KolmoConnection> {
    signal?.throwIfAborted();
    if (!this.key) return { configured: false, points: null };
    const key = this.key;
    const result = await (await this.request('/api/v1/kolmo/balance', { ...(signal ? { signal } : {}) }, key)).json() as KolmoConnection;
    if (key !== this.key) throw new DOMException('Connection changed', 'AbortError');
    return result;
  }

  async configureKolmo(key: string): Promise<KolmoConnection> {
    const version = ++this.connectionVersion;
    const candidate = key.trim();
    if (candidate.length > 512 || /[\r\n\0]/.test(candidate)) throw new Error('Invalid KolmoPDF API key');
    const result: KolmoConnection = candidate
      ? await (await this.request('/api/v1/kolmo/balance', {}, candidate)).json() as KolmoConnection
      : { configured: false, points: null };
    if (version !== this.connectionVersion) throw new DOMException('Connection changed', 'AbortError');
    if (candidate && !result.configured) throw new Error('Unable to verify the KolmoPDF API key');
    this.key = candidate;
    try { this.storage?.setItem(CONNECTION_KEY, candidate); } catch { /* Current connection remains usable. */ }
    this.listeners.forEach(listener => listener());
    return result;
  }

  async subscribeKolmoConnection(listener: () => void): Promise<() => void> {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  translateDocument(input: KolmoDocumentInput, options: KolmoTranslationOptions, submissionId: string, signal: AbortSignal): Promise<KolmoJob> {
    return this.submitDocument('translate', input, submissionId, signal, options);
  }

  parseDocument(input: KolmoDocumentInput, submissionId: string, signal: AbortSignal): Promise<KolmoJob> {
    return this.submitDocument('parse', input, submissionId, signal);
  }

  private async submitDocument(operation: 'parse' | 'translate', input: KolmoDocumentInput, submissionId: string, signal: AbortSignal, options?: KolmoTranslationOptions): Promise<KolmoJob> {
    signal.throwIfAborted();
    if (input.snapshot.kind !== 'bytes') throw new Error('Choose a PDF to continue');
    if (input.snapshot.docId !== input.documentId || input.snapshot.savedRevision !== input.revision) throw new Error('The PDF changed. Please try again.');
    if (!input.snapshot.bytes.byteLength || input.snapshot.bytes.byteLength > WEB_LIMITS.inputBytes) throw new Error('Choose a PDF smaller than 50 MB');
    if (!Number.isInteger(input.pageCount) || input.pageCount < 1 || input.pageCount > 800) throw new Error('KolmoPDF supports PDFs with 1–800 pages');
    if (!submissionId.trim() || submissionId.length > 200 || /[\r\n\0]/.test(submissionId)) throw new Error('Invalid submission id');
    const job = await (await this.request(`/api/v1/kolmo/jobs/${operation === 'parse' ? 'parse' : 'translate-pdf'}`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json', 'Idempotency-Key': submissionId },
      body: JSON.stringify({ name: input.name, pageCount: input.pageCount, pdfBase64: base64(input.snapshot.bytes), ...(options ? { options } : {}) }),
    }, this.requiredKey())).json() as KolmoJob;
    const previous = this.jobs.get(job.id);
    this.jobs.set(job.id, previous ? { ...previous, job }
      : { job, operation, name: input.name, createdAt: Date.now(), documentId: input.documentId, revision: input.revision });
    this.persist();
    return clone(job);
  }

  async getKolmoJob(id: string, signal: AbortSignal): Promise<KolmoJob> {
    signal.throwIfAborted();
    return this.remember(await (await this.request(idPath(id), { signal }, this.requiredKey())).json() as KolmoJob);
  }

  async cancelKolmoJob(id: string): Promise<KolmoJob> {
    return this.remember(await (await this.request(`${idPath(id)}/cancel`, { method: 'POST' }, this.requiredKey())).json() as KolmoJob);
  }

  async downloadKolmoResult(id: string, signal: AbortSignal): Promise<KolmoFile[]> {
    const job = await this.getKolmoJob(id, signal);
    if (job.status !== 'succeeded' || !job.result) throw new Error('The result is not ready yet');
    if (!['pdf', 'zip', 'markdown'].includes(job.result.kind)) throw new Error('KolmoPDF returned an unsupported result');
    const response = await this.request(`${idPath(id)}/download`, { signal }, this.requiredKey());
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();
    if (bytes.byteLength > MAX_RESULT_BYTES) throw new Error('The result is too large to download in this browser');
    const result = job.result;
    const files: KolmoFile[] = [{ kind: 'bytes', name: result.filename,
      mimeType: result.kind === 'markdown' ? 'text/markdown;charset=utf-8'
        : result.content_type ?? (result.kind === 'pdf' ? 'application/pdf' : 'application/zip'), bytes }];
    if (result.kind === 'markdown') return files;
    const signature = new Uint8Array(bytes, 0, Math.min(5, bytes.byteLength));
    if (result.kind === 'pdf') {
      if (new TextDecoder().decode(signature) !== '%PDF-') throw new Error('KolmoPDF did not return a PDF');
      return files;
    }
    let count = 0, total = 0;
    const members = unzipSync(new Uint8Array(bytes), { filter: member => {
      if (++count > 32) throw new Error('Translation ZIP contains too many entries');
      if (!member.name || /[\\:\0]/.test(member.name) || member.name.startsWith('/') || member.name.split('/').some(part => part === '..')) throw new Error('Translation ZIP contains an unsafe path');
      total += member.originalSize;
      if (total > MAX_RESULT_BYTES) throw new Error('Translation ZIP exceeds the 200 MiB extraction limit');
      return member.name.toLowerCase().endsWith('.pdf');
    } });
    for (const [name, data] of Object.entries(members)) {
      if (new TextDecoder().decode(data.subarray(0, 5)) !== '%PDF-') throw new Error('Translation ZIP contains an invalid PDF');
      files.push({ kind: 'bytes', name, mimeType: 'application/pdf', bytes: data.slice().buffer });
    }
    return files;
  }

  async listKolmoJobs(): Promise<KolmoSavedJob[]> {
    return clone([...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt));
  }

  private requiredKey(): string {
    if (!this.key) throw new Error('Connect KolmoPDF to continue');
    return this.key;
  }
  private remember(job: KolmoJob): KolmoJob {
    const saved = this.jobs.get(job.id);
    if (saved) { saved.job = job; this.persist(); }
    return clone(job);
  }
  private persist(): void {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, jobs: [...this.jobs.values()] })); }
    catch { /* Retain current-session history even when browser storage is full. */ }
  }
  private async request(path: string, init: RequestInit, key?: string): Promise<Response> {
    const response = await this.fetcher(path, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { ...init.headers, ...(key ? { 'x-kolmo-api-key': key } : {}) } });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(error?.error?.message ?? `Request failed (HTTP ${response.status})`);
    }
    return response;
  }
}
