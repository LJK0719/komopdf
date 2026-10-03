import { describe, expect, it } from 'vitest';
import type { PageModel } from '@pdf-editor/contracts';
import { createPageNumberCommand, pageNumberLabels, parsePageRange } from '../src/ui/page-number-utils.js';

const order = ['cover', 'a', 'b', 'c', 'd'];
const options = { order, targetIds: order, start: 1, template: '{page} / {total}', total: 'selected' as const, skipCover: true };

describe('page number labels', () => {
  it('keeps current/all/range selection semantics', () => {
    expect(parsePageRange('current', order, 'b')).toEqual(['b']);
    expect(parsePageRange('all', order, 'b')).toEqual(order);
    expect(parsePageRange('5,2-3,2', order, 'b')).toEqual(['a', 'b', 'd']);
  });
  it('skips the cover and numbers selected pages in document order', () => {
    expect(pageNumberLabels({ ...options, targetIds: ['d', 'cover', 'b', 'b'], start: 7 })).toEqual([
      { pageId: 'b', physicalPage: 3, text: '7 / 2' },
      { pageId: 'd', physicalPage: 5, text: '8 / 2' },
    ]);
  });
  it('distinguishes numbered-page count from PDF page count and final label', () => {
    expect(pageNumberLabels(options).map(label => label.text)).toEqual(['1 / 4', '2 / 4', '3 / 4', '4 / 4']);
    expect(pageNumberLabels({ ...options, start: 10, total: 'document' }).map(label => label.text)).toEqual(['10 / 5', '11 / 5', '12 / 5', '13 / 5']);
  });
  it('does not skip the first selected page when it is not the cover', () => {
    expect(pageNumberLabels({ ...options, targetIds: ['b', 'd'], start: 0, template: '第 {page} 页 / 共 {total} 页' }).map(label => label.text))
      .toEqual(['第 0 页 / 共 2 页', '第 1 页 / 共 2 页']);
    expect(pageNumberLabels({ ...options, skipCover: false })).toHaveLength(5);
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid or overflowing starts %s', start => {
    expect(() => pageNumberLabels({ ...options, start })).toThrow();
  });
  it('requires an actual number placeholder and a nonempty target', () => {
    expect(() => pageNumberLabels({ ...options, template: ' ' })).toThrow('Include {page}');
    expect(() => pageNumberLabels({ ...options, template: '{page} of {pages}' })).toThrow('Only {page}');
    expect(() => pageNumberLabels({ ...options, targetIds: ['cover'] })).toThrow('at least one');
  });
});

describe('page number insertion', () => {
  const page: PageModel = { id: 'a', widthPt: 612, heightPt: 792, rotation: 0, objects: [] };
  it.each(['left', 'center', 'right'] as const)('uses current text/font transactions at footer %s', alignment => {
    const style = { fontId: 'existing-font', fontSize: 12, color: [0.2, 0.3, 0.4] as [number, number, number] };
    const command = createPageNumberCommand(page, '7 / 9', style, alignment);
    expect(command).toMatchObject({ type: 'text.insert', pageId: 'a', text: '7 / 9', paragraph: true,
      bounds: { x: 36, y: 708, width: 540, height: 48 }, style: { ...style, alignment } });
    expect(page.objects).toEqual([]);
    expect(style).not.toHaveProperty('alignment');
  });
  it('keeps footer bounds within a small page', () => {
    const command = createPageNumberCommand({ ...page, widthPt: 40, heightPt: 60 }, '1', { fontId: 'font', fontSize: 8 }, 'center');
    expect(command.bounds.x).toBeGreaterThan(0);
    expect(command.bounds.y).toBeGreaterThan(0);
    expect(command.bounds.x + command.bounds.width).toBeLessThan(40);
    expect(command.bounds.y + command.bounds.height).toBeLessThan(60);
  });
});
