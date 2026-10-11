import { describe, expect, it } from 'vitest';
import { frameBounds, localFrameDelta, resizedTextFrame, selectionTextFrame, type TextFrame } from '../src/ui/text-frame.js';
import type { EditableObject, PageModel } from '@pdf-editor/contracts';

const frame: TextFrame = { width: 100, height: 20, transform: [2, 0, 0, 2, 10, 30], objectIds: ['text'] };

describe('text frame resize geometry', () => {
  it('changes local height, not the text transform, when dragging the bottom edge', () => {
    const before = [...frame.transform];
    const delta = localFrameDelta(frame, 0, 60);
    const box = resizedTextFrame(frame, 's', ...delta);
    expect(box).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(frame.transform).toEqual(before);
    expect(frameBounds(frame, box)).toEqual({ x: 10, y: 30, width: 200, height: 100 });
  });
  it('keeps the opposite edges anchored for a top-left handle', () => {
    expect(resizedTextFrame(frame, 'nw', -10, -15)).toEqual({ x: -10, y: -15, width: 110, height: 35 });
  });
  it('maps pointer changes through a rotated frame', () => {
    const rotated = { ...frame, transform: [0, 1, -1, 0, 100, 20] as TextFrame['transform'] };
    expect(localFrameDelta(rotated, -30, 10)).toEqual([10, 30]);
    expect(resizedTextFrame(rotated, 's', 10, 30).width).toBe(100);
  });
  it('clamps crossed edges to a positive frame rather than mirroring text', () => {
    expect(resizedTextFrame(frame, 'nw', 500, 500)).toEqual({ x: 99, y: 19, width: 1, height: 1 });
  });
  it('treats one detected paragraph as a frame and ordinary mixed selection as graphics', () => {
    const object: EditableObject = { id: 'text', pageId: 'page', type: 'text', bounds: { x: 10, y: 30, width: 200, height: 40 },
      transform: [2, 0, 0, -2, 10, 70], locator: { pageId: 'page', containerPath: [], objectIndex: 0 },
      textBlock: { id: 'block', pageId: 'page', bounds: { x: 10, y: 30, width: 200, height: 40 },
        transform: [2, 0, 0, -2, 10, 70], sourceObjectIds: ['text'], runs: [], editability: 'direct', frame } };
    const page: PageModel = { id: 'page', widthPt: 300, heightPt: 300, rotation: 0, objects: [object] };
    expect(selectionTextFrame(page, [object])).toEqual(frame);
    expect(selectionTextFrame(page, [object, { ...object, id: 'image', type: 'image', textBlock: undefined }])).toBeNull();
  });
});
