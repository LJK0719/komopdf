import { aiRequestSchema, type AiRequest, type DocumentInfo } from '@pdf-editor/contracts';
import { AiWorkflow, createEvidenceSnapshot, DocumentAiAuthorization } from '@pdf-editor/ai-client';
import { passageBatches, readingTextPassages } from './document-ai-context.js';

type ReadingOptions = {
  document: DocumentInfo; name: string; endpoint: string; fetch?: typeof fetch; signal: AbortSignal;
  currentDocument(): DocumentInfo; instruction: string; onProgress?(message: string): void;
};

export async function askReading(options: ReadingOptions, texts: readonly string[], visual?: Pick<AiRequest['context'], 'images' | 'pages'>): Promise<string> {
  const document = options.document;
  const authorization = new DocumentAiAuthorization(document.id);
  authorization.enable(document.sourceIds);
  // Visual batches carry the full page image; supplementary text must not overflow
  // the request just because the PDF contains hundreds of tiny text objects.
  const contextText = texts.filter(text => text.trim()).join('\n\n');
  const passages = readingTextPassages(visual ? contextText.slice(0, 36_000) : contextText);
  const request = aiRequestSchema.parse({ protocolVersion: 1, requestId: crypto.randomUUID(),
    document: { id: document.id, revision: document.revision }, feature: visual ? 'image.explain' : 'document.summarize',
    instruction: options.instruction, options: {}, context: { scope: 'document', evidence: [], ...visual,
      sourceDocuments: [{ id: document.id, revision: document.revision, name: options.name,
        sourceIds: document.sourceIds, pageIds: document.pageOrder }],
      referenceEvidence: passages.map(({ text }, index) => ({ id: `r${index + 1}`, docId: document.id,
        revision: document.revision, sourceId: document.sourceIds[0]!, materialId: 'document-reading', kind: 'analysis', text })),
    } });
  const workflow = new AiWorkflow({ endpoint: options.endpoint, authorization, getCurrentDocument: options.currentDocument,
    ...(options.fetch ? { fetch: options.fetch } : {}), nextTransactionId: () => crypto.randomUUID(),
    apply: async () => { throw new Error('Reading does not modify the PDF'); } });
  try {
    const result = (await workflow.run({ request, snapshot: createEvidenceSnapshot(request, []), sourceIds: document.sourceIds, signal: options.signal })).response.result;
    if (result.kind === 'answer') return result.text;
    if (result.kind === 'clarification') return result.question;
    throw new Error('Unable to read this part of the document.');
  } finally { authorization.revoke(); }
}

export class PartialReadingError extends Error {
  constructor(readonly sections: string[]) { super('The summary could not be shortened further. The section results are shown here.'); }
}

export async function condenseReading(options: ReadingOptions, text: string, budget: number): Promise<string> {
  let current = text;
  let calls = 0;
  for (let round = 0; current.length > budget; round++) {
    const sections = readingTextPassages(current);
    if (round === 4) throw new PartialReadingError(sections.map(section => section.text));
    const summaries: string[] = [];
    for (const batch of passageBatches(sections)) {
      options.signal.throwIfAborted(); options.onProgress?.('Reading document…');
      if (++calls > 128) throw new PartialReadingError(sections.map(section => section.text));
      summaries.push(await askReading({ ...options,
        instruction: `Summarize this part in at most ${Math.min(150, Math.max(30, Math.floor(budget / 8)))} words, retaining the details relevant to the user's question: ${options.instruction}` }, batch.map(section => section.text)));
    }
    const next = summaries.join('\n\n');
    if (next.length > budget && next.length >= current.length * 0.9) throw new PartialReadingError(summaries);
    current = next;
  }
  return current;
}
