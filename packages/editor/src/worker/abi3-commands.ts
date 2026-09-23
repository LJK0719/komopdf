import { EngineError, type CommandType, type EditCommand, type TextStyle } from '@pdf-editor/contracts';

export const EDIT_COMMAND_STRIDE = 128;
export const ABI3_BASE_CAPABILITIES: CommandType[] = [
  'text.replace', 'text.style', 'text.insert', 'objects.transform', 'objects.delete',
  'pages.rotate', 'pages.delete', 'pages.reorder', 'pages.insert', 'image.insert', 'content.insert',
];

export const ABI3_CAPABILITIES: CommandType[] = [...ABI3_BASE_CAPABILITIES,
  'pages.duplicate', 'pages.import', 'image.replace', 'image.crop', 'objects.copy',
  'annotation.add', 'form.fill', 'form.create', 'text.reflow', 'objects.align',
  'annotation.update', 'annotation.delete', 'objects.distribute', 'pages.crop',
  'objects.group', 'objects.ungroup'];

type Allocator = { string(value: string): number; bytes(value: Uint8Array): number };
type PackedCommand = { fields: number[]; values: number[] };

export function packCommands(allocations: Allocator, commands: EditCommand[]): number {
  const records = commands.map(command => packCommand(allocations, command));
  const buffer = new Uint8Array(records.length * EDIT_COMMAND_STRIDE);
  const view = new DataView(buffer.buffer);
  records.forEach((record, index) => {
    const offset = index * EDIT_COMMAND_STRIDE;
    record.fields.forEach((value, field) => view.setUint32(offset + field * 4, value, true));
    record.values.forEach((value, field) => view.setFloat64(offset + 48 + field * 8, value, true));
  });
  return allocations.bytes(buffer);
}

function packCommand(allocations: Allocator, command: EditCommand): PackedCommand {
  // type,page,target,resource,text,font,ids,count,start,end,flags,resourcePage
  const fields = new Array<number>(12).fill(0);
  const values = new Array<number>(10).fill(0);
  const string = (field: number, value: string | null | undefined) => { fields[field] = value ? allocations.string(value) : 0; };
  const ids = (items: string[]) => {
    if (items.length === 0) { fields[6] = 0; fields[7] = 0; return; }
    const pointers = items.map(item => allocations.string(item));
    const bytes = new Uint8Array(pointers.length * 4);
    const view = new DataView(bytes.buffer);
    pointers.forEach((pointer, index) => view.setUint32(index * 4, pointer, true));
    fields[6] = allocations.bytes(bytes); fields[7] = pointers.length;
  };
  const bounds = (rect: { x: number; y: number; width: number; height: number }) => {
    values.splice(0, 4, rect.x, rect.y, rect.width, rect.height);
  };
  const style = (input: TextStyle, insert: boolean) => {
    const supported = ['fontId', 'fontSize', 'color', 'characterSpacing', ...(insert ? ['lineHeight', 'alignment'] : [])];
    if (Object.keys(input).some(key => !supported.includes(key))) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', 'This core does not yet support the requested text style');
    }
    let flags = 0;
    if (input.fontId !== undefined) { flags |= 1; string(5, input.fontId); }
    if (input.fontSize !== undefined) { flags |= 2; values[insert ? 4 : 0] = input.fontSize; }
    if (input.color !== undefined) { flags |= 4; values.splice(insert ? 5 : 1, 3, ...input.color); }
    if (input.characterSpacing !== undefined) { flags |= 8; values[insert ? 8 : 4] = input.characterSpacing; }
    if (insert && input.lineHeight !== undefined) { flags |= 16; values[9] = input.lineHeight; }
    if (insert && input.alignment === 'center') flags |= 32;
    if (insert && input.alignment === 'right') flags |= 64;
    if (insert && input.alignment === 'justify') throw new EngineError('UNSUPPORTED_CAPABILITY', 'Justified text is not supported by this layout engine yet');
    if (insert && (flags & 3) !== 3) throw new EngineError('INVALID_REQUEST', 'New text requires an explicit font and font size');
    fields[10] = flags;
  };
  if ('pageId' in command) string(1, command.pageId);
  switch (command.type) {
    case 'text.replace':
      fields[0] = 1; string(2, command.blockId); string(4, command.text);
      fields[8] = command.range[0]; fields[9] = command.range[1];
      if (command.style && Object.keys(command.style).some(key => key !== 'fontId')) throw new EngineError('UNSUPPORTED_CAPABILITY', 'Replacement currently supports only font selection');
      string(5, command.style?.fontId);
      // Empty replacement is an allocated empty string, not a missing argument.
      if (!command.text) fields[4] = allocations.string('');
      break;
    case 'text.style':
      fields[0] = 2; ids(command.blockIds); style(command.style, false);
      if (command.range) {
        if (command.blockIds.length !== 1 || command.range[0] >= command.range[1]) throw new EngineError('INVALID_REQUEST', 'Range formatting requires one block and a non-empty range');
        fields[8] = command.range[0]; fields[9] = command.range[1]; fields[10]! |= 16;
      }
      break;
    case 'text.insert':
      fields[0] = 3; string(2, command.objectId); fields[4] = allocations.string(command.text);
      bounds(command.bounds); style(command.style, true);
      if (command.paragraph && (command.invisible || command.fitBounds || command.ocr)) throw new EngineError('INVALID_REQUEST', 'paragraph is mutually exclusive with invisible, fitBounds, and ocr');
      if (command.fitBounds && !command.invisible) throw new EngineError('INVALID_REQUEST', 'fitBounds requires invisible text');
      if (command.ocr && (!command.invisible || !command.fitBounds)) throw new EngineError('INVALID_REQUEST', 'OCR text requires invisible fitted bounds');
      if (command.invisible) fields[10]! |= 128;
      if (command.fitBounds) fields[10]! |= 256;
      if (command.ocr) fields[10]! |= 512;
      if (command.paragraph) fields[10]! |= 1024;
      break;
    case 'text.reflow':
      fields[0] = 20; string(2, command.objectId); ids(command.blockIds);
      fields[4] = allocations.string(command.text);
      bounds(command.bounds); style(command.style, true);
      fields[10]! |= 1024;
      break;
    case 'objects.transform': fields[0] = 4; ids(command.objectIds); values.splice(0, 6, ...command.matrix); break;
    case 'objects.align': {
      if (command.objectIds.length < 2) throw new EngineError('INVALID_REQUEST', 'Alignment requires at least two objects');
      fields[0] = 21; ids(command.objectIds);
      values[0] = ['left', 'center', 'right', 'top', 'middle', 'bottom'].indexOf(command.axis);
      break;
    }
    case 'objects.distribute':
      if (command.objectIds.length < 3) throw new EngineError('INVALID_REQUEST', 'Distribution requires at least three objects');
      fields[0] = 24; ids(command.objectIds);
      values[0] = command.axis === 'horizontal' ? 0 : 1;
      break;
    case 'objects.delete': fields[0] = 5; ids(command.objectIds); break;
    case 'objects.group':
      if (command.objectIds.length < 2) throw new EngineError('INVALID_REQUEST', 'Grouping requires two objects');
      fields[0] = 26; string(2, command.groupId); ids(command.objectIds); break;
    case 'objects.ungroup':
      fields[0] = 27; string(2, command.groupId); break;
    case 'pages.rotate': fields[0] = 6; ids(command.pageIds); values[0] = command.degrees; break;
    case 'pages.crop': fields[0] = 25; ids(command.pageIds); bounds(command.bounds); break;
    case 'pages.delete': fields[0] = 7; ids(command.pageIds); break;
    case 'pages.reorder': fields[0] = 8; ids(command.pageIds); break;
    case 'pages.insert':
      fields[0] = 9; string(2, command.afterPageId); values[0] = command.widthPt; values[1] = command.heightPt; break;
    case 'image.insert': case 'content.insert':
      fields[0] = command.type === 'image.insert' ? 10 : 11;
      string(2, command.objectId); string(3, command.resourceId); bounds(command.bounds);
      if (command.type === 'content.insert') fields[11] = command.resourcePageIndex;
      break;
    case 'pages.duplicate':
      fields[0] = 12; string(2, command.afterPageId);
      if (command.pageIds.length !== command.newPageIds.length) throw new EngineError('INVALID_REQUEST', 'Duplicate page count mismatch');
      ids(command.pageIds.flatMap((id, index) => [id, command.newPageIds[index]!])); break;
    case 'pages.import':
      fields[0] = 13; string(2, command.afterPageId); string(3, command.resourceId);
      if (command.pageIndices.length !== command.newPageIds.length) throw new EngineError('INVALID_REQUEST', 'Imported page count mismatch');
      ids(command.pageIndices.flatMap((index, offset) => [String(index), command.newPageIds[offset]!])); break;
    case 'image.replace':
      fields[0] = 14; string(2, command.objectId); string(3, command.resourceId); break;
    case 'image.crop':
      fields[0] = 15; string(2, command.objectId); bounds(command.bounds); break;
    case 'objects.copy':
      fields[0] = 16;
      if (command.objectIds.length !== command.newObjectIds.length) throw new EngineError('INVALID_REQUEST', 'Copied object count mismatch');
      ids(command.objectIds.flatMap((id, index) => [id, command.newObjectIds[index]!]));
      values[0] = command.offset.x; values[1] = command.offset.y; break;
    case 'annotation.add': case 'annotation.update': {
      fields[0] = command.type === 'annotation.add' ? 17 : 22;
      string(2, command.annotationId); string(3, command.subtype);
      fields[4] = allocations.string(command.text ?? ''); bounds(command.bounds);
      let flags = 0;
      if (command.color !== undefined) { flags |= 1; values.splice(4, 3, ...command.color); }
      if (command.opacity !== undefined) { flags |= 2; values[7] = command.opacity; }
      if (command.strokeWidth !== undefined) { flags |= 4; values[8] = command.strokeWidth; }
      if (command.subtype === 'ink') {
        if (!command.points || command.points.length < 2) throw new EngineError('INVALID_REQUEST', 'Ink annotation requires at least two points');
        ids(command.points.flatMap(([x, y]) => [String(x), String(y)]));
      }
      fields[10] = flags;
      break;
    }
    case 'annotation.delete':
      fields[0] = 23; string(2, command.annotationId); break;
    case 'form.fill':
      fields[0] = 18; string(2, command.fieldId);
      if (typeof command.value === 'string') fields[4] = allocations.string(command.value);
      else if (typeof command.value === 'boolean') { fields[10] = 1; values[0] = command.value ? 1 : 0; }
      else { fields[10] = 2; ids(command.value); }
      break;
    case 'form.create':
      fields[0] = 19; string(2, command.fieldId); string(3, command.fieldType);
      fields[4] = allocations.string(command.name); bounds(command.bounds);
      values[4] = command.fontSize ?? 12;
      if (command.fontId !== undefined) { fields[10] = 1; string(5, command.fontId); }
      break;
    default: throw new EngineError('UNSUPPORTED_CAPABILITY', 'Command is not connected to this core');
  }
  return { fields, values };
}
