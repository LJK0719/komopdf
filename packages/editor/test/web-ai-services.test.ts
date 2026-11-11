import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { KolmoDocumentInput, KolmoTranslationOptions, TextActionRequest } from '@pdf-editor/contracts';
import { WebAiServices } from '../src/host/web-ai-services.js';

const signal = () => new AbortController().signal;
const options: KolmoTranslationOptions = { sourceLanguage: 'en', targetLanguage: 'zh', layoutModes: ['translated_only'], translateImages: false, translateTables: true };
const input: KolmoDocumentInput = { name: 'edited.pdf', pageCount: 3, documentId: 'doc-one', revision: 7,
  snapshot: { kind: 'bytes', bytes: strToU8('%PDF-edited-revision-7').buffer, docId: 'doc-one', savedRevision: 7 } };
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    content: (key = 'komopdf.kolmo-jobs.v1') => values.get(key) ?? '' };
}
const balance = () => Response.json({ configured: true, points: 90 });

describe('WebAiServices', () => {
  it('streams UTF-8 translation previews before completion and rejects unfinished streams', async () => {
    const request: TextActionRequest = { requestId: 'one', action: 'translate', sourceLanguage: 'auto', targetLanguage: 'zh', tone: 'neutral', segments: [{ id: 's1', text: 'Hello' }] };
    const result = { ...request, detectedLanguage: 'en', segments: [{ id: 's1', text: '你好😀' }] };
    const output = { requestId: result.requestId, action: result.action, detectedLanguage: result.detectedLanguage, segments: result.segments };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    const service = new WebAiServices({ fetch: fetcher, storage: null });
    const delta = vi.fn(); let completed = false;
    const promise = service.textAction(request, signal(), delta).then(value => { completed = true; return value; });
    const bytes = new TextEncoder().encode('event: delta\ndata: {"type":"delta","text":"你好😀"}\n\n');
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    await vi.waitFor(() => expect(delta).toHaveBeenCalledWith('你好😀'));
    expect(completed).toBe(false);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ accept: 'text/event-stream' });
    controller.enqueue(new TextEncoder().encode(`event: result\ndata: ${JSON.stringify({ type: 'result', result: output })}\n\n`));
    await expect(promise).resolves.toEqual(output);
    for (const ending of ['', 'event: error\ndata: {"type":"error","error":{"message":"AI request processing timed out"}}\n\n']) {
      fetcher.mockResolvedValueOnce(new Response('data: {"type":"delta","text":"partial"}\n\n' + ending, { headers: { 'content-type': 'text/event-stream' } }));
      await expect(service.textAction(request, signal(), vi.fn())).rejects.toThrow(ending ? 'timed out' : 'invalid response');
    }
  });
  it('keeps the connection across reloads, verifies a replacement first and notifies all panels', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const key = (init?.headers as Record<string, string>)['x-kolmo-api-key'];
      return key === 'bad-key' ? Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }) : balance();
    });
    const storage = memoryStorage();
    const services = new WebAiServices({ fetch: fetcher, storage });
    const changed = vi.fn(); const stop = await services.subscribeKolmoConnection(changed);
    await expect(services.configureKolmo('key-one')).resolves.toEqual({ configured: true, points: 90 });
    expect(changed).toHaveBeenCalledOnce();
    const reloaded = new WebAiServices({ fetch: fetcher, storage });
    await expect(reloaded.kolmoConnection()).resolves.toEqual({ configured: true, points: 90 });
    await expect(services.configureKolmo('bad-key')).rejects.toThrow('Invalid API key');
    await services.kolmoConnection();
    expect(fetcher.mock.lastCall?.[1]?.headers).toEqual({ 'x-kolmo-api-key': 'key-one' });
    expect(fetcher.mock.calls.every(([_url, init]) => init?.credentials === 'omit')).toBe(true);
    expect(storage.content('komopdf.kolmo-key.v1')).toBe('key-one');
    await services.configureKolmo('');
    expect(changed).toHaveBeenCalledTimes(2); stop();
    const calls = fetcher.mock.calls.length;
    await expect(services.kolmoConnection()).resolves.toEqual({ configured: false, points: null });
    await expect(services.translateDocument(input, options, 'submission-one', signal())).rejects.toThrow('Connect');
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(storage.content('komopdf.kolmo-key.v1')).toBe('');
  });
  it('disconnect wins over a pending key verification', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const services = new WebAiServices({ fetch: fetcher, storage: null });
    const connecting = services.configureKolmo('key-one'); await services.configureKolmo(''); finish(balance());
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(services.kolmoConnection()).resolves.toEqual({ configured: false, points: null });
  });
  it('uses the exact snapshot and stable submission id; keeps the job and connection after reload', async () => {
    const storage = memoryStorage();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(balance())
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(Response.json({ id: 'job_one', status: 'queued' }))
      .mockResolvedValueOnce(Response.json({ id: 'job_one', status: 'processing', progress: 37, phase: 'translate', message: 'Page 1' }));
    const services = new WebAiServices({ fetch: fetcher, storage }); await services.configureKolmo('key-one');
    await expect(services.translateDocument(input, options, 'submission-one', signal())).rejects.toThrow('connection lost');
    await services.translateDocument(input, options, 'submission-one', signal());
    for (const call of fetcher.mock.calls.slice(1, 3)) {
      expect(call[0]).toBe('/api/v1/kolmo/jobs/translate-pdf');
      expect(call[1]?.headers).toEqual({ 'content-type': 'application/json', 'Idempotency-Key': 'submission-one', 'x-kolmo-api-key': 'key-one' });
      expect(JSON.parse(call[1]?.body as string)).toEqual({ name: 'edited.pdf', pageCount: 3, pdfBase64: Buffer.from(input.snapshot.kind === 'bytes' ? input.snapshot.bytes : new ArrayBuffer(0)).toString('base64'), options });
    }
    expect((await services.getKolmoJob('job_one', signal())).status).toBe('processing');
    const [saved] = await services.listKolmoJobs();
    expect(saved).toMatchObject({ operation: 'translate', name: 'edited.pdf', documentId: 'doc-one', revision: 7, job: { status: 'processing', progress: 37 } });
    expect(saved?.createdAt).toBeGreaterThan(0);
    expect(storage.content()).not.toContain('key-one'); expect(storage.content()).not.toContain('pdfBase64'); expect(storage.content()).not.toContain('%PDF');
    const restored = new WebAiServices({ fetch: fetcher, storage });
    expect(await restored.listKolmoJobs()).toEqual(await services.listKolmoJobs());
    fetcher.mockResolvedValueOnce(balance());
    await expect(restored.kolmoConnection()).resolves.toEqual({ configured: true, points: 90 });
  });
  it('parses the current PDF and downloads Markdown through the same connected service', async () => {
    const completed = { id: 'job_read', status: 'succeeded', result: { filename: 'edited.md', kind: 'markdown', download_url: '/api/v1/jobs/job_read/download' } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(balance()).mockResolvedValueOnce(Response.json({ id: 'job_read', status: 'queued' }))
      .mockResolvedValueOnce(Response.json(completed)).mockResolvedValueOnce(new Response('# Research\n\nA complete reading.'));
    const services = new WebAiServices({ fetch: fetcher, storage: memoryStorage() });
    await services.configureKolmo('key-one');
    await services.parseDocument(input, 'read-current-version', signal());
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/v1/kolmo/jobs/parse');
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toMatchObject({ name: 'edited.pdf', pageCount: 3 });
    expect((await services.listKolmoJobs())[0]).toMatchObject({ operation: 'parse', documentId: 'doc-one', revision: 7 });
    const files = await services.downloadKolmoResult('job_read', signal());
    expect(files[0]).toMatchObject({ kind: 'bytes', name: 'edited.md', mimeType: 'text/markdown;charset=utf-8' });
    expect(files[0]?.kind === 'bytes' && new TextDecoder().decode(files[0].bytes)).toContain('A complete reading.');
  });
  it('reconnects and downloads actual PDF metadata without resubmitting after download failure', async () => {
    const storage = memoryStorage();
    const completed = { id: 'job_one', status: 'succeeded', result: { filename: 'actual-translated.pdf', kind: 'pdf', content_type: 'application/pdf', download_url: 'https://attacker.example/steal' } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(balance()).mockResolvedValueOnce(Response.json({ id: 'job_one', status: 'queued' }));
    const first = new WebAiServices({ fetch: fetcher, storage }); await first.configureKolmo('key-one'); await first.translateDocument(input, options, 'submission-one', signal()); await first.configureKolmo('');
    fetcher.mockResolvedValueOnce(balance()).mockResolvedValueOnce(Response.json(completed)).mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json(completed)).mockResolvedValueOnce(new Response('%PDF-result'));
    const restored = new WebAiServices({ fetch: fetcher, storage }); await restored.configureKolmo('key-one');
    await expect(restored.downloadKolmoResult('job_one', signal())).rejects.toThrow('503');
    const files = await restored.downloadKolmoResult('job_one', signal());
    expect(files).toHaveLength(1); expect(files[0]).toMatchObject({ kind: 'bytes', name: 'actual-translated.pdf', mimeType: 'application/pdf' });
    expect(files[0]?.kind === 'bytes' && new TextDecoder().decode(files[0].bytes)).toBe('%PDF-result');
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/v1/kolmo/jobs/translate-pdf')).toHaveLength(1);
    expect(fetcher.mock.calls.some(([path]) => String(path).includes('attacker'))).toBe(false);
  });
  it('returns the original ZIP plus its PDF members, and refuses traversal/oversized extraction', async () => {
    const bytes = zipSync({ 'translated.pdf': strToU8('%PDF-translated'), 'nested/side.pdf': strToU8('%PDF-side'), 'notes.txt': strToU8('notes') });
    const completed = { id: 'job_zip', status: 'succeeded', result: { filename: 'both-layouts.zip', kind: 'zip', download_url: '/api/v1/jobs/job_zip/download' } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(balance()).mockResolvedValueOnce(Response.json(completed)).mockResolvedValueOnce(new Response(bytes));
    const services = new WebAiServices({ fetch: fetcher, storage: null }); await services.configureKolmo('key-one');
    const files = await services.downloadKolmoResult('job_zip', signal());
    expect(files.map(file => [file.name, file.mimeType])).toEqual([['both-layouts.zip', 'application/zip'], ['translated.pdf', 'application/pdf'], ['nested/side.pdf', 'application/pdf']]);
    fetcher.mockResolvedValueOnce(Response.json(completed)).mockResolvedValueOnce(new Response(zipSync({ '../outside.pdf': strToU8('%PDF-evil') })));
    await expect(services.downloadKolmoResult('job_zip', signal())).rejects.toThrow('unsafe path');
    fetcher.mockResolvedValueOnce(Response.json(completed)).mockResolvedValueOnce(new Response(zipSync(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`${i}.pdf`, strToU8('%PDF-evil')])))));
    await expect(services.downloadKolmoResult('job_zip', signal())).rejects.toThrow('too many');
  });
  it('reflects cancellation from the server rather than fabricating a cancelled state', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(balance()).mockResolvedValueOnce(Response.json({ id: 'job_one', status: 'processing', message: 'Already finishing' }));
    const services = new WebAiServices({ fetch: fetcher, storage: null }); await services.configureKolmo('key-one');
    await expect(services.cancelKolmoJob('job_one')).resolves.toMatchObject({ status: 'processing', message: 'Already finishing' });
    expect(fetcher.mock.lastCall?.[0]).toBe('/api/v1/kolmo/jobs/job_one/cancel'); expect(fetcher.mock.lastCall?.[1]?.method).toBe('POST');
  });
  it('bridges text actions without a Kolmo key and respects AbortSignal', async () => {
    const request: TextActionRequest = { requestId: 'text-one', action: 'explain', sourceLanguage: 'auto', targetLanguage: 'zh', tone: 'neutral', segments: [{ id: 'segment-one', text: 'Hello' }] };
    const result = { requestId: 'text-one', action: 'explain', detectedLanguage: 'en', segments: [{ id: 'segment-one', text: '你好' }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(balance()).mockResolvedValueOnce(Response.json(result));
    const services = new WebAiServices({ fetch: fetcher, storage: null }); await services.configureKolmo('key-one');
    await expect(services.textAction(request, signal())).resolves.toEqual(result);
    expect(fetcher.mock.lastCall?.[0]).toBe('/api/v1/ai/text-actions');
    expect(fetcher.mock.lastCall?.[1]?.headers).toEqual({ 'content-type': 'application/json' });
    const controller = new AbortController(); controller.abort(); await expect(services.textAction(request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves text-service failures without automatically retrying', async () => {
    const request: TextActionRequest = { requestId: 'text-error', action: 'translate', sourceLanguage: 'auto', targetLanguage: 'zh', tone: 'neutral', segments: [{ id: 'sentence', text: 'A complete sentence.' }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { code: 'REQUEST_TIMEOUT', message: 'AI request processing timed out' } }, { status: 504 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const services = new WebAiServices({ fetch: fetcher, storage: null });
    await expect(services.textAction(request, signal())).rejects.toThrow('AI request processing timed out');
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(services.textAction(request, signal())).rejects.toThrow('Unable to connect to the AI service. Check your connection and try again.');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects mismatched/native snapshots before submission', async () => {
    const fetcher = vi.fn<typeof fetch>(); const services = new WebAiServices({ fetch: fetcher, storage: null });
    await expect(services.translateDocument({ ...input, revision: 8 }, options, 'submit', signal())).rejects.toThrow('PDF changed');
    await expect(services.translateDocument({ ...input, snapshot: { kind: 'native-file', handle: 'file', docId: 'doc-one', savedRevision: 7 } }, options, 'submit', signal())).rejects.toThrow('Choose a PDF');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
