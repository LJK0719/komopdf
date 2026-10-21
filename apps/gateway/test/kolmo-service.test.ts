import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerKolmoService } from '../src/kolmo-service.js';

const options = { sourceLanguage: 'en', targetLanguage: 'zh', layoutModes: ['translated_only', 'side_by_side'],
  translateImages: true, translateTables: false, glossary: { name: 'terms.csv', text: 'en,zh\napple,苹果' } };
const payload = { name: 'snapshot.pdf', pageCount: 4, pdfBase64: Buffer.from('%PDF-current-revision').toString('base64'), options };
const headers = { 'x-kolmo-api-key': 'user-key-one', 'Idempotency-Key': 'same-submission' };
function setup(fetcher: typeof fetch, admit = vi.fn(async () => undefined)) {
  const app = Fastify(); registerKolmoService(app, { admit, fetch: fetcher }); return { app, admit };
}

describe('KolmoPDF fixed-endpoint gateway', () => {
  it('forwards exact translate multipart fields and idempotency, never parse or KOMO account billing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: 'job_one', status: 'queued' }));
    const { app, admit } = setup(fetcher);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/kolmo/jobs/translate-pdf', headers, payload });
        expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ id: 'job_one', status: 'queued' });
      }
      expect(admit).toHaveBeenCalledTimes(2);
      for (const [url, init] of fetcher.mock.calls) {
        expect(url).toBe('https://www.kolmopdf.com/api/v1/jobs/translate-pdf');
        expect(init?.redirect).toBe('error'); expect(init?.method).toBe('POST');
        expect(init?.headers).toEqual({ Authorization: 'Bearer user-key-one', 'Idempotency-Key': 'same-submission' });
        const form = init?.body as FormData;
        expect([...form.keys()].sort()).toEqual(['file', 'sourceLanguage', 'targetLanguage', 'layoutModes', 'enable_image_translation', 'enable_table_translation', 'glossary'].sort());
        expect(form.get('sourceLanguage')).toBe('en'); expect(form.get('targetLanguage')).toBe('zh');
        expect(form.get('layoutModes')).toBe('translated_only,side_by_side');
        expect(form.get('enable_image_translation')).toBe('true'); expect(form.get('enable_table_translation')).toBe('false');
        const file = form.get('file') as File; expect(file.name).toBe('snapshot.pdf'); expect(file.type).toBe('application/pdf');
        expect(await file.text()).toBe('%PDF-current-revision');
        const glossary = form.get('glossary') as File; expect(glossary.name).toBe('terms.csv'); expect(await glossary.text()).toBe(options.glossary.text);
      }
    } finally { await app.close(); }
  });
  it('isolates keys per request and never echoes upstream errors or follows a download URL', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ points: 23 }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'user-key-two' } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ id: 'job_one', status: 'succeeded', result: { filename: 'actual.zip', kind: 'zip', content_type: 'application/zip', download_url: 'https://attacker.example/collect', files: [{ name: 'translated.pdf', kind: 'pdf' }] } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'content-type': 'application/zip', 'x-secret': 'user-key-one' } }));
    const { app } = setup(fetcher);
    try {
      const balance = await app.inject({ method: 'GET', url: '/api/v1/kolmo/balance', headers }); expect(balance.json()).toEqual({ configured: true, points: 23 });
      const error = await app.inject({ method: 'GET', url: '/api/v1/kolmo/balance', headers: { 'x-kolmo-api-key': 'user-key-two' } });
      expect(error.statusCode).toBe(401); expect(error.body).not.toContain('user-key-two');
      expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: 'Bearer user-key-two' });
      const job = await app.inject({ method: 'GET', url: '/api/v1/kolmo/jobs/job_one', headers });
      expect(job.json().result).toMatchObject({ filename: 'actual.zip', kind: 'zip', download_url: '/api/v1/jobs/job_one/download' });
      const download = await app.inject({ method: 'GET', url: '/api/v1/kolmo/jobs/job_one/download?url=https://attacker.example', headers });
      expect(download.statusCode).toBe(200); expect(download.rawPayload).toEqual(Buffer.from([80, 75, 3, 4])); expect(download.headers['x-secret']).toBeUndefined();
      expect(fetcher.mock.calls[3]?.[0]).toBe('https://www.kolmopdf.com/api/v1/jobs/job_one/download');
      expect(download.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
  it('returns actual progress/failure/cancellation and sends real cancel request', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'job_one', status: 'processing', progress: 41, phase: 'translating', message: 'Page 2' }))
      .mockResolvedValueOnce(Response.json({ id: 'job_one', status: 'failed', error: { code: 'BROKEN_PDF', message: 'Bad PDF' } }))
      .mockResolvedValueOnce(Response.json({ id: 'job_one', status: 'cancelled', progress: null }));
    const { app } = setup(fetcher);
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/kolmo/jobs/job_one', headers })).json()).toMatchObject({ status: 'processing', progress: 41, phase: 'translating' });
      expect((await app.inject({ method: 'GET', url: '/api/v1/kolmo/jobs/job_one', headers })).json()).toMatchObject({ status: 'failed', error: { code: 'BROKEN_PDF' } });
      expect((await app.inject({ method: 'POST', url: '/api/v1/kolmo/jobs/job_one/cancel', headers })).json()).toEqual({ id: 'job_one', status: 'cancelled', progress: null });
      expect(fetcher.mock.calls[2]?.[0]).toBe('https://www.kolmopdf.com/api/v1/jobs/job_one/cancel'); expect(fetcher.mock.calls[2]?.[1]?.method).toBe('POST');
    } finally { await app.close(); }
  });
  it('rejects invalid input and enforces anonymous admission before forwarding', async () => {
    const fetcher = vi.fn<typeof fetch>(); const { app } = setup(fetcher);
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/kolmo/balance' })).statusCode).toBe(400);
      for (const invalid of [{ ...payload, pageCount: 801 }, { ...payload, pdfBase64: 'not-pdf' },
        { ...payload, options: { ...options, layoutModes: ['parse'] } }, { ...payload, options: { ...options, glossary: { name: 'terms.csv', text: 'x'.repeat(2 * 1024 * 1024 + 1) } } }]) {
        expect((await app.inject({ method: 'POST', url: '/api/v1/kolmo/jobs/translate-pdf', headers, payload: invalid })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'GET', url: '/api/v1/kolmo/jobs/https%3A%2F%2Fattacker.example', headers })).statusCode).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
    const blocked = Fastify();
    registerKolmoService(blocked, { admit: async (_request, reply) => { reply.code(429).send({ error: { code: 'RATE_LIMIT', message: 'Try later' } }); }, fetch: fetcher });
    try { expect((await blocked.inject({ method: 'GET', url: '/api/v1/kolmo/balance', headers })).statusCode).toBe(429); expect(fetcher).not.toHaveBeenCalled(); }
    finally { await blocked.close(); }
  });
});
