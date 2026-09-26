import { describe, expect, it } from 'vitest';
import { movePages, selectPages } from '../src/ui/page-selection.js';

const order = ['a', 'b', 'c', 'd', 'e'];
describe('page selection', () => {
  it('replaces a single selection and toggles Ctrl / Cmd selections in document order', () => {
    expect(selectPages(order, ['b'], 'b', 'd', {})).toEqual(['d']);
    expect(selectPages(order, ['d'], 'd', 'a', { ctrlKey: true })).toEqual(['a', 'd']);
    expect(selectPages(order, ['a', 'd'], 'd', 'a', { metaKey: true })).toEqual(['d']);
  });
  it('extends forward or backward from the unchanged anchor', () => {
    expect(selectPages(order, ['d'], 'd', 'b', { shiftKey: true })).toEqual(['b', 'c', 'd']);
    expect(selectPages(order, ['b', 'c', 'd'], 'd', 'c', { shiftKey: true })).toEqual(['c', 'd']);
    expect(selectPages(order, ['a'], 'c', 'e', { shiftKey: true, metaKey: true })).toEqual(['a', 'c', 'd', 'e']);
  });
  it('moves multiple pages in original order and ignores a drop onto the selection', () => {
    expect(movePages(order, ['a', 'c'], 'e', true)).toEqual(['b', 'd', 'e', 'a', 'c']);
    expect(movePages(order, ['d', 'e'], 'b', false)).toEqual(['a', 'd', 'e', 'b', 'c']);
    expect(movePages(order, ['a', 'c'], 'c', true)).toEqual(order);
  });
});
