import { AI_LIMITS, type AiRequest, type DocumentInfo, type EngineAdapter, type PageModel } from '@pdf-editor/contracts';
import { createEvidenceSnapshot } from '@pdf-editor/ai-client';
import { passagesForBlock, type DocumentPassage } from './document-ai-context.js';
import { encodeRenderedImage } from './AiPanelImage.js';

export type ChatScope = 'document' | 'page' | 'selection';
export type ChatVisualMode = 'auto' | 'always' | 'text';
export type ChatTurn = { role: 'user' | 'assistant'; text: string };
export const CHAT_TEXT_LIMIT = 36_000;
export const CHAT_COPY_RESTRICTED = 'This PDF does not allow copying its content, so komo cannot send its text or page images for Q&A. Open a copy-enabled version provided by the document owner.';
export const SCAN_RECOMMENDATION = 'For scanned PDFs, use KOLMOPDF to convert to Markdown, then bring the Markdown to another large language model. Structured text makes headings, tables and formulas easier to follow, search and cite, and avoids repeatedly reading images in each turn. Check OCR and complex layouts against the original.';

export class ChatContextError extends Error {
  constructor(message: string, readonly scanned = false, readonly action?: 'page' | 'image' | 'clear') { super(message); }
}

export async function prepareChatContext(options: {
  engine: EngineAdapter; document: DocumentInfo; page: PageModel | null;
  selectedIds: readonly string[]; scope: ChatScope; instruction: string;
  visualMode?: ChatVisualMode;
  history: readonly ChatTurn[]; signal: AbortSignal;
}) {
  const { engine, document, page, scope, signal } = options;
  if (document.permissions.copy !== true) throw new ChatContextError(CHAT_COPY_RESTRICTED);
  const pageIds = scope === 'document' ? document.pageOrder : page ? [page.id] : [];
  if (!pageIds.length) throw new ChatContextError('Open a PDF before asking komo.');
  if (scope === 'selection' && !options.selectedIds.length) throw new ChatContextError('Select text objects or choose another scope.');
  const passages: DocumentPassage[] = [];
  const imagePageIds: string[] = [];
  const descriptions = new Map<string, PageModel>();
  const visualMode = options.visualMode ?? 'auto';
  let characters = 0;
  for (const pageId of pageIds) {
    signal.throwIfAborted();
    const blocks = await engine.extract({ docId: document.id, pageIds: [pageId] });
    signal.throwIfAborted();
    const selectedBlocks = scope === 'selection'
      ? blocks.filter(block => block.sourceObjectIds.some(id => options.selectedIds.includes(id)) || page?.objects.some(object => options.selectedIds.includes(object.id) && object.textBlock?.id === block.id))
      : blocks;
    const readable = selectedBlocks.filter(block => block.runs.some(run => run.text.trim()));
    if (scope !== 'selection' && visualMode !== 'text') {
      const description = page?.id === pageId ? page : await engine.describePage(document.id, pageId);
      signal.throwIfAborted();
      descriptions.set(pageId, description);
      const hasVisualContent = description.objects.some(object => ['image', 'form', 'shading'].includes(object.type));
      if (visualMode === 'always' || !readable.length || hasVisualContent) {
        imagePageIds.push(pageId);
        if (imagePageIds.length > AI_LIMITS.imageCount) {
          throw new ChatContextError('More than two pages need images. Choose the current page, use text-only context, or convert the PDF with KOLMOPDF.', true, 'page');
        }
      }
    }
    for (const block of readable) {
      const items = passagesForBlock(block, pageId, document.pageOrder.indexOf(pageId) + 1, document.sourceIds);
      characters += items.reduce((count, item) => count + item.text.length, 0);
      if (characters > CHAT_TEXT_LIMIT) throw new ChatContextError('This document is too long for a lightweight answer. Choose the current page or selected text; no partial document was sent.', imagePageIds.length > 0, 'page');
      passages.push(...items);
    }
  }
  if (scope === 'selection' && !passages.length) throw new ChatContextError('The selection has no readable text. Choose the current page for visual questions.');
  if (!passages.length && !imagePageIds.length) {
    throw new ChatContextError('There is no readable text in this scope. Include page images to ask about scanned content.', true, 'image');
  }

  const images: NonNullable<AiRequest['context']['images']> = [];
  let imageBytes = 0;
  for (const pageId of imagePageIds) {
    signal.throwIfAborted();
    const description = descriptions.get(pageId)!;
    const scale = Math.min(1.5, AI_LIMITS.imageLongestEdge / Math.max(description.widthPt, description.heightPt));
    const render = await engine.render({ docId: document.id, pageId, scale });
    signal.throwIfAborted();
    const data = encodeRenderedImage(render, 'image/jpeg');
    imageBytes += data.length * 3 / 4;
    if (imageBytes > AI_LIMITS.imageFileBytes) throw new ChatContextError('The page image is too large to send. Convert this PDF with KOLMOPDF instead.', true);
    images.push({ mimeType: 'image/jpeg', data });
  }
  const imagePages = imagePageIds.map(id => ({ id, pageNumber: document.pageOrder.indexOf(id) + 1 }));
  const request: AiRequest = {
    protocolVersion: 1, requestId: crypto.randomUUID(), feature: images.length ? 'image.explain' : 'document.ask',
    document: { id: document.id, revision: document.revision },
    context: {
      scope, history: options.history.slice(-12),
      evidence: passages.map((item, index) => ({
        id: `e${index + 1}`, docId: document.id, revision: document.revision,
        pageId: item.pageId, pageNumber: item.pageNumber, blockId: item.blockId,
        text: item.text, characterRange: item.range, bounds: item.bounds,
      })),
      // Image order matches this page list. It is visual evidence, not fabricated OCR.
      ...(images.length ? { images, pages: imagePages } : {}),
    },
    instruction: options.instruction, options: {},
  };
  const limit = images.length ? AI_LIMITS.imageBodyBytes : AI_LIMITS.textBodyBytes;
  if (new TextEncoder().encode(JSON.stringify(request)).length > limit) {
    throw new ChatContextError('This conversation or its images are too large. Clear the conversation or choose a smaller scope.', images.length > 0);
  }
  const snapshot = createEvidenceSnapshot(request, passages.map((item, index) => ({
    evidenceId: `e${index + 1}`, sourceId: item.sourceId, blockText: item.blockText,
  })));
  return { request, snapshot, scanned: images.length > 0,
    pageNumbers: pageIds.map(id => document.pageOrder.indexOf(id) + 1),
    imagePageNumbers: imagePages.map(item => item.pageNumber) };
}
