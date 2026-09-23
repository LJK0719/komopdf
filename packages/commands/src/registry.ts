import { editCommandSchema, editTransactionSchema, EngineError, assertTextRange,
  type CommandType, type DocumentInfo, type EditCommand, type EditTransaction,
  type EngineAdapter, type PageModel, type TextRange } from '@pdf-editor/contracts';

const labels: Record<CommandType, string> = {
  'text.replace': 'Replace Text', 'text.style': 'Format Text', 'text.insert': 'Insert Text',
  'text.reflow': 'Reflow Text',
  'objects.transform': 'Transform Objects', 'objects.delete': 'Delete Objects', 'objects.align': 'Align Objects',
  'objects.copy': 'Duplicate Objects', 'objects.distribute': 'Distribute Objects', 'pages.import': 'Import PDF Pages',
  'objects.group': 'Group Objects', 'objects.ungroup': 'Ungroup Objects',
  'pages.rotate': 'Rotate Pages', 'pages.crop': 'Crop Pages', 'pages.delete': 'Delete Pages', 'pages.reorder': 'Reorder Pages',
  'pages.duplicate': 'Duplicate Pages', 'pages.insert': 'Insert Blank Page',
  'content.insert': 'Insert PDF Content',
  'image.insert': 'Insert Image', 'image.replace': 'Replace Image', 'image.crop': 'Crop Image',
  'annotation.add': 'Add Annotation', 'annotation.update': 'Edit Annotation', 'annotation.delete': 'Delete Annotation',
  'form.fill': 'Fill Form', 'form.create': 'Create Form Field',
};
export type CommandContext = {
  document: DocumentInfo;
  pages: ReadonlyMap<string, PageModel>;
  fields?: ReadonlyMap<string, { pageId: string; type: 'text' | 'checkbox' | 'radio' | 'choice'; options?: readonly string[]; readOnly?: boolean }>;
  annotations?: ReadonlyMap<string, { pageId: string; subtype: string }>;
  resourceIds?: ReadonlySet<string>;
  fontIds?: ReadonlySet<string>;
  clusterBoundaries?: ReadonlyMap<string, ReadonlySet<number>>;
  pageLimit?: number;
};
function invalid(message: string): never { throw new EngineError('INVALID_REQUEST', message); }
function requirePage(context: CommandContext, pageId: string): PageModel {
  const page = context.pages.get(pageId);
  if (!page || !context.document.pageOrder.includes(pageId)) invalid('Target page does not exist or is not loaded yet');
  return page;
}
function blockText(context: CommandContext, pageId: string, blockId: string): string {
  const page = requirePage(context, pageId);
  const block = page.objects.find(object => object.textBlock?.id === blockId)?.textBlock;
  if (!block || block.editability === 'geometry-only') invalid('Target is not an editable text block');
  return block.runs.map(run => run.text).join('');
}
function validateRange(context: CommandContext, pageId: string, blockId: string, range: TextRange): void {
  try { assertTextRange(blockText(context, pageId, blockId), range, context.clusterBoundaries?.get(blockId)); }
  catch (error) { invalid(error instanceof Error ? error.message : 'Invalid text range'); }
}
function validatePermission(context: CommandContext, command: EditCommand): void {
  const permission = command.type === 'form.fill' ? context.document.permissions.fillForms
    : command.type.startsWith('annotation.') ? context.document.permissions.annotate : context.document.permissions.modify;
  if (!permission) invalid('This modification is not permitted on the current document');
}

// 核心仍须在提交队列中复核身份/能力/原子性；这里为手工和 AI 提供同一预览前检查。
export function validateTransaction(input: unknown, context: CommandContext): EditTransaction {
  const transaction = editTransactionSchema.parse(input);
  if (transaction.docId !== context.document.id || transaction.baseRevision !== context.document.revision) {
    throw new EngineError('STALE_REVISION', 'Document has changed; please regenerate modifications based on current revision');
  }
  const pages = new Map([...context.pages].map(([id, page]) => [id, { ...page, objects: [...page.objects] }]));
  const fields = new Map(context.fields);
  const annotations = new Map(context.annotations);
  context = { ...context, pages, fields, ...(context.annotations ? { annotations } : {}) };
  const pageIds = new Set(context.document.pageOrder);
  const deletedObjects = new Set<string>();
  const touchedText = new Map<string, TextRange[]>();
  const newIds = new Set<string>([
    ...pageIds, ...[...context.pages.values()].flatMap(page => page.objects.flatMap(object => [object.id, ...(object.textBlock ? [object.textBlock.id] : [])])),
    ...context.fields?.keys() ?? [],
    ...context.annotations?.keys() ?? [],
  ]);
  const addId = (id: string) => { if (newIds.has(id)) invalid('New object ID already exists'); newIds.add(id); };
  for (const command of transaction.commands) {
    if (!context.document.capabilities.includes(command.type)) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', `Current engine does not support: ${labels[command.type]}`);
    }
    validatePermission(context, command);
    if ('pageId' in command && command.type !== 'pages.insert' && !pageIds.has(command.pageId)) invalid('Command references a nonexistent or deleted page');
    if ('pageIds' in command) {
      for (const id of command.pageIds) if (!pageIds.has(id)) invalid('Command references a nonexistent or deleted page');
    }
    if ('objectIds' in command || ('objectId' in command && command.type !== 'text.insert' && command.type !== 'text.reflow' && command.type !== 'image.insert' && command.type !== 'content.insert')) {
      const page = requirePage(context, command.pageId);
      const targets = 'objectIds' in command ? command.objectIds : [command.objectId];
      for (const id of targets) {
        const object = page.objects.find(object => object.id === id);
        if (!object || deletedObjects.has(id)) invalid('Target object does not exist or has been deleted');
        if (command.type.startsWith('image.') && object.type !== 'image') invalid('Target is not an image');
      }
      if (command.type === 'objects.delete') targets.forEach(id => deletedObjects.add(id));
    }
    if (command.type === 'text.replace' || command.type === 'text.style' || command.type === 'text.reflow') {
      const targets = command.type === 'text.replace' ? [command.blockId] : command.blockIds;
      const objects = requirePage(context, command.pageId).objects;
      for (const id of targets) {
        const object = objects.find(item => item.textBlock?.id === id);
        if (object && (deletedObjects.has(object.id) || object.textBlock?.sourceObjectIds.some(sourceId => deletedObjects.has(sourceId)))) invalid('Object containing the text has been deleted');
      }
    }
    if ('style' in command && command.style?.fontId && !context.fontIds?.has(command.style.fontId)) invalid('Font resource is not loaded or cannot be embedded');
    if (command.type === 'form.create' && command.fontId && !context.fontIds?.has(command.fontId)) invalid('Font resource is not loaded or cannot be embedded');
    if ('resourceId' in command && !context.resourceIds?.has(command.resourceId)) invalid('Document resource does not exist');
    switch (command.type) {
      case 'text.replace': {
        validateRange(context, command.pageId, command.blockId, command.range);
        const previous = touchedText.get(command.blockId) ?? [];
        if (previous.some(([start, end]) => command.range[0] < end && command.range[1] > start || command.range[0] === start)) invalid('Replacement ranges overlap in the same transaction');
        if (previous.some(([start]) => command.range[0] > start)) invalid('Text replacements in the same block must be executed in descending order of original range');
        previous.push(command.range); touchedText.set(command.blockId, previous);
        break;
      }
      case 'text.style':
        for (const id of command.blockIds) {
          if (command.range) validateRange(context, command.pageId, id, command.range);
          else blockText(context, command.pageId, id);
        }
        if (command.range && command.blockIds.length !== 1) invalid('Range style can only apply to a single block');
        break;
      case 'pages.crop':
        if (command.bounds.width <= 0 || command.bounds.height <= 0) invalid('Crop must have positive dimensions');
        for (const id of command.pageIds) {
          const current = requirePage(context, id);
          if (command.bounds.x < 0 || command.bounds.y < 0 ||
              command.bounds.x + command.bounds.width > current.widthPt + 0.01 ||
              command.bounds.y + command.bounds.height > current.heightPt + 0.01) {
            invalid('Crop rectangle must fit inside every selected page');
          }
        }
        break;
      case 'pages.delete':
        command.pageIds.forEach(id => pageIds.delete(id));
        if (pageIds.size === 0) invalid('Working document must retain at least one page');
        break;
      case 'pages.reorder':
        if (command.pageIds.length !== pageIds.size) invalid('Page reordering must include all current pages without duplicates');
        break;
      case 'pages.insert':
        if (command.afterPageId !== null && !pageIds.has(command.afterPageId)) invalid('Insertion position does not exist');
        addId(command.pageId); pageIds.add(command.pageId);
        pages.set(command.pageId, { id: command.pageId, widthPt: command.widthPt, heightPt: command.heightPt, rotation: 0, objects: [] });
        break;
      case 'pages.duplicate':
        if (command.afterPageId !== null && !pageIds.has(command.afterPageId)) invalid('Duplication position does not exist');
        if (command.newPageIds.length !== command.pageIds.length) invalid('Duplicate page count mismatch');
        command.newPageIds.forEach(id => { addId(id); pageIds.add(id); }); break;
      case 'pages.import':
        if (command.afterPageId !== null && !pageIds.has(command.afterPageId)) invalid('Import position does not exist');
        if (command.pageIndices.length !== command.newPageIds.length) invalid('Imported page count mismatch');
        command.newPageIds.forEach(id => { addId(id); pageIds.add(id); });
        break;
      case 'objects.align':
        if (command.objectIds.length < 2) invalid('Select at least two objects to align');
        break;
      case 'objects.distribute':
        if (command.objectIds.length < 3) invalid('Select at least three objects to distribute');
        break;
      case 'objects.copy': {
        if (command.objectIds.length !== command.newObjectIds.length) invalid('Copied object count mismatch');
        const page = requirePage(context, command.pageId);
        const originals = command.objectIds.map(id => page.objects.find(object => object.id === id)!);
        command.newObjectIds.forEach((id, index) => {
          addId(id);
          const source = originals[index]!;
          page.objects.push({ id, pageId: page.id, type: source.type,
            bounds: { ...source.bounds, x: source.bounds.x + command.offset.x, y: source.bounds.y + command.offset.y },
            transform: [...source.transform], locator: { pageId: page.id, containerPath: [], objectIndex: page.objects.length } });
        });
        break;
      }
      case 'image.crop':
        if (command.bounds.width <= 0 || command.bounds.height <= 0) invalid('Crop area must have positive dimensions');
        break;
      case 'text.insert': case 'image.insert': case 'content.insert': {
        addId(command.objectId);
        if (command.bounds.width <= 0 || command.bounds.height <= 0) invalid('Inserted content requires positive bounds');
        if (command.type === 'text.insert') {
          if (command.paragraph && (command.invisible || command.fitBounds || command.ocr)) invalid('paragraph is mutually exclusive with invisible, fitBounds, and ocr');
          if (command.fitBounds && !command.invisible) invalid('fitBounds requires invisible text');
          if (command.ocr && (!command.invisible || !command.fitBounds)) invalid('OCR text requires invisible fitted bounds');
        }
        const page = requirePage(context, command.pageId);
        page.objects.push({ id: command.objectId, pageId: command.pageId,
          type: command.type === 'text.insert' ? 'text' : command.type === 'image.insert' ? 'image' : 'form',
          bounds: command.bounds, transform: [1, 0, 0, 1, 0, 0],
          locator: { pageId: command.pageId, containerPath: [], objectIndex: page.objects.length } });
        break;
      }
      case 'text.reflow': {
        addId(command.objectId);
        if (command.bounds.width <= 0 || command.bounds.height <= 0) invalid('Reflow text requires positive bounds');
        const page = requirePage(context, command.pageId);
        for (const blockId of command.blockIds) {
          const object = page.objects.find(item => item.textBlock?.id === blockId);
          if (!object || !object.textBlock || object.textBlock.editability === 'geometry-only') {
            invalid('Target is not an editable text block');
          }
          if (deletedObjects.has(object.id) || object.textBlock.sourceObjectIds.some(sourceId => deletedObjects.has(sourceId))) {
            invalid('Object containing the text has been deleted');
          }
          deletedObjects.add(object.id);
          object.textBlock.sourceObjectIds.forEach(sourceId => deletedObjects.add(sourceId));
        }
        page.objects.push({
          id: command.objectId,
          pageId: command.pageId,
          type: 'text',
          bounds: command.bounds,
          transform: [1, 0, 0, 1, 0, 0],
          locator: { pageId: command.pageId, containerPath: [], objectIndex: page.objects.length },
          textBlock: {
            id: command.objectId,
            pageId: command.pageId,
            sourceObjectIds: [command.objectId],
            runs: [{ text: command.text, style: command.style, sourceObjectIds: [command.objectId] }],
            bounds: command.bounds,
            transform: [1, 0, 0, 1, 0, 0],
            editability: 'direct',
            isParagraph: true,
          },
        });
        break;
      }
      case 'objects.group': addId(command.groupId); break;
      case 'objects.ungroup': {
        if (!requirePage(context, command.pageId).objects.some(object => object.id === command.groupId && object.type === 'group')) invalid('Group does not exist');
        break;
      }
      case 'annotation.add':
        addId(command.annotationId);
        if (command.subtype === 'ink' && (!command.points || command.points.length < 2)) invalid('Ink annotation requires at least two points');
        annotations.set(command.annotationId, { pageId: command.pageId, subtype: command.subtype });
        break;
      case 'annotation.update': {
        const existing = annotations.get(command.annotationId);
        if (context.annotations && (!existing || existing.pageId !== command.pageId)) invalid('Annotation does not exist on this page');
        if (command.subtype === 'ink' && (!command.points || command.points.length < 2)) invalid('Replacing ink requires at least two stroke points');
        annotations.set(command.annotationId, { pageId: command.pageId, subtype: command.subtype });
        break;
      }
      case 'annotation.delete': {
        const existing = annotations.get(command.annotationId);
        if (context.annotations && (!existing || existing.pageId !== command.pageId)) invalid('Annotation does not exist on this page');
        annotations.delete(command.annotationId);
        break;
      }
      case 'form.create':
        addId(command.fieldId);
        fields.set(command.fieldId, { pageId: command.pageId, type: command.fieldType, options: [], readOnly: false });
        break;
      case 'form.fill': {
        const field = fields.get(command.fieldId);
        if (!field || !pageIds.has(field.pageId)) invalid('Form field does not exist or page was deleted');
        if (field.readOnly) invalid('Form field is read-only');
        if (field.type === 'checkbox' && typeof command.value !== 'boolean') invalid('Checkbox field requires a boolean value');
        if (field.type === 'text' && typeof command.value !== 'string') invalid('Text field requires a string value');
        if (field.type === 'radio' && (typeof command.value !== 'string' || !field.options?.includes(command.value))) invalid('Radio value is not among field options');
        if (field.type === 'choice') {
          const values = Array.isArray(command.value) ? command.value : [command.value];
          if (values.some(value => typeof value !== 'string' || !field.options?.includes(value))) invalid('Choice value is not among field options');
        }
        break;
      }
    }
    context = { ...context, document: { ...context.document, pageOrder: [...pageIds] } };
    if (context.pageLimit !== undefined && pageIds.size > context.pageLimit) invalid('Working document exceeds the web page limit; please use the desktop app');
  }
  return transaction;
}
export class CommandRegistry {
  constructor(private readonly engine: EngineAdapter) {}
  describe(capabilities: readonly CommandType[]) {
    return editCommandSchema.options.filter(schema => capabilities.includes(schema.shape.type.value))
      .map(schema => ({ type: schema.shape.type.value, label: labels[schema.shape.type.value], schema }));
  }
  execute(input: unknown, context: CommandContext) {
    return this.engine.apply(validateTransaction(input, context));
  }
}
