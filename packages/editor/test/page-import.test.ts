import { describe, expect, it } from 'vitest';
import { createPageImportCommand, parsePageIndices } from '../src/ui/page-import-utils.js';

const order = ['a', 'b', 'c'];

describe('source PDF page selection', () => {
  it('converts one-based ranges to zero-based source order and removes overlaps', () => {
    expect(parsePageIndices(' 5, 2-4, 2 ', 5)).toEqual([1, 2, 3, 4]);
    expect(parsePageIndices('ALL', 3)).toEqual([0, 1, 2]);
  });
  it.each(['', 'current', '0', '1-6', '3-1', '1.5', '1,', '9007199254740992'])('rejects invalid source range %s', input => {
    expect(() => parsePageIndices(input, 5)).toThrow();
  });
  it.each([null, 'b', 'c'])('builds one existing import command at %s', afterPageId => {
    const command = createPageImportCommand('source', 7, '2-3,7', afterPageId, order);
    expect(command).toMatchObject({ type: 'pages.import', resourceId: 'source', pageIndices: [1, 2, 6], afterPageId });
    expect(command.newPageIds).toHaveLength(3);
    expect(new Set(command.newPageIds).size).toBe(3);
    expect(order).toEqual(['a', 'b', 'c']);
  });
  it('validates destination position and page limit without silently truncating', () => {
    expect(() => createPageImportCommand('source', 3, 'all', 'missing', order)).toThrow('insertion page');
    expect(() => createPageImportCommand('source', 3, 'all', null, order, 5)).toThrow('page limit');
    expect(createPageImportCommand('source', 3, '1-2', null, order, 5).pageIndices).toEqual([0, 1]);
    expect(() => createPageImportCommand('source', 0, 'all', null, order)).toThrow('no pages');
  });
});
