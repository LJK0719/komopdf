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
  'form.fill': 'Fill Form', 'form.create': 'Create Form Field', 'form.update': 'Update Form Field Properties',
};
export type CommandContext = {
  document: DocumentInfo;
  pages: ReadonlyMap<string, PageModel>;
  fields?: ReadonlyMap<string, { pageId: string; type: 'text' | 'checkbox' | 'radio' | 'choice';
    options?: readonly string[]; readOnly?: boolean; choiceKind?: 'combo' | 'list'; multiple?: boolean;
    value?: string | boolean | string[] | undefined; maxLen?: number | undefined; tooltip?: string | undefined }>;
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
  const updatedText = new Map<string, string>();
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
        const current = updatedText.get(command.blockId) ?? blockText(context, command.pageId, command.blockId);
        updatedText.set(command.blockId, current.slice(0, command.range[0]) + command.text + current.slice(command.range[1]));
        break;
      }
      case 'text.style':
        for (const id of command.blockIds) {
          if (command.range && updatedText.has(id)) {
            try { assertTextRange(updatedText.get(id)!, command.range); }
            catch (error) { invalid(error instanceof Error ? error.message : 'Invalid text range'); }
          } else if (command.range) validateRange(context, command.pageId, id, command.range);
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
          const containerPath = source.locator.containerPath;
          const siblings = page.objects.filter(object => object.locator.containerPath.length === containerPath.length &&
            object.locator.containerPath.every((part, offset) => part === containerPath[offset]));
          const objectIndex = Math.max(-1, ...siblings.map(object => object.locator.objectIndex)) + 1;
          page.objects.push({ id, pageId: page.id, type: source.type,
            bounds: { ...source.bounds, x: source.bounds.x + command.offset.x, y: source.bounds.y + command.offset.y },
            transform: [...source.transform], locator: { pageId: page.id, containerPath: [...containerPath], objectIndex } });
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
      case 'objects.group': {
        if (command.objectIds.length < 2) invalid('Select at least two objects to group');
        const page = requirePage(context, command.pageId);
        const members = command.objectIds.map(id => page.objects.find(object => object.id === id)!);
        const parent = members[0]!.locator.containerPath;
        if (members.some(object => object.locator.containerPath.length !== parent.length ||
            object.locator.containerPath.some((part, index) => part !== parent[index]))) {
          invalid('Group members must share the same drawing container');
        }
        members.sort((left, right) => left.locator.objectIndex - right.locator.objectIndex);
        const first = members[0]!.locator.objectIndex;
        const siblings = page.objects.filter(object => object.locator.containerPath.length === parent.length &&
          parent.every((part, index) => object.locator.containerPath[index] === part))
          .sort((left, right) => left.locator.objectIndex - right.locator.objectIndex);
        const firstSibling = siblings.indexOf(members[0]!);
        if (members.some((object, index) => siblings[firstSibling + index] !== object)) invalid('Group members must be adjacent in drawing order');
        const last = members.at(-1)!;
        const trailingUnderline = last.type === 'text' && !last.textBlock?.isParagraph &&
          last.textBlock?.runs.some(run => run.style.underline);
        const memberSlots = last.locator.objectIndex - first + 1 + (trailingUnderline ? 1 : 0);
        addId(command.groupId);
        const x = Math.min(...members.map(object => object.bounds.x));
        const y = Math.min(...members.map(object => object.bounds.y));
        const right = Math.max(...members.map(object => object.bounds.x + object.bounds.width));
        const bottom = Math.max(...members.map(object => object.bounds.y + object.bounds.height));
        page.objects = page.objects.map(object => {
          const path = [...object.locator.containerPath, object.locator.objectIndex];
          if (path.length <= parent.length || parent.some((part, index) => path[index] !== part)) return object;
          const index = path[parent.length]!;
          if (index < first) return object;
          if (index < first + memberSlots) path.splice(parent.length, 1, first, index - first);
          else path[parent.length] = index - memberSlots + 1;
          return { ...object, locator: { ...object.locator, containerPath: path.slice(0, -1), objectIndex: path.at(-1)! } };
        });
        page.objects.push({ id: command.groupId, pageId: page.id, type: 'group',
          bounds: { x, y, width: right - x, height: bottom - y }, transform: [1, 0, 0, 1, 0, 0],
          locator: { pageId: page.id, containerPath: [...parent], objectIndex: first } });
        break;
      }
      case 'objects.ungroup': {
        const page = requirePage(context, command.pageId);
        const group = page.objects.find(object => object.id === command.groupId && object.type === 'group');
        if (!group || deletedObjects.has(group.id)) invalid('Group does not exist');
        const parent = group.locator.containerPath;
        const first = group.locator.objectIndex;
        const children = page.objects.filter(object => object.locator.containerPath.length === parent.length + 1 &&
          object.locator.containerPath[parent.length] === first &&
          parent.every((part, index) => object.locator.containerPath[index] === part));
        page.objects = page.objects.filter(object => object.id !== group.id).map(object => {
          const path = [...object.locator.containerPath, object.locator.objectIndex];
          if (path.length <= parent.length || parent.some((part, index) => path[index] !== part)) return object;
          const index = path[parent.length]!;
          if (index < first) return object;
          if (index === first) path.splice(parent.length, 2, first + path[parent.length + 1]!);
          else path[parent.length] = index + children.length - 1;
          return { ...object, locator: { ...object.locator, containerPath: path.slice(0, -1), objectIndex: path.at(-1)! } };
        });
        deletedObjects.add(group.id);
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
      case 'form.create': {
        const choice = command.fieldType === 'combo' || command.fieldType === 'list';
        const optionField = choice || command.fieldType === 'radio';
        if (optionField && (!command.options?.length ||
            new Set(command.options).size !== command.options.length || (choice && !command.fontId))) {
          invalid('Choice and radio fields require distinct options; choices also need an embedded font');
        }
        if (!optionField && command.options !== undefined) invalid('Only choice and radio fields accept options');
        if (command.multiple && command.fieldType !== 'list') invalid('Only list fields support multiple choices');
        addId(command.fieldId);
        fields.set(command.fieldId, { pageId: command.pageId,
          type: command.fieldType === 'combo' || command.fieldType === 'list' ? 'choice' : command.fieldType,
          ...(choice ? { choiceKind: command.fieldType === 'list' ? 'list' as const : 'combo' as const } : {}),
          options: command.options ?? [], readOnly: command.readOnly ?? false, multiple: command.multiple ?? false });
        break;
      }
      case 'form.fill': {
        const field = fields.get(command.fieldId);
        if (!field || !pageIds.has(field.pageId)) invalid('Form field does not exist or page was deleted');
        if (field.readOnly) invalid('Form field is read-only');
        if (field.type === 'checkbox' && typeof command.value !== 'boolean') invalid('Checkbox field requires a boolean value');
        if (field.type === 'text' && typeof command.value !== 'string') invalid('Text field requires a string value');
        if (field.type === 'text' && typeof command.value === 'string' && field.maxLen !== undefined && field.maxLen > 0) {
          if (command.value.length > field.maxLen) invalid('Text value exceeds field maximum length');
        }
        if (field.type === 'radio' && (typeof command.value !== 'string' || !field.options?.includes(command.value))) invalid('Radio value is not among field options');
        if (field.type === 'choice') {
          const values = Array.isArray(command.value) ? command.value : [command.value];
          if (values.some(value => typeof value !== 'string' || !field.options?.includes(value))) invalid('Choice value is not among field options');
          if (values.length > 1 && !field.multiple) invalid('Multiple values require a multi-select list field');
        }
        fields.set(command.fieldId, { ...field, value: command.value });
        break;
      }
      case 'form.update': {
        const field = fields.get(command.fieldId);
        if (!field || !pageIds.has(field.pageId)) invalid('Form field does not exist or page was deleted');
        if (command.multiple !== undefined && field.choiceKind !== 'list') invalid('Only list fields support multiple choices');
        if (command.maxLen !== undefined && field.type !== 'text') invalid('MaxLen is only supported for text fields');
        if (command.maxLen !== undefined && command.maxLen !== null && command.maxLen > 0) {
          if (typeof field.value === 'string' && field.value.length > command.maxLen) {
            invalid('Text field current value exceeds requested maximum length');
          }
        }
        const nextMaxLen = command.maxLen !== undefined
          ? (command.maxLen === null || command.maxLen === 0 ? undefined : command.maxLen)
          : field.maxLen;
        const nextTooltip = command.tooltip !== undefined
          ? (command.tooltip === null || command.tooltip === '' ? undefined : command.tooltip)
          : field.tooltip;
        fields.set(command.fieldId, { ...field,
          readOnly: command.readOnly ?? field.readOnly ?? false,
          multiple: command.multiple ?? field.multiple ?? false,
          ...(nextMaxLen !== undefined ? { maxLen: nextMaxLen } : { maxLen: undefined }),
          ...(nextTooltip !== undefined ? { tooltip: nextTooltip } : { tooltip: undefined }),
        });
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
