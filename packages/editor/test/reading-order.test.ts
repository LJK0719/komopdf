import { describe, expect, it } from 'vitest';
import type { EditableObject, PageModel } from '@pdf-editor/contracts';
import { readingRegions } from '../src/ui/reading-order.js';
import { conversionPages } from '../src/ui/document-conversion.js';

function text(id: string, x: number, y: number, width = 150, height = 30): EditableObject {
  const bounds = { x, y, width, height };
  return { id, pageId: 'p', type: 'text', bounds, transform: [1, 0, 0, -1, 0, 0],
    locator: { pageId: 'p', containerPath: [], objectIndex: 0 },
    textBlock: { id: `${id}-text`, pageId: 'p', sourceObjectIds: [id], bounds, transform: [1, 0, 0, -1, 0, 0],
      isParagraph: true, editability: 'direct', runs: [{ text: id, style: { fontSize: 10 }, sourceObjectIds: [id] }] } };
}
const page = (objects: EditableObject[]): PageModel => ({ id: 'p', objects, widthPt: 400, heightPt: 250, rotation: 0 });

describe('shared reading and export order', () => {
  it('reads a spanning heading, then each column rather than interleaving rows', () => {
    const model = page([text('R2', 230, 100), text('L2', 20, 100), text('R1', 230, 50),
      text('Heading', 20, 10, 360, 20), text('L1', 20, 50)]);
    expect(readingRegions(model).map(region => region.text)).toEqual(['Heading', 'L1', 'L2', 'R1', 'R2']);
  });
  it('keeps a ruled table in row-major order', () => {
    const rule: EditableObject = { id: 'rule', pageId: 'p', type: 'path', bounds: { x: 10, y: 90, width: 380, height: 1 },
      transform: [1, 0, 0, -1, 0, 0], locator: { pageId: 'p', containerPath: [], objectIndex: 4 } };
    expect(readingRegions(page([text('R2', 230, 100), text('L1', 20, 50), rule, text('R1', 230, 50), text('L2', 20, 100)]))
      .map(region => region.text)).toEqual(['L1', 'R1', 'L2', 'R2']);
  });
  it('preserves requested export order and validates page numbers', () => {
    expect(conversionPages('3-1, 2', 3, 0)).toEqual([2, 1, 0, 1]);
    expect(conversionPages('current', 3, 1)).toEqual([1]);
    expect(conversionPages('all', 3, 1)).toEqual([0, 1, 2]);
    expect(() => conversionPages('0,4', 3, 0)).toThrow(/outside/);
    expect(() => conversionPages('1-x', 3, 0)).toThrow(/page numbers/);
  });
});
