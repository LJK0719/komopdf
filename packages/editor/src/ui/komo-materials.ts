import type { AiRequest, DocumentInfo, EngineAdapter, ReferenceEvidence } from '@pdf-editor/contracts';
import type { EditorAiContext } from './EditorShell.js';
import type { AiHandoff, AiMaterial } from './text-actions.js';
import { collectDocumentPassages, type DocumentPassage } from './document-ai-context.js';

export type MaterialDocuments = Pick<EditorAiContext, 'document' | 'documents' | 'getDocumentInfo'>;
export const MATERIAL_EXPIRED = 'The document changed while preparing your materials. Send again to use the latest version.';
export const MATERIAL_UPDATE_PROMPT = 'File changes detected. Save?';
export const MATERIAL_CLOSED = 'This reference PDF is closed. Open it again to continue.';
export const MATERIAL_SELECTION_CHANGED = 'The original selection has changed. Select the passage again or remove this material.';
export class MaterialContextError extends Error {}

export function materialIssue(material: AiMaterial, context: MaterialDocuments): string | null {
  const document = materialDocument(context, material.documentId);
  if (!document) return MATERIAL_CLOSED;
  if (document.permissions.copy !== true) return 'This PDF does not allow copying its content.';
  return isMaterialCurrent(material, context) ? null : MATERIAL_UPDATE_PROMPT;
}

/** Only pending materials are refreshed; sent requests remain immutable. */
export async function refreshMaterial(material: AiMaterial, context: MaterialDocuments & { engine: EngineAdapter }, signal: AbortSignal): Promise<AiMaterial> {
  const document = materialDocument(context, material.documentId);
  if (!document) throw new MaterialContextError(MATERIAL_CLOSED);
  if (document.permissions.copy !== true) throw new MaterialContextError('This PDF does not allow copying its content.');
  if (material.kind === 'text') return material;
  let refreshed: AiMaterial;
  if (material.kind === 'document') {
    refreshed = await readDocumentMaterial({ engine: context.engine, document, name: material.name, signal,
      currentDocument: () => materialDocument(context, material.documentId) });
  } else {
    const pages = new Map<string, Awaited<ReturnType<EngineAdapter['extract']>>>();
    const locations: AiMaterial['locations'] = [];
    for (const location of material.locations) {
      signal.throwIfAborted();
      if (!document.pageOrder.includes(location.pageId)) throw new MaterialContextError(MATERIAL_SELECTION_CHANGED);
      if (!pages.has(location.pageId)) pages.set(location.pageId, await context.engine.extract({ docId: document.id, pageIds: [location.pageId] }));
      const text = location.text ?? (material.locations.length === 1 ? material.text : '');
      if (!text) throw new MaterialContextError(MATERIAL_SELECTION_CHANGED);
      const blocks = pages.get(location.pageId)!;
      const matches = (candidates: typeof blocks) => candidates.flatMap(block => {
        const value = block.runs.map(run => run.text).join('');
        const start = value.indexOf(text);
        if (start < 0) return [];
        const repeated = value.indexOf(text, start + 1);
        return (repeated < 0 ? [start] : [start, repeated]).map(offset => ({ pageId: location.pageId,
          pageNumber: document.pageOrder.indexOf(location.pageId) + 1, blockId: block.id,
          range: [offset, offset + text.length] as [number, number], text }));
      });
      const original = matches(blocks.filter(block => block.id === location.blockId));
      const found = original.length ? original : matches(blocks);
      if (found.length !== 1) throw new MaterialContextError(MATERIAL_SELECTION_CHANGED);
      locations.push(found[0]!);
    }
    const sourceText = locations.map(location => location.text).join('\n');
    refreshed = { ...material, revision: document.revision, text: material.sourceText !== undefined ? material.text : sourceText, sourceText, locations };
  }
  if (materialDocument(context, document.id)?.revision !== document.revision) throw new MaterialContextError(MATERIAL_EXPIRED);
  return { ...material, ...refreshed, id: material.id,
    ...(material.generatedText ? { generatedFromRevision: material.generatedFromRevision ?? material.revision } : {}) };
}

export async function prepareMaterials(materials: readonly AiMaterial[], context: MaterialDocuments & Pick<EditorAiContext, 'engine' | 'confirmMaterialUpdate' | 'prepareDocument'>,
  signal: AbortSignal, changedNames: readonly string[] = [], saveDocumentIds: readonly string[] = []): Promise<AiMaterial[] | null> {
  const changed: AiMaterial[] = [];
  for (const material of materials) {
    const issue = materialIssue(material, context);
    if (issue && issue !== MATERIAL_UPDATE_PROMPT) throw new MaterialContextError(issue);
    if (issue) changed.push(material);
  }
  if (changed.length || changedNames.length) {
    const names = [...new Set([...changed.map(material => material.name), ...changedNames])];
    if (await context.confirmMaterialUpdate?.(names, signal) !== 'save') return null;
    signal.throwIfAborted();
    for (const id of new Set([...changed.map(material => material.documentId), ...saveDocumentIds])) {
      if (!context.prepareDocument) throw new MaterialContextError('Unable to save this PDF. Try saving again.');
      if ((await context.prepareDocument(id, signal)).status === 'cancelled') return null;
    }
  }
  const prepared: AiMaterial[] = [];
  for (const material of materials) {
    const next = changed.includes(material) ? await refreshMaterial(material, context, signal) : material;
    if (next.kind !== 'document' || next === material) await materialPassages(next, context, signal);
    prepared.push(next);
  }
  signal.throwIfAborted();
  if (prepared.some(material => !isMaterialCurrent(material, context))) throw new MaterialContextError(MATERIAL_EXPIRED);
  return prepared;
}

export function materialDocument(context: MaterialDocuments, id: string): DocumentInfo | null {
  if (context.getDocumentInfo) return context.getDocumentInfo(id);
  return context.document?.id === id ? context.document : context.documents?.find(item => item.id === id)?.info ?? null;
}
export function isMaterialCurrent(material: AiMaterial, context: MaterialDocuments): boolean {
  const document = materialDocument(context, material.documentId);
  return !!document && document.permissions.copy === true && (material.kind === 'text'
    || document.revision === material.revision && material.locations.every(location => document.pageOrder[location.pageNumber - 1] === location.pageId));
}
export function freezeMaterials(materials: readonly AiMaterial[]): AiMaterial[] {
  return materials.map(material => Object.freeze({ ...material,
    locations: Object.freeze(material.locations.map(location => Object.freeze({ ...location,
      ...(location.range ? { range: Object.freeze([...location.range]) as unknown as typeof location.range } : {}),
    }))) as unknown as AiMaterial['locations'],
  }));
}
export function mergeHandoffMaterials(existing: readonly AiMaterial[], handoff: AiHandoff): AiMaterial[] {
  const ids = new Set(existing.map(material => material.id));
  return [...existing, ...freezeMaterials(handoff.materials.filter(material => !ids.has(material.id)))];
}

export async function readDocumentMaterial(options: {
  engine: EngineAdapter; document: DocumentInfo; name: string; signal: AbortSignal;
  currentDocument(): DocumentInfo | null;
}): Promise<AiMaterial> {
  const { document, signal } = options;
  if (document.permissions.copy !== true) throw new MaterialContextError('This PDF does not allow copying its content.');
  const passages = await collectDocumentPassages(options.engine, document, signal);
  const current = options.currentDocument();
  if (!current || current.revision !== document.revision || current.permissions.copy !== true) throw new MaterialContextError(MATERIAL_EXPIRED);
  return {
    id: `document:${document.id}:${document.revision}`, documentId: document.id, revision: document.revision,
    name: options.name, kind: 'document', text: passages.map(passage => passage.text).join('\n'),
    locations: passages.map(passage => ({ pageId: passage.pageId, pageNumber: passage.pageNumber,
      blockId: passage.blockId, range: passage.range, text: passage.text })),
  };
}

/** Reads the real source document without changing the editor's active tab. */
export async function materialPassages(material: AiMaterial, context: MaterialDocuments & { engine: EngineAdapter }, signal: AbortSignal): Promise<DocumentPassage[]> {
  const document = materialDocument(context, material.documentId);
  if (!document || !isMaterialCurrent(material, context)) throw new MaterialContextError(MATERIAL_EXPIRED);
  if (material.kind === 'document') {
    const passages = await collectDocumentPassages(context.engine, document, signal);
    if (!isMaterialCurrent(material, context)) throw new MaterialContextError(MATERIAL_EXPIRED);
    return passages;
  }
  if (material.kind === 'text') return [];
  const pages = new Map<string, Awaited<ReturnType<EngineAdapter['extract']>>>();
  const passages: DocumentPassage[] = [];
  for (const location of material.locations) {
    signal.throwIfAborted();
    if (!pages.has(location.pageId)) pages.set(location.pageId, await context.engine.extract({ docId: document.id, pageIds: [location.pageId] }));
    signal.throwIfAborted();
    const block = pages.get(location.pageId)?.find(item => item.id === location.blockId);
    if (!block) throw new MaterialContextError(MATERIAL_EXPIRED);
    const blockText = block.runs.map(run => run.text).join('');
    const range = location.range ?? [0, blockText.length];
    const text = blockText.slice(range[0], range[1]);
    const sourceId = block.sourceId ?? (document.sourceIds.length === 1 ? document.sourceIds[0] : undefined);
    if (range[0] < 0 || range[1] > blockText.length || range[1] <= range[0] || !sourceId || !document.sourceIds.includes(sourceId)
      || (location.text !== undefined && location.text !== text)) throw new MaterialContextError(MATERIAL_EXPIRED);
    passages.push({ pageId: location.pageId, pageNumber: location.pageNumber, blockId: block.id, sourceId,
      blockText, text, range: [...range], bounds: [block.bounds.x, block.bounds.y, block.bounds.width, block.bounds.height] });
  }
  if (passages.map(passage => passage.text).join('\n') !== (material.sourceText ?? material.text) || !isMaterialCurrent(material, context)) throw new MaterialContextError(MATERIAL_EXPIRED);
  return passages;
}

export type ReferenceCitation = {
  documentId: string; revision: number; name: string; materialId: string;
  kind: ReferenceEvidence['kind']; role?: 'attached' | 'result'; pageId?: string; pageNumber?: number; blockId?: string;
  range?: { start: number; end: number };
};
/** Generated text is never given a fabricated PDF character range. */
export function resolveMaterialCitation(request: AiRequest, citation: { evidenceId: string; quote?: string | undefined }, context: MaterialDocuments): ReferenceCitation | null {
  const reference = request.context.referenceEvidence?.find(item => item.id === citation.evidenceId);
  if (!reference || (citation.quote !== undefined && !reference.text.includes(citation.quote))) return null;
  const source = request.context.sourceDocuments?.find(item => item.id === reference.docId && item.revision === reference.revision);
  const current = materialDocument(context, reference.docId);
  if (!source || !current || current.permissions.copy !== true || (reference.kind !== 'generated' && current.revision !== reference.revision)) return null;
  let range = reference.kind === 'source' && reference.characterRange ? reference.characterRange : undefined;
  if (range && citation.quote) {
    const offset = reference.text.indexOf(citation.quote);
    if (offset >= 0 && reference.text.indexOf(citation.quote, offset + 1) === -1) range = [range[0] + offset, range[0] + offset + citation.quote.length];
  }
  return { documentId: reference.docId, revision: reference.revision, name: source.name,
    materialId: reference.materialId, kind: reference.kind, ...(reference.role ? { role: reference.role } : {}),
    ...(reference.pageId && reference.pageNumber !== undefined ? { pageId: reference.pageId, pageNumber: reference.pageNumber } : {}),
    ...(reference.blockId ? { blockId: reference.blockId } : {}),
    ...(range ? { range: { start: range[0], end: range[1] } } : {}),
  };
}
