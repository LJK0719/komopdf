import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { KolmoDocumentInput, KolmoTranslationOptions, TextActionRequest } from '@pdf-editor/contracts';
import { WebAiServices } from '../src/host/web-ai-services.js';

const signal = () => new AbortController().signal;
const options: KolmoTranslationOptions = { sourceLanguage: 'en', targetLanguage: 'zh', layoutModes: ['translated_only'], translateImages: false, translateTables: true };
const input: KolmoDocumentInput = { name: 'edited.pdf', pageCount: 3, documentId: 'doc-one', revision: 7,
  snapshot: { kind: 'bytes', bytes: strToU8('%PDF-edited-revision-7').buffer, docId: 'doc-one', savedRevision: 7 } };
function memoryStorage() {
  let content = '';
  return { getItem: vi.fn(() => content), setItem: vi.fn((_key: string, value: string) => { content = value; }), content: () => content };
}
const balance = () => Response.json({ configured: true, points: 90 });

describe('WebAiServices', () => {
  it('keeps credentials per instance, verifies replacement first, and clears on disconnect', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const key = (init?.headers as Record<string, string>)['x-kolmo-api-key'];
      return key === 'bad-key' ? Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }) : balance();
    });
    const storage = memoryStorage(); const one = new WebAiServices({ fetch: fetcher, storage });
    const two = new WebAiServices({ fetch: fetcher, storage });
    await expect(one.configureKolmo('key-one')).resolves.toEqual({ configured: true, points: 90 });
    await expect(two.kolmoConnection()).resolves.toEqual({ configured: false, points: null });
    await expect(one.configureKolmo('bad-key')).rejects.toThrow('Invalid API key');
    await one.kolmoConnection();
    expect(fetcher.mock.lastCall?.[1]?.headers).toEqual({ 'x-kolmo-api-key': 'key-one' });
    expect(fetcher.mock.calls.every(([_url, init]) => init?.credentials === 'omit')).toBe(true);
    expect(storage.content()).not.toContain('key-one'); expect(storage.setItem).not.toHaveBeenCalled();
    await one.configureKolmo(''); const calls = fetcher.mock.calls.length;
    await expect(one.kolmoConnection()).resolves.toEqual({ configured: false, points: null });
    await expect(one.translateDocument(input, options, 'submission-one', signal())).rejects.toThrow('Connect'); expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it('disconnect wins over a pending key verification', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const services = new WebAiServices({ fetch: fetcher, storage: null });
    const connecting = services.configureKolmo('key-one'); await services.configureKolmo(''); finish(balance());
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(services.kolmoConnection()).resolves.toEqual({ configured: false, points: null });
  });
  it('uses the exact snapshot and stable submission id; persists only accurate job metadata', async () => {
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
    const [saved] = await services.listKolmoJobs(); expect(saved).toMatchObject({ name: 'edited.pdf', documentId: 'doc-one', revision: 7, job: { status: 'processing', progress: 37 } });
    expect(saved?.createdAt).toBeGreaterThan(0);
    expect(storage.content()).not.toContain('key-one'); expect(storage.content()).not.toContain('pdfBase64'); expect(storage.content()).not.toContain('%PDF');
    const restored = new WebAiServices({ fetch: fetcher, storage });
    expect(await restored.listKolmoJobs()).toEqual(await services.listKolmoJobs());
    await expect(restored.kolmoConnection()).resolves.toEqual({ configured: false, points: null });
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
  it('rejects mismatched/native snapshots before any paid submission', async () => {
    const fetcher = vi.fn<typeof fetch>(); const services = new WebAiServices({ fetch: fetcher, storage: null });
    await expect(services.translateDocument({ ...input, revision: 8 }, options, 'submit', signal())).rejects.toThrow('revision');
    await expect(services.translateDocument({ ...input, snapshot: { kind: 'native-file', handle: 'file', docId: 'doc-one', savedRevision: 7 } }, options, 'submit', signal())).rejects.toThrow('snapshot');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
