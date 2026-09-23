import { describe, expect, it } from 'vitest';
import type { EditCommand } from '@pdf-editor/contracts';
import { EDIT_COMMAND_STRIDE, packCommands } from '../src/worker/abi3-commands.js';

class TestAllocator {
  private next = 1;
  readonly strings = new Map<number, string>();
  readonly buffers = new Map<number, Uint8Array>();

  string(value: string): number {
    const pointer = this.next++;
    this.strings.set(pointer, value);
    return pointer;
  }

  bytes(value: Uint8Array): number {
    const pointer = this.next++;
    this.buffers.set(pointer, value.slice());
    return pointer;
  }
}

function packed(commands: EditCommand[]) {
  const allocator = new TestAllocator();
  const pointer = packCommands(allocator, commands);
  const bytes = allocator.buffers.get(pointer);
  if (!bytes) throw new Error('Missing packed command buffer');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const record = (index: number) => {
    const offset = index * EDIT_COMMAND_STRIDE;
    const fields = Array.from({ length: 12 }, (_, field) => view.getUint32(offset + field * 4, true));
    const values = Array.from({ length: 10 }, (_, field) => view.getFloat64(offset + 48 + field * 8, true));
    const idsBuffer = allocator.buffers.get(fields[6]!);
    const ids = idsBuffer ? Array.from({ length: fields[7]! }, (_, item) => {
      const idPointer = new DataView(idsBuffer.buffer, idsBuffer.byteOffset, idsBuffer.byteLength).getUint32(item * 4, true);
      return allocator.strings.get(idPointer);
    }) : [];
    return { fields, values, ids, string: (field: number) => allocator.strings.get(fields[field]!) };
  };
  return { bytes, record };
}

describe('ABI 3 command encoding', () => {
  it('encodes native alignment axes without changing the ABI3 record', () => {
    const { bytes, record } = packed((['left', 'center', 'right', 'top', 'middle', 'bottom'] as const)
      .map(axis => ({ type: 'objects.align', pageId: 'page-1', objectIds: ['path-a', 'path-b'], axis })));
    expect(bytes.byteLength).toBe(6 * EDIT_COMMAND_STRIDE);
    for (let index = 0; index < 6; index++) {
      expect(record(index).fields[0]).toBe(21);
      expect(record(index).values[0]).toBe(index);
      expect(record(index).ids).toEqual(['path-a', 'path-b']);
    }
  });
  it('encodes annotation.add flags, geometry and repeated ink coordinates without changing stride', () => {
    const { bytes, record } = packed([{
      type: 'annotation.add', pageId: 'page-1', annotationId: 'annotation-1', subtype: 'ink',
      bounds: { x: 1, y: 2, width: 30, height: 40 }, text: '', color: [0.1, 0.2, 0.3],
      opacity: 0.5, strokeWidth: 2.5, points: [[4, 5], [4, 5]],
    }]);
    const command = record(0);
    expect(bytes.byteLength).toBe(128);
    expect(command.fields[0]).toBe(17);
    expect(command.string(1)).toBe('page-1');
    expect(command.string(2)).toBe('annotation-1');
    expect(command.string(3)).toBe('ink');
    expect(command.string(4)).toBe('');
    expect(command.fields[10]).toBe(7);
    expect(command.values.slice(0, 9)).toEqual([1, 2, 30, 40, 0.1, 0.2, 0.3, 0.5, 2.5]);
    expect(command.ids).toEqual(['4', '5', '4', '5']);
  });

  it('encodes a real CropBox edit for selected pages', () => {
    const { bytes, record } = packed([{
      type: 'pages.crop', pageIds: ['p1', 'p2'], bounds: { x: 12, y: 18, width: 80, height: 120 },
    }]);
    expect(bytes.byteLength).toBe(EDIT_COMMAND_STRIDE);
    expect(record(0).fields[0]).toBe(25);
    expect(record(0).ids).toEqual(['p1', 'p2']);
    expect(record(0).values.slice(0, 4)).toEqual([12, 18, 80, 120]);
  });

  it('encodes distribution on either page axis without widening the ABI', () => {
    const { bytes, record } = packed([
      { type: 'objects.distribute', pageId: 'page-1', objectIds: ['a', 'b', 'c'], axis: 'horizontal' },
      { type: 'objects.distribute', pageId: 'page-1', objectIds: ['a', 'b', 'c'], axis: 'vertical' },
    ]);
    expect(bytes.byteLength).toBe(2 * EDIT_COMMAND_STRIDE);
    expect(record(0).fields[0]).toBe(24);
    expect(record(1).fields[0]).toBe(24);
    expect(record(0).values[0]).toBe(0);
    expect(record(1).values[0]).toBe(1);
    expect(record(0).ids).toEqual(['a', 'b', 'c']);
  });

  it('encodes annotation updates and deletion with a stable ID', () => {
    const { bytes, record } = packed([
      { type: 'annotation.update', pageId: 'page-1', annotationId: 'note-1', subtype: 'text',
        bounds: { x: 4, y: 5, width: 20, height: 20 }, text: 'Edited', color: [0, 0, 1], opacity: 0.8 },
      { type: 'annotation.delete', pageId: 'page-1', annotationId: 'note-1' },
    ]);
    expect(bytes.byteLength).toBe(2 * EDIT_COMMAND_STRIDE);
    expect(record(0).fields[0]).toBe(22);
    expect(record(0).string(2)).toBe('note-1');
    expect(record(0).string(4)).toBe('Edited');
    expect(record(0).fields[10]).toBe(3);
    expect(record(0).values.slice(0, 8)).toEqual([4, 5, 20, 20, 0, 0, 1, 0.8]);
    expect(record(1).fields[0]).toBe(23);
    expect(record(1).string(2)).toBe('note-1');
    expect(record(1).ids).toEqual([]);
  });

  it('encodes grouping and ungrouping with persistent group identity', () => {
    const { bytes, record } = packed([
      { type: 'objects.group', pageId: 'page-1', objectIds: ['text-a', 'path-b'], groupId: 'group-1' },
      { type: 'objects.ungroup', pageId: 'page-1', groupId: 'group-1' },
    ]);
    expect(bytes.byteLength).toBe(2 * EDIT_COMMAND_STRIDE);
    expect(record(0).fields[0]).toBe(26);
    expect(record(0).string(1)).toBe('page-1');
    expect(record(0).string(2)).toBe('group-1');
    expect(record(0).ids).toEqual(['text-a', 'path-b']);
    expect(record(1).fields[0]).toBe(27);
    expect(record(1).string(2)).toBe('group-1');
    expect(record(1).ids).toEqual([]);
  });

  it('encodes all form.fill value variants including empty string and empty option list', () => {
    const { bytes, record } = packed([
      { type: 'form.fill', fieldId: 'text-field', value: '' },
      { type: 'form.fill', fieldId: 'check-field', value: false },
      { type: 'form.fill', fieldId: 'choice-field', value: [] },
    ]);
    expect(bytes.byteLength).toBe(3 * EDIT_COMMAND_STRIDE);
    expect(record(0)).toMatchObject({ fields: expect.arrayContaining([18]), ids: [] });
    expect(record(0).string(2)).toBe('text-field');
    expect(record(0).string(4)).toBe('');
    expect(record(0).fields[10]).toBe(0);
    expect(record(1).fields[0]).toBe(18);
    expect(record(1).fields[10]).toBe(1);
    expect(record(1).values[0]).toBe(0);
    expect(record(2).fields[0]).toBe(18);
    expect(record(2).fields[10]).toBe(2);
    expect(record(2).fields[7]).toBe(0);
    expect(record(2).ids).toEqual([]);
  });

  it('encodes form.create with optional font and a default 12 point size', () => {
    const { record } = packed([
      { type: 'form.create', pageId: 'page-1', fieldId: 'field-1', name: 'Name', fieldType: 'text',
        bounds: { x: 10, y: 20, width: 100, height: 18 }, fontId: 'user-font-1' },
      { type: 'form.create', pageId: 'page-1', fieldId: 'field-2', name: 'Accept', fieldType: 'checkbox',
        bounds: { x: 5, y: 6, width: 12, height: 12 }, fontSize: 9 },
    ]);
    const text = record(0);
    expect(text.fields[0]).toBe(19);
    expect(text.string(1)).toBe('page-1');
    expect(text.string(2)).toBe('field-1');
    expect(text.string(3)).toBe('text');
    expect(text.string(4)).toBe('Name');
    expect(text.string(5)).toBe('user-font-1');
    expect(text.fields[10]).toBe(1);
    expect(text.values.slice(0, 5)).toEqual([10, 20, 100, 18, 12]);
    expect(record(1).fields[10]).toBe(0);
    expect(record(1).values[4]).toBe(9);
  });

  it('rejects an ink annotation without a complete point pair list', () => {
    expect(() => packed([{
      type: 'annotation.add', pageId: 'page-1', annotationId: 'annotation-1', subtype: 'ink',
      bounds: { x: 0, y: 0, width: 10, height: 10 }, points: [],
    }])).toThrow('at least two points');
  });
});
