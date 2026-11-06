import { AI_LIMITS, aiRequestSchema, type AiRequest, type AiSourceDocument, type DocumentInfo, type EngineAdapter, type PageModel, type ReferenceEvidence } from '@pdf-editor/contracts';
import { createEvidenceSnapshot, DocumentAiAuthorization } from '@pdf-editor/ai-client';
import { analyzeFullDocument, isExhaustiveQuestion, passagesForBlock, readingTextPassages, selectRelevantPassages, type DocumentPassage } from './document-ai-context.js';
import { askReading, condenseReading } from './reading-analysis.js';
import type { DocumentReading } from './kolmo-reading.js';
import { encodeRenderedImage } from './AiPanelImage.js';
import { unrecognizedImageRegions } from './ocr-regions.js';
import { materialDocument, materialPassages, MaterialContextError, MATERIAL_EXPIRED, type MaterialDocuments } from './komo-materials.js';
import type { AiMaterial } from './text-actions.js';

export type ChatScope = 'document' | 'page' | 'selection';
export type ChatVisualMode = 'auto' | 'always' | 'text';
export type ChatTurn = { role: 'user' | 'assistant'; text: string };
export type ChatSourceContext = { documentId: string; revision: number; passages: DocumentPassage[]; scanPageIds: string[] };
export const CHAT_TEXT_LIMIT = 36_000;
export const CHAT_COPY_RESTRICTED = 'This PDF does not allow copying its content.';
export const SCAN_RECOMMENDATION = 'Read the full PDF with KolmoPDF and continue the conversation here.';

export class ChatContextError extends Error {
  constructor(message: string, readonly scanned = false, readonly action?: 'page' | 'image' | 'clear') { super(message); }
}
export function needsFullDocument(question: string): boolean {
  return isExhaustiveQuestion(question) || /^\s*(summari[sz]e|summary)\s*[.!?]?\s*$/iu.test(question) || /\bsummari[sz]e\b.*\b(document|pdf|paper|book)\b|\b(document|pdf|paper|book)\b.*\bsummary\b|总结|概括|摘要/iu.test(question);
}
function prefix(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = 0;
  for (const item of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const next = item.index + item.segment.length;
    if (next > limit) break;
    end = next;
  }
  return text.slice(0, end);
}
export function relevantContextPassages(passages: readonly DocumentPassage[], question: string, budget: number, maxPassages = 256): DocumentPassage[] {
  if (passages.length <= maxPassages && passages.reduce((sum, passage) => sum + passage.text.length, 0) <= budget) return [...passages];
  // Split before ranking so a large high-scoring block can fit the actual budget.
  const pieces = passages.flatMap(passage => {
    if (passage.text.length <= budget) return [passage];
    const result: DocumentPassage[] = [];
    let start = 0;
    while (start < passage.text.length) {
      const text = prefix(passage.text.slice(start), budget);
      if (!text) break;
      result.push({ ...passage, text, range: [passage.range[0] + start, passage.range[0] + start + text.length] });
      start += text.length;
    }
    return result;
  });
  const relevant = selectRelevantPassages(pieces, question, budget, maxPassages);
  const candidates = relevant.length ? relevant : pieces;
  const selected: DocumentPassage[] = [];
  let remaining = budget;
  for (const passage of candidates) {
    if (remaining <= 0 || selected.length >= maxPassages) break;
    const text = prefix(passage.text, remaining);
    if (!text) continue;
    selected.push({ ...passage, text, range: [passage.range[0], passage.range[0] + text.length] });
    remaining -= text.length;
  }
  return selected;
}

export async function prepareChatContext(options: {
  engine: EngineAdapter; document: DocumentInfo; page: PageModel | null; currentPageId?: string;
  selectedIds: readonly string[]; scope: ChatScope; instruction: string;
  visualMode?: ChatVisualMode; intent?: 'summary'; history: readonly ChatTurn[]; signal: AbortSignal;
  materials?: readonly AiMaterial[]; materialContext?: MaterialDocuments; name?: string;
  reading?: DocumentReading; sourceContext?: ChatSourceContext; readDocument?(): Promise<DocumentReading | null>;
  endpoint?: string; fetch?: typeof fetch; onProgress?(message: string): void;
}) {
  const { engine, document, page, scope, signal } = options;
  if (document.permissions.copy !== true) throw new ChatContextError(CHAT_COPY_RESTRICTED);
  const documents: MaterialDocuments = options.materialContext ?? { document };
  const assertCurrent = (expected: DocumentInfo) => {
    const current = materialDocument(documents, expected.id);
    if (!current || current.revision !== expected.revision || current.permissions.copy !== true) throw new MaterialContextError(MATERIAL_EXPIRED);
    return current;
  };
  const pageIds = scope === 'document' ? document.pageOrder : page ? [page.id] : [];
  if (!pageIds.length) throw new ChatContextError('Open a PDF before asking komo.');
  if (scope === 'selection' && !options.selectedIds.length) throw new ChatContextError('Select text to continue.');
  let reading = scope === 'document' && options.reading?.documentId === document.id && options.reading.revision === document.revision ? options.reading : undefined;
  const cached = options.sourceContext?.documentId === document.id && options.sourceContext.revision === document.revision ? options.sourceContext : undefined;
  const passages: DocumentPassage[] = [];
  const scanPageIds: string[] = [];
  const visualMode = options.visualMode ?? 'auto';
  if (!reading && cached && scope !== 'selection') {
    passages.push(...cached.passages.filter(passage => pageIds.includes(passage.pageId)));
    scanPageIds.push(...cached.scanPageIds.filter(id => pageIds.includes(id)));
  } else if (!reading) for (const pageId of pageIds) {
    signal.throwIfAborted(); assertCurrent(document);
    const blocks = await engine.extract({ docId: document.id, pageIds: [pageId] });
    signal.throwIfAborted(); assertCurrent(document);
    const selected = scope === 'selection'
      ? blocks.filter(block => block.sourceObjectIds.some(id => options.selectedIds.includes(id)) || page?.objects.some(object => options.selectedIds.includes(object.id) && object.textBlock?.id === block.id))
      : blocks;
    const readable = selected.filter(block => block.runs.some(run => run.text.trim()));
    if (!readable.length && scope !== 'selection') scanPageIds.push(pageId);
    else if (scope !== 'selection' && visualMode !== 'text' && (page?.id === pageId || readable.reduce((sum, block) => sum + block.runs.reduce((length, run) => length + run.text.length, 0), 0) < 500)) {
      const description = page?.id === pageId ? page : await engine.describePage(document.id, pageId);
      signal.throwIfAborted(); assertCurrent(document);
      if (unrecognizedImageRegions(description).length) scanPageIds.push(pageId);
    }
    for (const block of readable) passages.push(...passagesForBlock(block, pageId, document.pageOrder.indexOf(pageId) + 1, document.sourceIds));
  }
  const sourceContext = scope === 'document' && !reading ? { documentId: document.id, revision: document.revision, passages, scanPageIds } : cached;
  if (!reading && scope === 'document' && scanPageIds.length > AI_LIMITS.imageCount && options.readDocument) {
    reading = await options.readDocument() ?? undefined;
    assertCurrent(document);
  }
  const materials = options.materials ?? [];
  if (materials.length > 15) throw new ChatContextError('This question includes too much material. Remove an attachment and try again.');
  const budget = Math.floor(CHAT_TEXT_LIMIT / (materials.length + 1));
  const referenceLimit = Math.max(1, Math.floor(250 / Math.max(1, materials.length)) - 3);
  const fullQuestion = options.intent === 'summary' || needsFullDocument(options.instruction);
  const referenceEvidence: ReferenceEvidence[] = [];
  const sourceDocuments = new Map<string, AiSourceDocument>();
  const coverage: { documentId: string; name: string; kind: 'full' | 'excerpts' | 'analysis'; pages: number[]; pagesScanned: number }[] = [];
  const sourceIds = new Set(document.sourceIds);
  const declare = (source: DocumentInfo, name: string, kind: 'full' | 'excerpts' | 'analysis', pages: number[], pagesScanned: number) => {
    const key = JSON.stringify([source.id, source.revision]);
    const previous = sourceDocuments.get(key);
    sourceDocuments.set(key, { id: source.id, revision: source.revision, name,
      sourceIds: [...new Set([...(previous?.sourceIds ?? []), ...source.sourceIds])],
      pageIds: source.pageOrder.length ? [...source.pageOrder] : previous?.pageIds ?? [],
      coverage: !source.pageOrder.length && previous?.coverage ? previous.coverage
        : { kind, pageNumbers: pages, pagesScanned } });
    source.sourceIds.forEach(id => sourceIds.add(id));
    coverage.push({ documentId: source.id, name, kind, pages, pagesScanned });
  };
  const mainName = options.name || 'Current PDF';
  const readingOptions = (source = document, name = mainName) => {
    if (!options.endpoint) throw new ChatContextError('Unable to connect to komo.');
    return { document: source, name, endpoint: options.endpoint, ...(options.fetch ? { fetch: options.fetch } : {}),
      signal, currentDocument: () => assertCurrent(source), instruction: options.instruction,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}) };
  };
  const referenceText = (text: string, materialId: string) => referenceEvidence.push({ id: `r${referenceEvidence.length + 1}`,
    docId: document.id, revision: document.revision, sourceId: document.sourceIds[0]!, materialId, kind: 'analysis', text });
  const analyze = async (source: DocumentInfo, name: string, materialId: string, sourcePassages?: DocumentPassage[]) => {
    if (!options.endpoint) throw new ChatContextError('Unable to connect to komo.');
    const authorization = new DocumentAiAuthorization(source.id);
    authorization.enable(source.sourceIds);
    try {
      const analysis = await analyzeFullDocument({ engine, document: source, authorization,
        ...(source.id === document.id ? { passages } : sourcePassages ? { passages: sourcePassages } : {}),
        endpoint: options.endpoint, ...(options.fetch ? { fetch: options.fetch } : {}),
        feature: 'document.summarize', instruction: options.instruction, signal,
        currentDocument: () => assertCurrent(source), onProgress: message => options.onProgress?.(message),
      });
      signal.throwIfAborted(); assertCurrent(source);
      const location = analysis.sections.flatMap(section => section.citations)[0];
      const sourceId = source.sourceIds[0];
      if (!sourceId) throw new MaterialContextError(MATERIAL_EXPIRED);
      referenceEvidence.push({ id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: source.revision,
        sourceId, materialId, kind: 'analysis', text: await condenseReading(readingOptions(source, name), analysis.overview, budget),
        ...(location ? { pageId: location.pageId, pageNumber: location.pageNumber, blockId: location.blockId } : {}) });
      declare(source, name, 'analysis', source.pageOrder.map((_, i) => i + 1), analysis.pagesScanned);
    } finally { authorization.revoke(); }
  };

  const primaryTooLong = passages.length > 256 || passages.reduce((sum, passage) => sum + passage.text.length, 0) > budget;
  let primary = relevantContextPassages(passages, options.instruction, budget);
  if (reading) {
    primary = [];
    const complete = reading.text.length <= budget;
    const text = fullQuestion && !complete ? await condenseReading(readingOptions(), reading.text, budget)
      : complete ? reading.text : (() => {
        const sections = readingTextPassages(reading.text);
        const relevant = selectRelevantPassages(sections, options.instruction, budget);
        return prefix((relevant.length ? relevant : sections).map(section => section.text).join('\n\n'), budget);
      })();
    referenceText(text, `kolmo:${reading.jobId}`);
    declare(document, mainName, complete ? 'full' : fullQuestion ? 'analysis' : 'excerpts', document.pageOrder.map((_, i) => i + 1), document.pageOrder.length);
  } else if (scope === 'document' && primaryTooLong && fullQuestion) {
    await analyze(document, mainName, `document:${document.id}:${document.revision}`); primary = [];
  } else declare(document, mainName, scope === 'document' && !primaryTooLong ? 'full' : 'excerpts', [...new Set(primary.map(passage => passage.pageNumber))], pageIds.length);

  const currentPageId = options.currentPageId ?? page?.id ?? pageIds[0]!;
  const visualQuestion = /\b(figure|chart|diagram|image|graph|picture|table|screenshot|visible)\b|图|表|截图|图片/iu.test(options.instruction);
  let imagePageIds = scope === 'selection' || visualMode === 'text' ? []
    : visualMode === 'always' ? [...pageIds]
      : [...(reading ? [] : scanPageIds), ...(visualQuestion ? [currentPageId, ...primary.map(passage => passage.pageId)] : [])];
  imagePageIds = [...new Set(imagePageIds)].filter(id => pageIds.includes(id));
  const imagesFor = async (ids: readonly string[], source = document) => {
    const images: NonNullable<AiRequest['context']['images']> = [];
    for (const pageId of ids) {
      signal.throwIfAborted(); assertCurrent(source);
      const description = source.id === document.id && page?.id === pageId ? page : await engine.describePageMetrics(source.id, pageId);
      const scale = Math.min(1.5, AI_LIMITS.imageLongestEdge / Math.max(description.widthPt, description.heightPt));
      const render = await engine.render({ docId: source.id, pageId, scale }, { signal });
      signal.throwIfAborted(); assertCurrent(source);
      images.push({ mimeType: 'image/jpeg', data: encodeRenderedImage(render, 'image/jpeg') });
    }
    return images;
  };
  const pagesFor = (ids: readonly string[]) => ids.map(id => ({ id, pageNumber: document.pageOrder.indexOf(id) + 1 }));
  if (imagePageIds.length > AI_LIMITS.imageCount) {
    const summaries: string[] = [];
    for (let offset = 0; offset < imagePageIds.length; offset += AI_LIMITS.imageCount) {
      options.onProgress?.('Reading document…');
      const ids = imagePageIds.slice(offset, offset + AI_LIMITS.imageCount);
      summaries.push(await askReading({ ...readingOptions(), instruction: `Read these pages and summarize the details relevant to: ${options.instruction}` },
        passages.filter(passage => ids.includes(passage.pageId)).map(passage => passage.text), { images: await imagesFor(ids), pages: pagesFor(ids) }));
    }
    referenceText(await condenseReading(readingOptions(), summaries.join('\n\n'), budget), 'visual-reading');
    declare(document, mainName, 'analysis', pageIds.map(id => document.pageOrder.indexOf(id) + 1), pageIds.length);
    imagePageIds = [];
  } else imagePageIds = imagePageIds.slice(0, AI_LIMITS.imageCount);

  for (const material of materials) {
    signal.throwIfAborted();
    const source = materialDocument(documents, material.documentId);
    if (!source || (material.kind !== 'text' && source.revision !== material.revision) || source.permissions.copy !== true) throw new MaterialContextError(MATERIAL_EXPIRED);
    if (material.kind === 'text') {
      const sourceId = source.sourceIds[0];
      if (!sourceId) throw new MaterialContextError(MATERIAL_EXPIRED);
      declare({ ...source, revision: material.revision, pageOrder: [] }, material.name, 'excerpts', [], 0);
      if (material.text) referenceEvidence.push({ id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: material.revision,
        sourceId, materialId: material.id, kind: 'generated', role: 'attached', text: prefix(material.text, budget) });
      if (material.generatedText) referenceEvidence.push({ id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: material.revision,
        sourceId, materialId: material.id, kind: 'generated', role: 'result', text: prefix(material.generatedText, budget) });
      continue;
    }
    const original = await materialPassages(material, { ...documents, engine }, signal);
    const tooLong = original.length > referenceLimit || original.reduce((sum, passage) => sum + passage.text.length, 0) > budget;
    const visualPages: string[] = [];
    if (material.kind === 'document' && visualMode !== 'text') for (const pageId of source.pageOrder) {
      signal.throwIfAborted(); assertCurrent(source);
      const pagePassages = original.filter(passage => passage.pageId === pageId);
      if (!pagePassages.length || visualMode === 'always'
        || unrecognizedImageRegions(await engine.describePage(source.id, pageId)).length) visualPages.push(pageId);
    }
    if (visualPages.length) {
      const summaries: string[] = [];
      for (let offset = 0; offset < visualPages.length; offset += AI_LIMITS.imageCount) {
        const ids = visualPages.slice(offset, offset + AI_LIMITS.imageCount);
        summaries.push(await askReading({ ...readingOptions(source, material.name),
          instruction: `Read these pages and summarize the details relevant to: ${options.instruction}` },
          original.filter(passage => ids.includes(passage.pageId)).map(passage => passage.text),
          { images: await imagesFor(ids, source), pages: ids.map(id => ({ id, pageNumber: source.pageOrder.indexOf(id) + 1 })) }));
      }
      referenceEvidence.push({ id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: source.revision,
        sourceId: source.sourceIds[0]!, materialId: material.id, kind: 'analysis',
        text: await condenseReading(readingOptions(source, material.name), summaries.join('\n\n'), budget) });
    }
    if (material.kind === 'document' && tooLong && fullQuestion) await analyze(source, material.name, material.id, original);
    else {
      const selected = relevantContextPassages(original, options.instruction, visualPages.length ? Math.floor(budget / 2) : budget, referenceLimit);
      for (const passage of selected) referenceEvidence.push({
        id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: source.revision, sourceId: passage.sourceId,
        materialId: material.id, kind: 'source', text: passage.text,
        pageId: passage.pageId, pageNumber: passage.pageNumber, blockId: passage.blockId, characterRange: passage.range,
      });
      const completeText = selected.reduce((sum, passage) => sum + passage.text.length, 0) === original.reduce((sum, passage) => sum + passage.text.length, 0);
      declare(source, material.name, visualPages.length ? 'analysis' : material.kind === 'document' && completeText && original.length ? 'full' : 'excerpts',
        [...new Set([...selected.map(passage => passage.pageNumber), ...visualPages.map(id => source.pageOrder.indexOf(id) + 1)])],
        material.kind === 'document' ? source.pageOrder.length : new Set(material.locations.map(location => location.pageId)).size);
    }
    if (material.generatedText) {
      const sourceId = source.sourceIds[0];
      if (!sourceId) throw new MaterialContextError(MATERIAL_EXPIRED);
      const generatedRevision = material.generatedFromRevision ?? material.revision;
      if (generatedRevision !== source.revision) declare({ ...source, revision: generatedRevision, pageOrder: [] }, material.name, 'excerpts', [], 0);
      referenceEvidence.push({ id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: generatedRevision,
        sourceId, materialId: material.id, kind: 'generated', role: 'result', text: prefix(material.generatedText, budget) });
    }
    assertCurrent(source);
  }
  if (!primary.length && !imagePageIds.length && !referenceEvidence.length) throw new ChatContextError('No text was found in this PDF.', true, 'image');
  const images = await imagesFor(imagePageIds);
  const request: AiRequest = aiRequestSchema.parse({
    protocolVersion: 1, requestId: crypto.randomUUID(), feature: images.length ? 'image.explain' : 'document.ask',
    document: { id: document.id, revision: document.revision },
    context: { scope, history: options.history.slice(-12),
      evidence: primary.map((item, index) => ({ id: `e${index + 1}`, docId: document.id, revision: document.revision,
        pageId: item.pageId, pageNumber: item.pageNumber, blockId: item.blockId, text: item.text, characterRange: item.range, bounds: item.bounds })),
      ...(sourceDocuments.size ? { sourceDocuments: [...sourceDocuments.values()] } : {}),
      ...(referenceEvidence.length ? { referenceEvidence } : {}),
      ...(images.length ? { images, pages: pagesFor(imagePageIds) } : {}),
    }, instruction: options.instruction, options: {},
  });
  const limit = images.length ? AI_LIMITS.imageBodyBytes : AI_LIMITS.textBodyBytes;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const history = request.context.history!;
  while (history.length && (bytes(history) > 128 * 1024 || bytes(request) > limit)) {
    history.shift();
    while (history[0]?.role === 'assistant') history.shift();
  }
  if (bytes(request) > limit) throw new ChatContextError('This request is too large or its context is unsupported. Choose the current page and try again.', false, 'page');
  const snapshot = createEvidenceSnapshot(request, primary.map((item, index) => ({ evidenceId: `e${index + 1}`, sourceId: item.sourceId, blockText: item.blockText })));
  return { request, snapshot, scanned: scanPageIds.length > 0, coverage, sourceIds: [...sourceIds], sourceContext, reading,
    pageNumbers: [...new Set(primary.map(item => item.pageNumber))], imagePageNumbers: pagesFor(imagePageIds).map(item => item.pageNumber) };
}
export type PreparedChatContext = Awaited<ReturnType<typeof prepareChatContext>>;
