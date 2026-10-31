import { AI_LIMITS, aiRequestSchema, type AiRequest, type AiSourceDocument, type DocumentInfo, type EngineAdapter, type PageModel, type ReferenceEvidence } from '@pdf-editor/contracts';
import { createEvidenceSnapshot, DocumentAiAuthorization } from '@pdf-editor/ai-client';
import { analyzeFullDocument, isExhaustiveQuestion, passagesForBlock, selectRelevantPassages, type DocumentPassage } from './document-ai-context.js';
import { encodeRenderedImage } from './AiPanelImage.js';
import { materialDocument, materialPassages, MaterialContextError, MATERIAL_EXPIRED, type MaterialDocuments } from './komo-materials.js';
import type { AiMaterial } from './text-actions.js';

export type ChatScope = 'document' | 'page' | 'selection';
export type ChatVisualMode = 'auto' | 'always' | 'text';
export type ChatTurn = { role: 'user' | 'assistant'; text: string };
export const CHAT_TEXT_LIMIT = 36_000;
export const CHAT_COPY_RESTRICTED = 'This PDF does not allow copying its content, so komo cannot send its text or page images for Q&A. Open a copy-enabled version provided by the document owner.';
export const SCAN_RECOMMENDATION = 'For scanned PDFs, use KOLMOPDF to convert to Markdown, then bring the Markdown to another large language model. Structured text makes headings, tables and formulas easier to follow, search and cite, and avoids repeatedly reading images in each turn. Check OCR and complex layouts against the original.';

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
export function relevantContextPassages(passages: readonly DocumentPassage[], question: string, budget: number): DocumentPassage[] {
  if (passages.reduce((sum, passage) => sum + passage.text.length, 0) <= budget) return [...passages];
  const relevant = selectRelevantPassages(passages, question);
  const candidates = relevant.length ? relevant : passages;
  const selected: DocumentPassage[] = [];
  let remaining = budget;
  for (const passage of candidates) {
    if (remaining <= 0) break;
    const text = prefix(passage.text, remaining);
    if (!text) continue;
    selected.push({ ...passage, text, range: [passage.range[0], passage.range[0] + text.length] });
    remaining -= text.length;
  }
  return selected;
}

export async function prepareChatContext(options: {
  engine: EngineAdapter; document: DocumentInfo; page: PageModel | null;
  selectedIds: readonly string[]; scope: ChatScope; instruction: string;
  visualMode?: ChatVisualMode; history: readonly ChatTurn[]; signal: AbortSignal;
  materials?: readonly AiMaterial[]; materialContext?: MaterialDocuments; name?: string;
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
  if (scope === 'selection' && !options.selectedIds.length) throw new ChatContextError('Select text objects or choose another scope.');
  const passages: DocumentPassage[] = [];
  let imagePageIds: string[] = [];
  const descriptions = new Map<string, PageModel>();
  const visualMode = options.visualMode ?? 'auto';
  for (const pageId of pageIds) {
    signal.throwIfAborted(); assertCurrent(document);
    const blocks = await engine.extract({ docId: document.id, pageIds: [pageId] });
    signal.throwIfAborted(); assertCurrent(document);
    const selectedBlocks = scope === 'selection'
      ? blocks.filter(block => block.sourceObjectIds.some(id => options.selectedIds.includes(id)) || page?.objects.some(object => options.selectedIds.includes(object.id) && object.textBlock?.id === block.id))
      : blocks;
    const readable = selectedBlocks.filter(block => block.runs.some(run => run.text.trim()));
    if (scope !== 'selection' && visualMode !== 'text') {
      const description = page?.id === pageId ? page : await engine.describePage(document.id, pageId);
      signal.throwIfAborted(); assertCurrent(document);
      descriptions.set(pageId, description);
      if (visualMode === 'always' || !readable.length || description.objects.some(object => ['image', 'form', 'shading'].includes(object.type))) imagePageIds.push(pageId);
      if (imagePageIds.length > AI_LIMITS.imageCount && !passages.length && !readable.length) {
        throw new ChatContextError('More than two pages need images. Choose the current page, use text-only context, or convert the PDF with KOLMOPDF.', true, 'page');
      }
    }
    for (const block of readable) passages.push(...passagesForBlock(block, pageId, document.pageOrder.indexOf(pageId) + 1, document.sourceIds));
  }

  const materials = options.materials ?? [];
  const budget = Math.max(1000, Math.floor(CHAT_TEXT_LIMIT / (materials.length + 1)));
  const fullQuestion = needsFullDocument(options.instruction);
  const referenceEvidence: ReferenceEvidence[] = [];
  const sourceDocuments = new Map<string, AiSourceDocument>();
  const coverage: { documentId: string; name: string; kind: 'full' | 'excerpts' | 'analysis'; pages: number[]; pagesScanned: number }[] = [];
  const sourceIds = new Set(document.sourceIds);
  const declare = (source: DocumentInfo, name: string, kind: 'full' | 'excerpts' | 'analysis', pages: number[], pagesScanned: number) => {
    sourceDocuments.set(JSON.stringify([source.id, source.revision]), { id: source.id, revision: source.revision, name,
      sourceIds: [...source.sourceIds], pageIds: [...source.pageOrder], coverage: { kind, pageNumbers: pages, pagesScanned } });
    source.sourceIds.forEach(id => sourceIds.add(id));
    coverage.push({ documentId: source.id, name, kind, pages, pagesScanned });
  };
  const analyze = async (source: DocumentInfo, name: string, materialId: string) => {
    if (!options.endpoint) throw new ChatContextError('Choose a smaller scope or enable full-document analysis.');
    const authorization = new DocumentAiAuthorization(source.id);
    authorization.enable(source.sourceIds);
    try {
      const analysis = await analyzeFullDocument({ engine, document: source, authorization,
        endpoint: options.endpoint, ...(options.fetch ? { fetch: options.fetch } : {}),
        feature: 'document.summarize', instruction: options.instruction, signal,
        currentDocument: () => assertCurrent(source), onProgress: message => options.onProgress?.(message),
      });
      signal.throwIfAborted(); assertCurrent(source);
      const location = analysis.sections.flatMap(section => section.citations)[0];
      const sourceId = source.sourceIds[0];
      if (!sourceId) throw new MaterialContextError(MATERIAL_EXPIRED);
      referenceEvidence.push({ id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: source.revision,
        sourceId, materialId, kind: 'analysis', text: analysis.overview,
        ...(location ? { pageId: location.pageId, pageNumber: location.pageNumber, blockId: location.blockId } : {}) });
      declare(source, name, 'analysis', source.pageOrder.map((_, i) => i + 1), analysis.pagesScanned);
    } finally { authorization.revoke(); }
  };

  const mainName = options.name || 'Current PDF';
  const primaryTooLong = passages.reduce((sum, passage) => sum + passage.text.length, 0) > budget;
  const fullAnalysis = scope === 'document' && primaryTooLong && fullQuestion;
  let primary = relevantContextPassages(passages, options.instruction, budget);
  if (fullAnalysis) {
    await analyze(document, mainName, `document:${document.id}:${document.revision}`);
    primary = [];
    // The batched analysis reads text, not unseen page images. Its coverage is explicit.
    imagePageIds = [];
  } else {
    declare(document, mainName, scope === 'document' && !primaryTooLong ? 'full' : 'excerpts',
      [...new Set(primary.map(passage => passage.pageNumber))], pageIds.length);
  }
  if (imagePageIds.length > AI_LIMITS.imageCount) {
    throw new ChatContextError('More than two pages need images. Choose the current page, use text-only context, or convert the PDF with KOLMOPDF.', true, 'page');
  }
  for (const material of materials) {
    signal.throwIfAborted();
    const source = materialDocument(documents, material.documentId);
    if (!source || (material.kind !== 'text' && source.revision !== material.revision) || source.permissions.copy !== true) throw new MaterialContextError(MATERIAL_EXPIRED);
    if (material.kind === 'text') {
      const sourceId = source.sourceIds[0];
      if (!sourceId) throw new MaterialContextError(MATERIAL_EXPIRED);
      declare({ ...source, revision: material.revision, pageOrder: [] }, material.name, 'excerpts', [], 0);
      if (material.text) referenceEvidence.push({ id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: material.revision,
        sourceId, materialId: material.id, kind: 'generated', role: 'attached', text: material.text });
      if (material.generatedText) referenceEvidence.push({ id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: material.revision,
        sourceId, materialId: material.id, kind: 'generated', role: 'result', text: material.generatedText });
      continue;
    }
    const original = await materialPassages(material, { ...documents, engine }, signal);
    const tooLong = original.reduce((sum, passage) => sum + passage.text.length, 0) > budget;
    if (material.kind === 'document' && tooLong && fullQuestion) await analyze(source, material.name, material.id);
    else {
      const selected = relevantContextPassages(original, options.instruction, budget);
      for (const passage of selected) referenceEvidence.push({
        id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: source.revision, sourceId: passage.sourceId,
        materialId: material.id, kind: 'source', text: passage.text,
        pageId: passage.pageId, pageNumber: passage.pageNumber, blockId: passage.blockId, characterRange: passage.range,
      });
      declare(source, material.name, material.kind === 'document' && !tooLong ? 'full' : 'excerpts',
        [...new Set(selected.map(passage => passage.pageNumber))], material.kind === 'document' ? source.pageOrder.length : new Set(material.locations.map(location => location.pageId)).size);
      if (!original.length) throw new ChatContextError('This reference PDF has no readable text. Open one of its pages and include a page image, or convert it with KOLMOPDF.', true, 'image');
    }
    const attachedText = material.generatedText;
    if (attachedText) {
      const sourceId = source.sourceIds[0];
      if (!sourceId) throw new MaterialContextError(MATERIAL_EXPIRED);
      const generatedRevision = material.generatedFromRevision ?? material.revision;
      if (generatedRevision !== source.revision) declare({ ...source, revision: generatedRevision, pageOrder: [] }, material.name, 'excerpts', [], 0);
      referenceEvidence.push({ id: `r${referenceEvidence.length + 1}`, docId: source.id, revision: generatedRevision,
        sourceId, materialId: material.id, kind: 'generated', role: 'result', text: attachedText });
    }
    assertCurrent(source);
  }
  if (scope === 'selection' && !primary.length && !referenceEvidence.length) throw new ChatContextError('The selection has no readable text. Choose the current page for visual questions.');
  if (!primary.length && !imagePageIds.length && !referenceEvidence.length) throw new ChatContextError('There is no readable text in this scope. Include page images to ask about scanned content.', true, 'image');

  const images: NonNullable<AiRequest['context']['images']> = [];
  let imageBytes = 0;
  for (const pageId of imagePageIds) {
    signal.throwIfAborted(); assertCurrent(document);
    const description = descriptions.get(pageId)!;
    const scale = Math.min(1.5, AI_LIMITS.imageLongestEdge / Math.max(description.widthPt, description.heightPt));
    const render = await engine.render({ docId: document.id, pageId, scale });
    signal.throwIfAborted(); assertCurrent(document);
    const data = encodeRenderedImage(render, 'image/jpeg');
    imageBytes += data.length * 3 / 4;
    if (imageBytes > AI_LIMITS.imageFileBytes) throw new ChatContextError('The page image is too large to send. Convert this PDF with KOLMOPDF instead.', true);
    images.push({ mimeType: 'image/jpeg', data });
  }
  const imagePages = imagePageIds.map(id => ({ id, pageNumber: document.pageOrder.indexOf(id) + 1 }));
  const request: AiRequest = aiRequestSchema.parse({
    protocolVersion: 1, requestId: crypto.randomUUID(), feature: images.length ? 'image.explain' : 'document.ask',
    document: { id: document.id, revision: document.revision },
    context: { scope, history: options.history.slice(-12),
      evidence: primary.map((item, index) => ({ id: `e${index + 1}`, docId: document.id, revision: document.revision,
        pageId: item.pageId, pageNumber: item.pageNumber, blockId: item.blockId, text: item.text, characterRange: item.range, bounds: item.bounds })),
      ...(sourceDocuments.size ? { sourceDocuments: [...sourceDocuments.values()] } : {}),
      ...(referenceEvidence.length ? { referenceEvidence } : {}),
      ...(images.length ? { images, pages: imagePages } : {}),
    }, instruction: options.instruction, options: {},
  });
  const limit = images.length ? AI_LIMITS.imageBodyBytes : AI_LIMITS.textBodyBytes;
  if (new TextEncoder().encode(JSON.stringify(request)).length > limit) throw new ChatContextError('This conversation or its images are too large. Clear the conversation or choose a smaller scope.', images.length > 0);
  const snapshot = createEvidenceSnapshot(request, primary.map((item, index) => ({ evidenceId: `e${index + 1}`, sourceId: item.sourceId, blockText: item.blockText })));
  return { request, snapshot, scanned: images.length > 0, coverage, sourceIds: [...sourceIds],
    pageNumbers: [...new Set(primary.map(item => item.pageNumber))], imagePageNumbers: imagePages.map(item => item.pageNumber) };
}
export type PreparedChatContext = Awaited<ReturnType<typeof prepareChatContext>>;
