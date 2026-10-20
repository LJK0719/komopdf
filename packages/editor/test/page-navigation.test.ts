import { describe, expect, it } from 'vitest';
import { adjacentPageId } from '../src/ui/page-navigation.js';

const order = ['a', 'b', 'c', 'd', 'e'];
describe('adjacent page navigation', () => {
  it('keeps single-page navigation at one page per step', () => {
    expect(adjacentPageId(order, 1, 1, 'single')).toBe('c');
    expect(adjacentPageId(order, 3, -1, 'single')).toBe('c');
  });
  it('advances from either facing page to the beginning of the next spread', () => {
    expect(adjacentPageId(order, 0, 1, 'double')).toBe('c');
    expect(adjacentPageId(order, 1, 1, 'double')).toBe('c');
    expect(adjacentPageId(order, 2, 1, 'double')).toBe('e');
    expect(adjacentPageId(order, 3, 1, 'double')).toBe('e');
  });
  it('returns to the previous spread from either page, including an odd final page', () => {
    expect(adjacentPageId(order, 2, -1, 'double')).toBe('a');
    expect(adjacentPageId(order, 3, -1, 'double')).toBe('a');
    expect(adjacentPageId(order, 4, -1, 'double')).toBe('c');
  });
  it('does not navigate outside the document or repeat the current boundary spread', () => {
    expect(adjacentPageId(order, 0, -1, 'single')).toBeUndefined();
    expect(adjacentPageId(order, 4, 1, 'single')).toBeUndefined();
    expect(adjacentPageId(order, 1, -1, 'double')).toBeUndefined();
    expect(adjacentPageId(order, 4, 1, 'double')).toBeUndefined();
    expect(adjacentPageId(order.slice(0, 4), 3, 1, 'double')).toBeUndefined();
    expect(adjacentPageId([], -1, 1, 'double')).toBeUndefined();
    expect(adjacentPageId(order, -1, 1, 'single')).toBeUndefined();
  });
});
