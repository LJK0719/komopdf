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
  const previous = matches[0];
  let job = previous && !['failed', 'cancelled'].includes(previous.job.status)
    ? await services.getKolmoJob(previous.job.id, signal)
    : await services.parseDocument(input, `reading:${input.documentId}:${input.revision}${previous ? `:${previous.job.id}` : ''}`, signal);
  while (job.status === 'queued' || job.status === 'processing') {
    onProgress?.(job);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1500);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    job = await services.getKolmoJob(job.id, signal);
  }
  if (job.status !== 'succeeded') throw new Error(job.error?.message || 'Unable to read this PDF. Please try again.');
  const files = await services.downloadKolmoResult(job.id, signal);
  const file = files.find(file => /\.(md|markdown)$/i.test(file.name));
  if (!file || file.kind !== 'bytes') throw new Error('The document text is not ready yet.');
  const current = materialDocument(context, input.documentId);
  if (!current || current.revision !== input.revision) throw new Error('The PDF changed. Read the current version again.');
  const text = new TextDecoder().decode(file.bytes);
  if (!text.trim()) throw new Error('No text was found in this PDF.');
  return { documentId: input.documentId, revision: input.revision, jobId: job.id, name: input.name, filename: file.name, text };
}
