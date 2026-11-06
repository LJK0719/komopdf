import { describe, expect, it, vi } from 'vitest';
import type { DocumentInfo, EditorAiServices, KolmoDocumentInput, KolmoJob } from '@pdf-editor/contracts';
import type { EditorAiContext } from '../src/ui/EditorShell.js';
import { readWithKolmo } from '../src/ui/kolmo-reading.js';

const document = { id: 'd', revision: 1, permissions: { copy: true } } as DocumentInfo;
const input = { documentId: 'd', revision: 1, name: 'Test.pdf' } as KolmoDocumentInput;
const queued: KolmoJob = { id: 'new-job', status: 'queued' };
function fixture() {
  const services = {
    kolmoConnection: vi.fn(async () => ({ configured: true, points: 100 })),
    listKolmoJobs: vi.fn<EditorAiServices['listKolmoJobs']>(async () => []),
    parseDocument: vi.fn<NonNullable<EditorAiServices['parseDocument']>>(async () => queued),
    getKolmoJob: vi.fn<EditorAiServices['getKolmoJob']>(async () => queued),
    cancelKolmoJob: vi.fn<EditorAiServices['cancelKolmoJob']>(async id => ({ id, status: 'cancelled' })),
    downloadKolmoResult: vi.fn<EditorAiServices['downloadKolmoResult']>(async () => [{ name: 'result.md', mimeType: 'text/markdown', kind: 'bytes', bytes: new TextEncoder().encode('Parsed content').buffer }]),
  };
  const context = { document, getDocumentInfo: () => document, aiServices: services,
    prepareReading: vi.fn(async () => input) } as unknown as EditorAiContext;
  return { services, context };
}

describe('readWithKolmo cancellation ownership', () => {
  it('cancels the automatic reader task once when Stop is pressed', async () => {
    const { services, context } = fixture(); const controller = new AbortController();
    const run = readWithKolmo(context, controller.signal, () => controller.abort());
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(services.cancelKolmoJob).toHaveBeenCalledExactlyOnceWith('new-job');
    expect(services.downloadKolmoResult).not.toHaveBeenCalled();
  });
  it('returns promptly on Stop and cancels a job whose submission ID arrives afterwards', async () => {
    const { services, context } = fixture(); const controller = new AbortController();
    let resolve!: (job: KolmoJob) => void;
    services.parseDocument.mockImplementation(async () => new Promise(done => { resolve = done; }));
    const run = readWithKolmo(context, controller.signal);
    await vi.waitFor(() => expect(services.parseDocument).toHaveBeenCalledOnce());
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    resolve(queued);
    await vi.waitFor(() => expect(services.cancelKolmoJob).toHaveBeenCalledExactlyOnceWith('new-job'));
    expect(services.downloadKolmoResult).not.toHaveBeenCalled();
  });
  it('never cancels another active reader task and reuses completed results', async () => {
    const { services, context } = fixture(); const controller = new AbortController();
    services.listKolmoJobs.mockResolvedValue([{ documentId: 'd', revision: 1, name: 'Test.pdf', operation: 'parse', createdAt: 1,
      job: { id: 'other-job', status: 'processing' } }]);
    await expect(readWithKolmo(context, controller.signal, () => controller.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(services.cancelKolmoJob).not.toHaveBeenCalledWith('other-job');
    services.listKolmoJobs.mockResolvedValue([{ documentId: 'd', revision: 1, name: 'Test.pdf', operation: 'parse', createdAt: 2,
      job: { id: 'completed-job', status: 'succeeded' } }]);
    services.parseDocument.mockClear();
    const reading = await readWithKolmo(context, new AbortController().signal);
    expect(reading).toMatchObject({ jobId: 'completed-job', text: 'Parsed content' });
    expect(services.parseDocument).not.toHaveBeenCalled();
  });
});
