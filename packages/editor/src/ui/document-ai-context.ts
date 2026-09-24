import type { AiFeature, AiRequest, DocumentInfo, EngineAdapter, TextBlock } from '@pdf-editor/contracts';
import { AiWorkflow, LongTaskRunner, createEvidenceSnapshot, createLongTask, resolveCitation,
  type DocumentAiAuthorization, type LongTaskBatch, type LongTaskRecord, type LongTaskStatus } from '@pdf-editor/ai-client';
import { IndexedDbTaskStore } from './AiPanelTaskStore.js';

export type DocumentPassage = {
  pageId: string;
  pageNumber: number;
  blockId: string;
  sourceId: string;
  blockText: string;
  text: string;
  range: [number, number];
  bounds: [number, number, number, number];
};

export type DocumentAnalysis = {
  document: { id: string; revision: number };
  overview: string;
  sections: { text: string; citations: { pageId: string; pageNumber: number; blockId: string; quote?: string }[] }[];
  pagesScanned: number;
  pagesWithText: number;
  passagesScanned: number;
};

const PASSAGE_LIMIT = 8_000;
const BATCH_LIMIT = 12_000;
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'what', 'which', 'who', 'with']);

export function isExhaustiveQuestion(question: string): boolean {
  return /\b(all|every|each|entire|throughout|exhaustive)\b|所有|全部|每一|逐条|全文|整篇/u.test(question);
}

function splitBlock(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  let end = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (part.index + part.segment.length - start > PASSAGE_LIMIT && end > start) {
      ranges.push([start, end]);
      start = end;
    }
    end = part.index + part.segment.length;
  }
  if (end > start) ranges.push([start, end]);
  return ranges;
}

export function passagesForBlock(block: TextBlock, pageId: string, pageNumber: number, sourceIds: readonly string[]): DocumentPassage[] {
  const sourceId = block.sourceId ?? (sourceIds.length === 1 ? sourceIds[0] : undefined);
  if (!sourceId || !sourceIds.includes(sourceId)) throw new Error('Text block missing source mapping; cannot authorize document analysis');
  const blockText = block.runs.map(run => run.text).join('');
  return splitBlock(blockText).map(range => ({
    pageId, pageNumber, blockId: block.id, sourceId, blockText,
    text: blockText.slice(range[0], range[1]), range,
    bounds: [block.bounds.x, block.bounds.y, block.bounds.width, block.bounds.height],
  }));
}

export async function collectDocumentPassages(
  engine: EngineAdapter, document: DocumentInfo, signal: AbortSignal, onPage?: (page: number) => void,
): Promise<DocumentPassage[]> {
  const passages: DocumentPassage[] = [];
  for (const [index, pageId] of document.pageOrder.entries()) {
    signal.throwIfAborted();
    const blocks = await engine.extract({ docId: document.id, pageIds: [pageId] });
    signal.throwIfAborted();
    for (const block of blocks) passages.push(...passagesForBlock(block, pageId, index + 1, document.sourceIds));
    onPage?.(index + 1);
  }
  return passages;
}

function terms(text: string): string[] {
  const lower = text.toLocaleLowerCase();
  const words = [...lower.matchAll(/[\p{L}\p{N}]+/gu)].map(match => match[0]!).filter(word => !STOP_WORDS.has(word));
  const han = [...lower.matchAll(/\p{Script=Han}/gu)].map(match => match[0]!);
  return [...words, ...han, ...han.slice(1).map((char, index) => han[index]! + char)];
}

export function selectRelevantPassages(passages: readonly DocumentPassage[], question: string): DocumentPassage[] {
  const query = [...new Set(terms(question))];
  if (!query.length) return [];
  const documentTerms = passages.map(passage => terms(passage.text));
  const frequencies = new Map(query.map(term => [term, documentTerms.filter(tokens => tokens.includes(term)).length]));
  const ranked = passages.map((passage, index) => {
    const tokens = documentTerms[index]!;
    const frequency = new Map<string, number>();
    for (const token of tokens) if (frequencies.has(token)) frequency.set(token, (frequency.get(token) ?? 0) + 1);
    const score = query.reduce((sum, token) => sum + Math.log(1 + (passages.length + 1) / (1 + (frequencies.get(token) ?? 0))) *
      ((frequency.get(token) ?? 0) / (1 + tokens.length / 150)), 0);
    return { passage, index, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: typeof ranked = [];
  let characters = 0;
  for (const item of ranked) {
    if (selected.length === 24) break;
    if (characters + item.passage.text.length > 36_000) continue;
    selected.push(item);
    characters += item.passage.text.length;
  }
  return selected.sort((a, b) => a.index - b.index).map(item => item.passage);
}

export function passageBatches(passages: readonly DocumentPassage[]): DocumentPassage[][] {
  const batches: DocumentPassage[][] = [];
  let batch: DocumentPassage[] = [];
  let characters = 0;
  for (const passage of passages) {
    if (batch.length && (characters + passage.text.length > BATCH_LIMIT || batch.length >= 12)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(passage);
    characters += passage.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

type SummaryPayload =
  | { kind: 'section'; passages: DocumentPassage[] }
  | { kind: 'overview'; contentFingerprint: string };
type SummaryResult = DocumentAnalysis['sections'][number];
type SummaryTask = LongTaskRecord<SummaryPayload, SummaryResult>;

function analysisFromTask(task: SummaryTask): DocumentAnalysis | null {
  const last = task.batches.at(-1);
  if (task.status !== 'completed' || last?.status !== 'completed' || !last.result) return null;
  const sections = task.batches.slice(0, -1).map(batch => batch.result).filter((result): result is SummaryResult => !!result);
  if (sections.length !== task.batches.length - 1) return null;
  const scope = task.scope as { pagesScanned: number; pagesWithText: number; passagesScanned: number };
  return { document: { id: task.docId, revision: task.baseRevision }, overview: last.result.text,
    sections, pagesScanned: scope.pagesScanned, pagesWithText: scope.pagesWithText,
    passagesScanned: scope.passagesScanned };
}

/** 仅从本地任务存储恢复快照，不自动授权或向 AI 发送请求。 */
export async function restoreFullDocumentAnalysis(docId: string): Promise<{
  feature: 'document.ask' | 'document.summarize'; instruction: string;
  status: LongTaskStatus; analysis: DocumentAnalysis | null;
} | null> {
  const store = new IndexedDbTaskStore<SummaryPayload, SummaryResult>();
  const [summary, ask] = await Promise.all([
    store.getLatestTaskForDocument(docId, 'document.summarize'),
    store.getLatestTaskForDocument(docId, 'document.ask'),
  ]);
  const task = [summary, ask].filter((item): item is SummaryTask => !!item)
    .sort((a, b) => ((b.scope as { createdAt?: number }).createdAt ?? 0) -
      ((a.scope as { createdAt?: number }).createdAt ?? 0))[0];
  if (!task) return null;
  const restored = await new LongTaskRunner(store).restore(task.id);
  return { feature: restored.taskType as 'document.ask' | 'document.summarize',
    instruction: (restored.settings as { instruction: string }).instruction,
    status: restored.status, analysis: analysisFromTask(restored) };
}

export async function analyzeFullDocument(options: {
  engine: EngineAdapter;
  document: DocumentInfo;
  authorization: DocumentAiAuthorization;
  endpoint: string;
  feature: 'document.ask' | 'document.summarize';
  instruction: string;
  signal: AbortSignal;
  currentDocument(): { id: string; revision: number };
  onProgress(message: string): void;
}): Promise<DocumentAnalysis> {
  const { document, signal, onProgress } = options;
  const passages = await collectDocumentPassages(options.engine, document, signal,
    page => onProgress(`Reading page ${page} / ${document.pageOrder.length}`));
  if (!passages.length) throw new Error('No extractable text in this document. Use desktop OCR for scanned pages.');
  signal.throwIfAborted();
  const current = options.currentDocument();
  if (current.id !== document.id || current.revision !== document.revision) {
    throw new Error('Document changed while collecting text; start again from the current revision');
  }

  const sectionPassages = passageBatches(passages);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
    pageOrder: document.pageOrder, passages,
  })));
  const contentFingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const store = new IndexedDbTaskStore<SummaryPayload, SummaryResult>();
  const runner = new LongTaskRunner(store);
  const taskType = options.feature;
  const createdAt = Date.now();
  const candidate = await createLongTask<SummaryPayload, SummaryResult>({
    id: `summary-${document.id}-${createdAt}-${crypto.randomUUID()}`,
    docId: document.id, baseRevision: document.revision, sourceIds: document.sourceIds,
    taskType, scope: { createdAt, pagesScanned: document.pageOrder.length,
      pagesWithText: new Set(passages.map(passage => passage.pageId)).size, passagesScanned: passages.length },
    contentFingerprint, model: 'gemini-3.8-flash-high', templateVersion: '1', protocolVersion: 1,
    settings: { instruction: options.instruction, feature: options.feature },
    batches: [...sectionPassages.map((items, index) => ({
      id: `section-${index + 1}`, content: items.map(item => item.text).join('\n'),
      payload: { kind: 'section' as const, passages: items },
    })), { id: 'overview', content: contentFingerprint,
      payload: { kind: 'overview' as const, contentFingerprint } }],
  });
  const previous = await store.getLatestTaskForDocument(document.id, taskType);
  const task = previous && previous.status !== 'failed' && previous.status !== 'cancelled' &&
    previous.baseRevision === document.revision && previous.hashKey === candidate.hashKey
    ? await runner.restore(previous.id) : candidate;
  if (task === candidate) await store.saveTask(task);
  const completed = analysisFromTask(task);
  if (completed) return completed;

  const workflow = new AiWorkflow<never>({
    endpoint: options.endpoint, authorization: options.authorization, getCurrentDocument: options.currentDocument,
    nextTransactionId: () => crypto.randomUUID(), apply: async () => { throw new Error('Document analysis cannot edit the PDF'); },
  });
  const ask = async (feature: AiFeature, items: readonly DocumentPassage[], instruction: string, runSignal: AbortSignal) => {
    const evidence = items.map((item, index) => ({
      id: `e${index + 1}`, docId: document.id, revision: document.revision,
      pageId: item.pageId, pageNumber: item.pageNumber, blockId: item.blockId,
      text: item.text, characterRange: item.range, bounds: item.bounds,
    }));
    const request: AiRequest = {
      protocolVersion: 1, requestId: crypto.randomUUID(), feature,
      document: { id: document.id, revision: document.revision },
      context: { scope: 'document', evidence }, instruction, options: {},
    };
    const snapshot = createEvidenceSnapshot(request, items.map((item, index) => ({
      evidenceId: `e${index + 1}`, sourceId: item.sourceId, blockText: item.blockText,
    })));
    const response = (await workflow.run({ request, snapshot, sourceIds: document.sourceIds, signal: runSignal })).response.result;
    if (response.kind !== 'answer' || !response.text.trim()) throw new Error('The model did not return a complete document answer');
    const citations = response.citations.flatMap(citation => {
      const location = resolveCitation(snapshot, citation, options.currentDocument());
      return location.status === 'resolved' ? [{ pageId: location.frozenLocation.pageId,
        pageNumber: location.frozenLocation.pageNumber, blockId: location.frozenLocation.blockId,
        ...(citation.quote ? { quote: citation.quote } : {}) }] : [];
    });
    return { text: response.text, citations };
  };

  signal.throwIfAborted();
  const pause = () => { void runner.pauseTask(task.id); };
  signal.addEventListener('abort', pause, { once: true });
  try {
    const finished = await runner.continueTask(task.id, options.authorization,
      async (_task, batch: Readonly<LongTaskBatch<SummaryPayload, SummaryResult>>, runSignal) => {
        const now = options.currentDocument();
        if (now.id !== document.id || now.revision !== document.revision) {
          await runner.pauseTask(task.id);
          throw new Error('Document changed during analysis');
        }
        if (batch.payload.kind === 'section') {
          const index = _task.batches.findIndex(item => item.id === batch.id);
          onProgress(`Analyzing section ${index + 1} / ${sectionPassages.length}`);
          const instruction = options.feature === 'document.ask'
            ? `Check this section for evidence relevant to: ${options.instruction}. Report findings or say no evidence in this section.`
            : `Summarize this section, preserving specific facts and citations. ${options.instruction}`;
          return ask('document.summarize', batch.payload.passages, instruction, runSignal);
        }

        const saved = await store.loadTask(task.id);
        if (!saved) throw new Error('Saved document analysis was not found');
        let level = saved.batches.slice(0, -1).map((sectionBatch, index) => {
          if (!sectionBatch.result) throw new Error('Missing section summary');
          const source = sectionPassages[index]![0]!;
          return { ...source, blockText: sectionBatch.result.text, text: sectionBatch.result.text,
            range: [0, sectionBatch.result.text.length] as [number, number] };
        });
        let depth = 0;
        while (level.length > 1) {
          runSignal.throwIfAborted();
          onProgress(depth ? `Combining summaries (level ${depth + 1})` : 'Combining document sections');
          const next: DocumentPassage[] = [];
          for (const items of passageBatches(level)) {
            const summary = await ask('document.summarize', items,
              options.feature === 'document.ask'
                ? `Consolidate these section findings to answer: ${options.instruction}. Do not claim unseen evidence.`
                : `Combine these section summaries into an overview and reading outline. ${options.instruction}`,
              runSignal);
            const source = items[0]!;
            next.push({ ...source, blockText: summary.text, text: summary.text,
              range: [0, summary.text.length] });
          }
          if (next.length >= level.length) {
            return { text: 'The document was fully scanned, but its section summaries could not be condensed further. Read each section below.', citations: [] };
          }
          level = next;
          depth += 1;
        }
        return { text: level[0]!.text, citations: [] };
      },
      updated => onProgress(`Completed ${updated.batches.filter(batch => batch.status === 'completed').length} / ${updated.batches.length} summary batches`),
    );
    if (signal.aborted || finished.status !== 'completed') {
      throw new Error('Document analysis paused. Re-authorize and generate again to resume.');
    }
    const now = options.currentDocument();
    if (now.id !== document.id || now.revision !== document.revision) {
      throw new Error('Document changed during analysis; current results belong to an older revision');
    }
    const analysis = analysisFromTask(finished);
    if (!analysis) throw new Error('Document analysis finished without a complete overview');
    return analysis;
  } finally {
    signal.removeEventListener('abort', pause);
  }
}
