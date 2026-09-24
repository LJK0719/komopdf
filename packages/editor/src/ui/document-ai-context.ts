import type { AiFeature, AiRequest, DocumentInfo, EngineAdapter, TextBlock } from '@pdf-editor/contracts';
import { AiWorkflow, createEvidenceSnapshot, resolveCitation, type DocumentAiAuthorization } from '@pdf-editor/ai-client';

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

  const workflow = new AiWorkflow<never>({
    endpoint: options.endpoint, authorization: options.authorization, getCurrentDocument: options.currentDocument,
    nextTransactionId: () => crypto.randomUUID(), apply: async () => { throw new Error('Document analysis cannot edit the PDF'); },
  });
  const ask = async (feature: AiFeature, items: readonly DocumentPassage[], instruction: string) => {
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
    const response = (await workflow.run({ request, snapshot, sourceIds: document.sourceIds, signal })).response.result;
    if (response.kind !== 'answer' || !response.text.trim()) throw new Error('The model did not return a complete document answer');
    const citations = response.citations.flatMap(citation => {
      const location = resolveCitation(snapshot, citation, options.currentDocument());
      return location.status === 'resolved' ? [{ pageId: location.frozenLocation.pageId,
        pageNumber: location.frozenLocation.pageNumber, blockId: location.frozenLocation.blockId,
        ...(citation.quote ? { quote: citation.quote } : {}) }] : [];
    });
    return { text: response.text, citations };
  };

  const batches = passageBatches(passages);
  const sections: DocumentAnalysis['sections'] = [];
  for (const [index, batch] of batches.entries()) {
    signal.throwIfAborted();
    onProgress(`Analyzing section ${index + 1} / ${batches.length}`);
    const instruction = options.feature === 'document.ask'
      ? `Check this section for evidence relevant to: ${options.instruction}. Report findings or say no evidence in this section.`
      : `Summarize this section, preserving specific facts and citations. ${options.instruction}`;
    sections.push(await ask('document.summarize', batch, instruction));
  }

  let level = sections.map((section, index) => {
    const source = batches[index]![0]!;
    return { ...source, blockText: section.text, text: section.text,
      range: [0, section.text.length] as [number, number] };
  });
  let depth = 0;
  while (level.length > 1) {
    signal.throwIfAborted();
    onProgress(depth ? `Combining summaries (level ${depth + 1})` : 'Combining document sections');
    const next: DocumentPassage[] = [];
    for (const batch of passageBatches(level)) {
      const summary = await ask('document.summarize', batch,
        options.feature === 'document.ask'
          ? `Consolidate these section findings to answer: ${options.instruction}. Do not claim unseen evidence.`
          : `Combine these section summaries into an overview and reading outline. ${options.instruction}`);
      const source = batch[0]!;
      next.push({ ...source, blockText: summary.text, text: summary.text,
        range: [0, summary.text.length] });
    }
    if (next.length >= level.length) {
      return { document: { id: document.id, revision: document.revision },
        overview: 'The document was fully scanned, but its section summaries could not be condensed further. Read each section below.',
        sections, pagesScanned: document.pageOrder.length,
        pagesWithText: new Set(passages.map(passage => passage.pageId)).size, passagesScanned: passages.length };
    }
    level = next;
    depth += 1;
  }
  return { document: { id: document.id, revision: document.revision },
    overview: level[0]?.text ?? sections[0]!.text,
    sections, pagesScanned: document.pageOrder.length,
        pagesWithText: new Set(passages.map(passage => passage.pageId)).size, passagesScanned: passages.length };
}
