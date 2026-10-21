import type { AiRequest, DocumentInfo, EngineAdapter, ReferenceEvidence } from '@pdf-editor/contracts';
import type { EditorAiContext } from './EditorShell.js';
import type { AiHandoff, AiMaterial } from './text-actions.js';
import { collectDocumentPassages, type DocumentPassage } from './document-ai-context.js';

export type MaterialDocuments = Pick<EditorAiContext, 'document' | 'documents' | 'getDocumentInfo'>;
export const MATERIAL_EXPIRED = 'This material changed or is no longer available. Remove it and add its current version.';
export class MaterialContextError extends Error {}

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
  if (passages.map(passage => passage.text).join('\n') !== material.text || !isMaterialCurrent(material, context)) throw new MaterialContextError(MATERIAL_EXPIRED);
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
