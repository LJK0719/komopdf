import { describe, expect, it } from 'vitest';
import type { EditableObject, PageModel } from '@pdf-editor/contracts';
import { containsRect, isContainerInterior, pickObject, selectionScope } from '../src/ui/object-selection.js';
import { detectParagraph } from '../src/ui/paragraph-detection.js';
import { changedBlock, textChange } from '../src/ui/text-change.js';

function object(id: string, x: number, y: number, width: number, height: number, index = 0): EditableObject {
  return { id, type: 'path', pageId: 'p', bounds: { x, y, width, height }, transform: [1, 0, 0, -1, x, y],
    locator: { pageId: 'p', objectIndex: index, containerPath: [] } };
}
function text(id: string, x: number, y: number, index: number, value = 'Text'): EditableObject {
  const item = object(id, x, y, 110, 18, index);
  return { ...item, type: 'text', textBlock: { id: id + '-text', pageId: 'p', bounds: item.bounds, transform: item.transform,
    sourceObjectIds: [id], editability: 'direct', runs: [{ text: value, sourceObjectIds: [id], style: { fontId: 'font', fontSize: 20, characterSpacing: 2 } }] } };
}
const page = (objects: EditableObject[]): PageModel => ({ id: 'p', widthPt: 400, heightPt: 600, rotation: 0, objects });

describe('nested selection', () => {
  it('uses geometry and a small tolerance rather than the containing hitbox paint order', () => {
    const large = object('large', 0, 0, 300, 300), small = object('small', 30, 30, 12, 12);
    expect(pickObject([small, large], 29, 36, 2)?.id).toBe('small');
    expect(isContainerInterior(large, [large, small], 20, 20, 6)).toBe(true);
    expect(isContainerInterior(large, [large, small], 1, 20, 6)).toBe(false);
    const box = { x: 20, y: 20, width: 50, height: 50 };
    expect([large, small].filter(item => containsRect(box, item.bounds)).map(item => item.id)).toEqual(['small']);
  });
  it('retains explicit group boundaries until entering the group', () => {
    const group = { ...object('group', 0, 0, 200, 200), type: 'group' as const };
    const child = object('child', 20, 20, 20, 20);
    child.locator.containerPath = [0];
    expect(selectionScope(page([group, child]), []).map(item => item.id)).toEqual(['group']);
    expect(selectionScope(page([group, child]), ['child']).map(item => item.id)).toEqual(['child']);
  });
});

describe('conservative paragraph detection', () => {
  it('recognizes adjacent matching lines without changing source objects', () => {
    const a = text('a', 30, 40, 0), b = text('b', 30, 68, 1);
    const result = detectParagraph(page([a, b]), 'b')!;
    expect(result.objects).toEqual([a, b]);
    expect(result.text).toBe('Text\nText');
    expect(result.lineHeight).toBe(1.4);
    expect(result.style.characterSpacing).toBe(2);
    expect(a.textBlock?.isParagraph).toBeUndefined();
  });
  it('does not join columns, headings, rotated text or separated content order', () => {
    const a = text('a', 30, 40, 0);
    expect(detectParagraph(page([a, text('column', 250, 68, 1)]), 'a')).toBeNull();
    const heading = text('heading', 30, 68, 1); heading.textBlock!.runs[0]!.style.fontSize = 30;
    expect(detectParagraph(page([a, heading]), 'a')).toBeNull();
    const rotated = text('rotated', 30, 68, 1); rotated.transform = [0, 1, 1, 0, 30, 68];
    expect(detectParagraph(page([a, rotated]), 'a')).toBeNull();
    expect(detectParagraph(page([a, text('gap', 30, 68, 2)]), 'a')).toBeNull();
  });
  it('stops at table separators and does not exceed following content', () => {
    const a = text('a', 30, 40, 0), b = text('b', 30, 68, 1);
    const rule = object('rule', 25, 63, 140, 1, 2);
    expect(detectParagraph(page([a, b, rule]), 'a')).toBeNull();
    const next = object('next', 30, 95, 100, 20, 2);
    const candidate = detectParagraph(page([a, b, next]), 'a')!;
    expect(candidate.bounds.y + candidate.bounds.height).toBe(95);
  });
});

describe('in-place paragraph edits', () => {
  it('replaces whole graphemes, not half of combining or supplementary characters', () => {
    expect(textChange('AB Á CD', 'AB À CD')).toEqual({ range: [3, 5], text: 'À' });
    expect(textChange('A👋B', 'A👋🏻B')).toEqual({ range: [1, 3], text: '👋🏻' });
  });
  it('retains font and spacing runs outside a small text change', () => {
    const block = text('a', 0, 0, 0).textBlock!;
    block.runs = [{ text: 'Hello ', style: { characterSpacing: 2 }, sourceObjectIds: ['a'] },
      { text: 'world', style: { fontId: 'bold', characterSpacing: 3 }, sourceObjectIds: ['a'] }];
    const result = changedBlock(block, 'Hello brave world');
    expect(result.runs.map(run => run.text).join('')).toBe('Hello brave world');
    expect(result.runs.at(-1)?.style).toEqual({ fontId: 'bold', characterSpacing: 3 });
    expect(result.runs[0]?.style.characterSpacing).toBe(2);
  });
});
