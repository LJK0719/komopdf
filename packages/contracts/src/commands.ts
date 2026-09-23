import { z } from 'zod';

export const idSchema = z.string().min(1).max(160);
export const revisionSchema = z.number().int().nonnegative();
export const rangeSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([start, end]) => end >= start, 'Range must be a UTF-16 half-open interval');
export const matrixSchema = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);
export const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();
const idsSchema = z.array(idSchema).min(1).refine(ids => new Set(ids).size === ids.length, 'Target IDs must be unique');
const colorSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
export const textStyleSchema = z.object({
  fontId: idSchema.optional(), fontSize: z.number().positive().max(1000).optional(),
  color: colorSchema.optional(), weight: z.number().int().min(100).max(900).optional(),
  italic: z.boolean().optional(), underline: z.boolean().optional(),
  characterSpacing: z.number().optional(), lineHeight: z.number().positive().optional(),
  alignment: z.enum(['left', 'center', 'right', 'justify']).optional(),
}).strict();

export const reflowTextStyleSchema = z.object({
  fontId: idSchema,
  fontSize: z.number().positive().max(1000),
  color: colorSchema.optional(),
  characterSpacing: z.number().optional(),
  lineHeight: z.number().positive().optional(),
  alignment: z.enum(['left', 'center', 'right', 'justify']).optional(),
}).strict();
export type ReflowTextStyle = z.infer<typeof reflowTextStyleSchema>;

export const editCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text.replace'), pageId: idSchema, blockId: idSchema, range: rangeSchema, text: z.string(), style: textStyleSchema.optional() }).strict(),
  z.object({ type: z.literal('text.style'), pageId: idSchema, blockIds: idsSchema, range: rangeSchema.optional(), style: textStyleSchema }).strict(),
  z.object({ type: z.literal('text.insert'), pageId: idSchema, objectId: idSchema, bounds: rectSchema, text: z.string(), style: textStyleSchema,
    invisible: z.boolean().optional(), fitBounds: z.boolean().optional(), ocr: z.boolean().optional(), paragraph: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('text.reflow'), pageId: idSchema, objectId: idSchema, blockIds: idsSchema, bounds: rectSchema, text: z.string(), style: reflowTextStyleSchema }).strict(),
  z.object({ type: z.literal('objects.transform'), pageId: idSchema, objectIds: idsSchema, matrix: matrixSchema }).strict(),
  z.object({ type: z.literal('objects.delete'), pageId: idSchema, objectIds: idsSchema }).strict(),
  z.object({ type: z.literal('objects.copy'), pageId: idSchema, objectIds: idsSchema, newObjectIds: idsSchema, offset: z.object({ x: z.number(), y: z.number() }).strict() }).strict(),
  z.object({ type: z.literal('objects.align'), pageId: idSchema, objectIds: idsSchema, axis: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']) }).strict(),
  z.object({ type: z.literal('objects.group'), pageId: idSchema, objectIds: idsSchema, groupId: idSchema }).strict(),
  z.object({ type: z.literal('objects.ungroup'), pageId: idSchema, groupId: idSchema }).strict(),
  z.object({ type: z.literal('pages.rotate'), pageIds: idsSchema, degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]) }).strict(),
  z.object({ type: z.literal('pages.delete'), pageIds: idsSchema }).strict(),
  z.object({ type: z.literal('pages.reorder'), pageIds: idsSchema }).strict(),
  z.object({ type: z.literal('pages.duplicate'), pageIds: idsSchema, newPageIds: idsSchema, afterPageId: idSchema.nullable() }).strict(),
  z.object({ type: z.literal('pages.insert'), pageId: idSchema, afterPageId: idSchema.nullable(), widthPt: z.number().positive(), heightPt: z.number().positive() }).strict(),
  z.object({ type: z.literal('pages.import'), resourceId: idSchema, pageIndices: z.array(z.number().int().nonnegative()).min(1), newPageIds: idsSchema, afterPageId: idSchema.nullable() }).strict(),
  z.object({ type: z.literal('content.insert'), pageId: idSchema, objectId: idSchema, resourceId: idSchema, resourcePageIndex: z.number().int().nonnegative().max(0xffff_ffff), bounds: rectSchema }).strict(),
  z.object({ type: z.literal('image.insert'), pageId: idSchema, objectId: idSchema, resourceId: idSchema, bounds: rectSchema }).strict(),
  z.object({ type: z.literal('image.replace'), pageId: idSchema, objectId: idSchema, resourceId: idSchema }).strict(),
  z.object({ type: z.literal('image.crop'), pageId: idSchema, objectId: idSchema, bounds: rectSchema }).strict(),
  z.object({ type: z.literal('annotation.add'), pageId: idSchema, annotationId: idSchema, subtype: z.enum(['highlight', 'text', 'rectangle', 'ink']), bounds: rectSchema, text: z.string().optional(), color: colorSchema.optional(), opacity: z.number().min(0).max(1).optional(), strokeWidth: z.number().positive().optional(), points: z.array(z.tuple([z.number(), z.number()])).optional() }).strict(),
  z.object({ type: z.literal('form.fill'), fieldId: idSchema, value: z.union([z.string(), z.boolean(), z.array(z.string())]) }).strict(),
  z.object({ type: z.literal('form.create'), pageId: idSchema, fieldId: idSchema, name: z.string().min(1), fieldType: z.enum(['text', 'checkbox']), bounds: rectSchema, fontId: idSchema.optional(), fontSize: z.number().positive().max(1000).optional() }).strict(),
]);
export type EditCommand = z.infer<typeof editCommandSchema>;
export type CommandType = EditCommand['type'];
export type TextStyle = z.infer<typeof textStyleSchema>;
export const editTransactionSchema = z.object({
  id: idSchema, docId: idSchema, baseRevision: revisionSchema,
  source: z.enum(['manual', 'ai']), commands: z.array(editCommandSchema).min(1),
}).strict();
export type EditTransaction = z.infer<typeof editTransactionSchema>;

// 模型只能绑定证据，不能自行产生 UTF-16 偏移。
export const proposedCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text.replace'), targetEvidenceId: idSchema, text: z.string() }).strict(),
  z.object({ type: z.literal('text.style'), pageId: idSchema, blockIds: idsSchema, style: textStyleSchema }).strict(),
  z.object({ type: z.literal('objects.transform'), pageId: idSchema, objectIds: idsSchema, matrix: matrixSchema }).strict(),
  z.object({ type: z.literal('objects.delete'), pageId: idSchema, objectIds: idsSchema }).strict(),
  z.object({ type: z.literal('objects.align'), pageId: idSchema, objectIds: idsSchema, axis: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']) }).strict(),
  z.object({ type: z.literal('pages.rotate'), pageIds: idsSchema, degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]) }).strict(),
  z.object({ type: z.literal('pages.delete'), pageIds: idsSchema }).strict(),
  z.object({ type: z.literal('pages.reorder'), pageIds: idsSchema }).strict(),
  z.object({ type: z.literal('form.fill'), fieldId: idSchema, value: z.union([z.string(), z.boolean(), z.array(z.string())]) }).strict(),
]);
export type ProposedCommand = z.infer<typeof proposedCommandSchema>;
