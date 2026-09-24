import { z } from 'zod';
import { idSchema, proposedCommandSchema, rangeSchema, revisionSchema, textStyleSchema } from './commands.js';

export const PROTOCOL_VERSION = 1 as const;
export const AI_MODEL = 'gemini-3.8-flash-high';
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
