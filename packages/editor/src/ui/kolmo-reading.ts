import type { KolmoJob } from '@pdf-editor/contracts';
import type { EditorAiContext } from './EditorShell.js';
import { materialDocument } from './komo-materials.js';

export type DocumentReading = {
  documentId: string; revision: number; jobId: string; name: string; filename: string; text: string;
};

export async function readWithKolmo(context: EditorAiContext, signal: AbortSignal, onProgress?: (job: KolmoJob) => void): Promise<DocumentReading | null> {
  const services = context.aiServices, document = context.document;
  if (!services?.parseDocument || !context.prepareReading || !document) return null;
  if (!(await services.kolmoConnection(signal)).configured) return null;
  signal.throwIfAborted();
  const input = await context.prepareReading();
  if (!input) return null;
  if (input.documentId !== document.id) throw new Error('Open the PDF you want to read.');
  const matches = (await services.listKolmoJobs()).filter(saved => saved.operation === 'parse'
    && saved.documentId === input.documentId && saved.revision === input.revision);
  signal.throwIfAborted();
  // Reuse finished results, not another reader's active task (which we cannot own/cancel).
  const previous = matches.find(saved => saved.job.status === 'succeeded');
  let owned: KolmoJob | undefined;
  let cancelled = false;
  const cancelOwned = () => {
    if (!owned || cancelled || !['queued', 'processing'].includes(owned.status)) return;
    cancelled = true;
    void services.cancelKolmoJob(owned.id).catch(() => { /* Preserve the user's cancellation; never publish a late result. */ });
  };
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => { cancelOwned(); rejectAbort(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    // Keep submission alive just long enough to obtain its job ID, even if Stop wins the race.
    const submission = previous ? Promise.resolve(previous.job)
      : services.parseDocument(input, `reading:${input.documentId}:${input.revision}:${crypto.randomUUID()}`, AbortSignal.timeout(180_000))
        .then(job => { owned = job; if (signal.aborted) cancelOwned(); return job; });
    if (signal.aborted) abort();
    let job = await Promise.race([submission, aborted]);
    while (job.status === 'queued' || job.status === 'processing') {
      signal.throwIfAborted();
      onProgress?.(job);
      await new Promise<void>((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, 1500);
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      });
      job = await services.getKolmoJob(job.id, signal);
      if (owned) owned = job;
    }
    signal.throwIfAborted();
    if (job.status !== 'succeeded') throw new Error(job.error?.message || 'Unable to read this PDF. Please try again.');
    const files = await services.downloadKolmoResult(job.id, signal);
    signal.throwIfAborted();
    const file = files.find(file => /\.(md|markdown)$/i.test(file.name));
    if (!file || file.kind !== 'bytes') throw new Error('The document text is not ready yet.');
    const current = materialDocument(context, input.documentId);
    if (!current || current.revision !== input.revision || current.permissions.copy !== true) throw new Error('The PDF changed. Read the current version again.');
    const text = new TextDecoder().decode(file.bytes);
    if (!text.trim()) throw new Error('No text was found in this PDF.');
    return { documentId: input.documentId, revision: input.revision, jobId: job.id, name: input.name, filename: file.name, text };
  } finally {
    signal.removeEventListener('abort', abort);
    if (signal.aborted) cancelOwned();
  }
}
