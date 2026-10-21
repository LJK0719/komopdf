import { z } from 'zod';
import { idSchema, proposedCommandSchema, rangeSchema, revisionSchema, textStyleSchema } from './commands.js';

export const PROTOCOL_VERSION = 1 as const;
// Public service identity; the gateway owns the actual provider/model choice.
export const AI_MODEL = 'komo';
export const AI_TEMPLATE_VERSION = '1';
export const featureSchema = z.enum([
  'text.translate', 'text.proofread', 'text.rewrite', 'text.fit', 'commands.plan',
  'document.ask', 'document.summarize', 'document.translate', 'document.extract',
  'form.suggest', 'blocks.organize', 'image.explain',
]);
export type AiFeature = z.infer<typeof featureSchema>;
export const AI_FEATURES: readonly AiFeature[] = featureSchema.options;
export const AI_LIMITS = Object.freeze({
  inFlight: 12, imageInFlight: 2, perIpInFlight: 2, perIpPerMinute: 60,
  textBodyBytes: 512 * 1024, imageBodyBytes: 3 * 1024 * 1024,
  imageCount: 2, imageFileBytes: 2 * 1024 * 1024, imageLongestEdge: 1536,
  connectTimeoutMs: 10_000, requestTimeoutMs: 180_000,
  upstreamBytes: 1024 * 1024, visibleResultBytes: 512 * 1024, maxOutputTokens: 8192,
});
export const evidenceBlockSchema = z.object({
  id: idSchema, docId: idSchema, revision: revisionSchema, pageId: idSchema,
  pageNumber: z.number().int().positive(), blockId: idSchema, text: z.string(),
  characterRange: rangeSchema.optional(),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
}).strict();
export type EvidenceBlock = z.infer<typeof evidenceBlockSchema>;
/** Read-only sources never become transaction targets. */
export const aiSourceDocumentSchema = z.object({
  id: idSchema, revision: revisionSchema, name: z.string().min(1).max(1000),
  sourceIds: z.array(idSchema).min(1), pageIds: z.array(idSchema),
  coverage: z.object({ kind: z.enum(['full', 'excerpts', 'analysis']), pagesScanned: z.number().int().nonnegative(),
    pageNumbers: z.array(z.number().int().positive()) }).strict().optional(),
}).strict();
export const referenceEvidenceSchema = z.object({
  id: idSchema, docId: idSchema, revision: revisionSchema, sourceId: idSchema,
  materialId: idSchema, kind: z.enum(['source', 'generated', 'analysis']), text: z.string().min(1),
  role: z.enum(['attached', 'result']).optional(),
  pageId: idSchema.optional(), pageNumber: z.number().int().positive().optional(), blockId: idSchema.optional(),
  characterRange: rangeSchema.optional(),
}).strict();
export type AiSourceDocument = z.infer<typeof aiSourceDocumentSchema>;
export type ReferenceEvidence = z.infer<typeof referenceEvidenceSchema>;
export const citationRefSchema = z.object({ evidenceId: idSchema, quote: z.string().min(1).optional() }).strict();
export type CitationRef = z.infer<typeof citationRefSchema>;
export const textReplacementSchema = z.object({ targetEvidenceId: idSchema, text: z.string(), reason: z.string().optional() }).strict();
export type TextReplacement = z.infer<typeof textReplacementSchema>;
const translatedBlockSchema = z.object({ evidenceId: idSchema, text: z.string() }).strict();
const extractedFieldSchema = z.object({
  name: z.string(), rawValue: z.string(), normalizedValue: z.string().optional(), citations: z.array(citationRefSchema),
}).strict();
export const aiResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), text: z.string(), citations: z.array(citationRefSchema) }).strict(),
  z.object({ kind: z.literal('textProposal'), replacements: z.array(textReplacementSchema).min(1), notes: z.array(z.string()).optional() }).strict(),
  z.object({ kind: z.literal('commandPlan'), commands: z.array(proposedCommandSchema).min(1).max(8), explanation: z.string() }).strict(),
  z.object({ kind: z.literal('translation'), blocks: z.array(translatedBlockSchema) }).strict(),
  z.object({ kind: z.literal('extraction'), fields: z.array(extractedFieldSchema) }).strict(),
  z.object({ kind: z.literal('clarification'), question: z.string(), choices: z.array(z.string()).optional() }).strict(),
]);
export type AiResult = z.infer<typeof aiResultSchema>;
export const usageSchema = z.object({
  promptTokenCount: z.number().int().nonnegative().optional(),
  candidatesTokenCount: z.number().int().nonnegative().optional(),
  thoughtsTokenCount: z.number().int().nonnegative().optional(),
  totalTokenCount: z.number().int().nonnegative().optional(),
}).strict();
export type AiUsage = z.infer<typeof usageSchema>;
export const aiRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION), requestId: idSchema, feature: featureSchema,
  document: z.object({ id: idSchema, revision: revisionSchema }).strict(),
  context: z.object({
    scope: z.enum(['selection', 'page', 'pages', 'document']),
    evidence: z.array(evidenceBlockSchema),
    sourceDocuments: z.array(aiSourceDocumentSchema).max(32).optional(),
    referenceEvidence: z.array(referenceEvidenceSchema).max(256).optional(),
    // 全文内容不在页面操作请求里发送；目标只含已授权的本地元数据。
    pages: z.array(z.object({ id: idSchema, pageNumber: z.number().int().positive() }).strict()).optional(),
    objects: z.array(z.object({ id: idSchema, pageId: idSchema, type: z.enum(['text', 'image', 'path', 'form', 'group', 'shading']), blockId: idSchema.optional(), style: textStyleSchema.optional() }).strict()).optional(),
    fields: z.array(z.object({ id: idSchema, name: z.string(), type: z.enum(['text', 'checkbox', 'radio', 'choice']), options: z.array(z.string()).optional() }).strict()).optional(),
    availableCommands: z.array(z.string().min(1).max(80)).optional(),
    availableFontIds: z.array(idSchema).optional(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() }).strict()).max(12).optional(),
    images: z.array(z.object({ mimeType: z.enum(['image/png', 'image/jpeg']), data: z.string(), evidenceId: idSchema.optional() }).strict()).max(AI_LIMITS.imageCount).optional(),
  }).strict(),
  instruction: z.string().max(16_000),
  options: z.object({
    targetLanguage: z.string().max(100).optional(), tone: z.string().max(100).optional(),
    preserveNumbers: z.boolean().optional(), targetCharacters: z.number().int().positive().optional(),
    terminology: z.record(z.string(), z.string()).optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.context.evidence.forEach((evidence, index) => {
    if (ids.has(evidence.id) || evidence.docId !== value.document.id || evidence.revision !== value.document.revision) {
      ctx.addIssue({ code: 'custom', path: ['context', 'evidence', index], message: 'Duplicate evidence or mismatched document id/revision' });
    }
    ids.add(evidence.id);
    // text 为实际发送的选区片段；范围相对于原块，模型不返回偏移。
    if (evidence.characterRange && evidence.characterRange[1] - evidence.characterRange[0] !== evidence.text.length) {
      ctx.addIssue({ code: 'custom', path: ['context', 'evidence', index, 'characterRange'], message: 'Evidence snippet does not match UTF-16 range length' });
    }
  });
  const documents = new Map<string, AiSourceDocument>();
  for (const [index, source] of (value.context.sourceDocuments ?? []).entries()) {
    const key = JSON.stringify([source.id, source.revision]);
    const oldTargetSnapshot = source.id === value.document.id && source.revision !== value.document.revision;
    const matching = (value.context.referenceEvidence ?? []).filter(evidence => evidence.docId === source.id && evidence.revision === source.revision);
    if (documents.has(key) || new Set(source.sourceIds).size !== source.sourceIds.length || new Set(source.pageIds).size !== source.pageIds.length
      || (oldTargetSnapshot && (!matching.length || matching.some(evidence => evidence.kind !== 'generated')))) {
      ctx.addIssue({ code: 'custom', path: ['context', 'sourceDocuments', index], message: 'Duplicate or mismatched source document' });
    }
    documents.set(key, source);
  }
  for (const [index, evidence] of (value.context.referenceEvidence ?? []).entries()) {
    const source = documents.get(JSON.stringify([evidence.docId, evidence.revision]));
    const path = ['context', 'referenceEvidence', index];
    if (ids.has(evidence.id) || !source || source.revision !== evidence.revision || !source.sourceIds.includes(evidence.sourceId)) {
      ctx.addIssue({ code: 'custom', path, message: 'Reference evidence must match a unique declared source and revision' });
    }
    ids.add(evidence.id);
    if ((evidence.pageId === undefined) !== (evidence.pageNumber === undefined)
      || (evidence.pageId !== undefined && source?.pageIds[evidence.pageNumber! - 1] !== evidence.pageId)
      || (evidence.blockId !== undefined && evidence.pageId === undefined)) {
      ctx.addIssue({ code: 'custom', path, message: 'Reference location does not match its source document' });
    }
    if (evidence.kind === 'source' && (!evidence.pageId || !evidence.blockId || !evidence.characterRange)) {
      ctx.addIssue({ code: 'custom', path, message: 'PDF source references require a real block and range' });
    }
    if (evidence.characterRange && (evidence.kind !== 'source' || evidence.characterRange[1] - evidence.characterRange[0] !== evidence.text.length)) {
      ctx.addIssue({ code: 'custom', path, message: 'Only original PDF text can carry a character range' });
    }
  }
});
export type AiRequest = z.infer<typeof aiRequestSchema>;
export const aiResponseEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION), requestId: idSchema,
  document: z.object({ id: idSchema, baseRevision: revisionSchema }).strict(),
  feature: featureSchema, result: aiResultSchema,
}).strict();
export type AiResponseEnvelope = z.infer<typeof aiResponseEnvelopeSchema>;
export const aiEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accepted'), requestId: idSchema }).strict(),
  z.object({ type: z.literal('progress'), message: z.string() }).strict(),
  z.object({ type: z.literal('delta'), text: z.string() }).strict(),
  z.object({ type: z.literal('result'), response: aiResponseEnvelopeSchema }).strict(),
  z.object({ type: z.literal('usage'), usage: usageSchema.nullable(), reason: z.string().optional() }).strict(),
  z.object({ type: z.literal('done'), requestId: idSchema }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }).strict(),
]);
export type AiEvent = z.infer<typeof aiEventSchema>;

export function createEnvelope(request: AiRequest, result: AiResult): AiResponseEnvelope {
  return { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId,
    document: { id: request.document.id, baseRevision: request.document.revision }, feature: request.feature, result };
}
