import { describe, expect, it } from 'vitest';
import type { EditableObject, PageModel } from '@pdf-editor/contracts';
import { containsRect, isContainerInterior, normalizeSelection, objectSelectionIds, pickObject, selectionScope } from '../src/ui/object-selection.js';
import { detectParagraph, selectedTextObject } from '../src/ui/paragraph-detection.js';
import { logicalTextBlock, logicalTextOffset, logicalTextRange, paragraphInputRange, sourceTextOffset } from '../src/ui/source-text.js';
import { applyParagraphFormats, canFormatSourceParagraph, resolveParagraphRunFont, sourceParagraphLayout, sourceParagraphStyles } from '../src/ui/source-paragraph-edit.js';
import { paragraphEditRange, PdfTextLayer, type TextSelectionTarget } from '../src/ui/PdfTextLayer.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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

describe('spatial paragraph detection', () => {
  it('recognizes adjacent matching lines without changing source objects', () => {
    const a = text('a', 30, 40, 0), b = text('b', 30, 68, 1);
    const result = detectParagraph(page([a, b]), 'b')!;
    expect(result.objects).toEqual([a, b]);
    expect(result.text).toBe('Text Text');
    expect(result.lineHeight).toBe(1.4);
    expect(result.style.characterSpacing).toBe(2);
    expect(a.textBlock?.isParagraph).toBeUndefined();
  });
  it('does not join columns, headings or rotated text, but ignores drawing order', () => {
    const a = text('a', 30, 40, 0);
    expect(detectParagraph(page([a, text('column', 250, 68, 1)]), 'a')).toBeNull();
    const heading = text('heading', 30, 68, 1); heading.textBlock!.runs[0]!.style.fontSize = 30;
    expect(detectParagraph(page([a, heading]), 'a')).toBeNull();
    const rotated = text('rotated', 30, 68, 1); rotated.transform = [0, 1, 1, 0, 30, 68];
    expect(detectParagraph(page([a, rotated]), 'a')).toBeNull();
    expect(detectParagraph(page([text('gap', 30, 68, 9), a]), 'a')?.text).toBe('Text Text');
  });
  it('joins shuffled character objects and retains mixed styles without CJK spaces', () => {
    const chars = ['段', '落', '识', '别'].map((value, i) => {
      const item = text(String(i), 30 + i % 2 * 20, 40 + Math.floor(i / 2) * 28, 10 - i, value);
      item.bounds.width = 20;
      if (i === 1) item.textBlock!.runs[0]!.style = { fontId: 'bold', fontSize: 20, weight: 700 };
      return item;
    });
    const result = detectParagraph(page([chars[3]!, chars[1]!, chars[0]!, chars[2]!]), '1')!;
    expect(result.text).toBe('段落识别');
    expect(result.runs.some(run => run.text === '落' && run.style.weight === 700)).toBe(true);
    expect(result.objects).toEqual(chars);
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

describe('paragraph selection and source-preserving formatting', () => {
  it('uses the same whole paragraph for hover, click, edit and transforms', () => {
    const a = text('a', 30, 40, 0, 'Hello world'), b = text('b', 30, 68, 1, 'Second line');
    b.bounds.width = 60;
    const model = page([b, a]);
    const scope = selectionScope(model, []);
    expect(scope).toHaveLength(1);
    expect(scope[0]!.bounds).toEqual(detectParagraph(model, 'b')!.bounds);
    expect(pickObject(scope, 50, 75, 0)?.id).toBe('a');
    expect(objectSelectionIds(model, 'b')).toEqual(['a', 'b']);
    expect(selectedTextObject(model, ['a', 'b'])?.id).toBe('a');
    const paragraph = detectParagraph(model, 'a')!;
    const commands = sourceParagraphLayout(model, paragraph, { alignment: 'center' });
    expect(commands).toEqual([{ type: 'objects.transform', pageId: 'p', objectIds: ['b'], matrix: [1, 0, 0, 1, 25, 0] }]);
    expect(a.textBlock!.runs[0]!.text).toBe('Hello world');
    expect(sourceParagraphStyles(model, paragraph, paragraph.runs, [])).toEqual([]);
    const centered = { ...b, bounds: { ...b.bounds, x: 55 } };
    const centeredModel = page([centered, a]);
    expect(detectParagraph(centeredModel, 'b')!.style.alignment).toBe('center');
    expect(objectSelectionIds(centeredModel, 'b')).toEqual(['a', 'b']);
    expect(sourceParagraphLayout(centeredModel, detectParagraph(centeredModel, 'a')!, { alignment: 'left' })[0])
      .toMatchObject({ objectIds: ['b'], matrix: [1, 0, 0, 1, -25, 0] });
  });
  it('retains explicit/multiple spaces and restores internal TJ word gaps without changing native ranges', () => {
    const a = text('a', 30, 40, 0, 'AlphaBeta  Gamma'), b = text('b', 30, 68, 1, 'Second line');
    a.textBlock!.inferredSpaces = [5];
    a.textBlock!.characters = [{ range: [5, 6], bounds: a.bounds, angle: 0, rtl: false }];
    const block = logicalTextBlock(a.textBlock!);
    expect(block.runs[0]!.text).toBe('Alpha Beta  Gamma');
    expect(block.characters![0]!.range).toEqual([6, 7]);
    expect(logicalTextOffset(a.textBlock!, 9)).toBe(10);
    expect(sourceTextOffset(a.textBlock!, 10)).toBe(9);
    const model = page([a, b]), paragraph = detectParagraph(model, 'a')!;
    expect(paragraph.text).toBe('Alpha Beta  Gamma Second line');
    const runs = applyParagraphFormats(paragraph.runs, [{ range: [6, 10], style: { color: [1, 0, 0] } }]);
    expect(sourceParagraphStyles(model, paragraph, runs, [])).toEqual([{ type: 'text.style', pageId: 'p', blockIds: ['a-text'],
      range: [5, 9], style: { color: [1, 0, 0] } }]);
    expect(a.textBlock!.runs[0]!.text).toBe('AlphaBeta  Gamma');
  });
  it('falls back to native reflow when source layout leaves its frame/page or loses the paragraph group', () => {
    const model = page([text('a', 30, 40, 0), text('b', 30, 68, 1)]);
    const paragraph = detectParagraph(model, 'a')!;
    expect(canFormatSourceParagraph(model, paragraph, { lineHeight: 1.6 })).toBe(true);
    expect(canFormatSourceParagraph(model, paragraph, { lineHeight: 2 })).toBe(false);
    expect(canFormatSourceParagraph(model, paragraph, { lineSpacing: 100 })).toBe(false);
    expect(canFormatSourceParagraph(model, paragraph, { firstLineIndent: 1000 })).toBe(false);
    expect(canFormatSourceParagraph(model, paragraph, { firstLineIndent: -1000 })).toBe(false);
    const short = { ...model, heightPt: 95 };
    expect(canFormatSourceParagraph(short, detectParagraph(short, 'a')!, { lineHeight: 1.9 })).toBe(false);
  });
  it('renders TJ spaces and maps cross-block edits without counting seed gaps twice', () => {
    const a = text('a', 30, 40, 0, 'Intro'), b = text('b', 30, 68, 1, 'AlphaBeta'), c = text('c', 30, 96, 2, 'GammaDelta');
    b.textBlock!.inferredSpaces = [5]; c.textBlock!.inferredSpaces = [5];
    const model = page([a, b, c]), paragraph = detectParagraph(model, 'a')!;
    expect(paragraph.text).toBe('Intro Alpha Beta Gamma Delta');
    const target = (object: EditableObject, range: [number, number], logicalRange?: [number, number]): TextSelectionTarget => ({
      objectId: object.id, blockId: object.textBlock!.id, range, ...(logicalRange ? { logicalRange } : {}), text: '', rects: [],
    });
    const selection = paragraphEditRange(paragraph, [target(b, [5, 9], [6, 10]), target(c, [0, 5], [0, 5])])!;
    expect(selection).toEqual([6, 16]);
    const inputRange = paragraphInputRange(b.textBlock!, selection, paragraph.sourceRanges.b![0], true);
    expect(inputRange).toEqual([12, 22]);
    expect(paragraph.text.slice(...inputRange)).toBe('Beta Gamma');
    for (const caret of [5, 6]) {
      const selected = paragraphEditRange(paragraph, [target(b, [5, 5], [caret, caret])])!;
      expect(paragraphInputRange(b.textBlock!, selected, paragraph.sourceRanges.b![0], true)).toEqual([6 + caret, 6 + caret]);
    }
    const gap = paragraphEditRange(paragraph, [target(b, [5, 5], [5, 6])])!;
    expect(paragraphInputRange(b.textBlock!, gap, paragraph.sourceRanges.b![0], true)).toEqual([11, 12]);
    expect(paragraph.text.slice(...paragraphInputRange(b.textBlock!, gap, 6, true))).toBe(' ');
    expect(logicalTextRange(b.textBlock!, [0, 5])).toEqual([0, 5]);
    expect(paragraphInputRange(b.textBlock!, [5, 9], 6)).toEqual([12, 16]);
    expect(sourceTextOffset(b.textBlock!, 6)).toBe(5);
    expect(sourceTextOffset(b.textBlock!, 10)).toBe(9);
    const shown = { page: model, info: { revision: 0, permissions: { modify: true }, capabilities: ['text.replace'] } } as Parameters<typeof PdfTextLayer>[0]['document'];
    const markup = renderToStaticMarkup(createElement(PdfTextLayer, { document: shown, zoom: 1, disabled: false,
      onEdit() {}, onInsert() {}, onAnnotate: async () => {}, onError() {} }));
    expect(markup).toContain('Alpha Beta');
    expect(markup).toContain('Gamma Delta');
  });
  it('uses visible font metrics when materializing uniformly scaled source text', () => {
    const a = text('a', 30, 40, 0), b = text('b', 30, 68, 1);
    for (const item of [a, b]) { item.transform = [2, 0, 0, -2, 30, item.bounds.y]; item.textBlock!.runs[0]!.style.fontSize = 10; }
    const result = detectParagraph(page([a, b]), 'a')!;
    expect(result.style.fontSize).toBe(20);
    expect(result.style.characterSpacing).toBe(4);
    expect(result.lineHeight).toBe(1.4);
    expect(a.textBlock!.runs[0]!.style.fontSize).toBe(10);
    const stretched = { ...a, transform: [3, 0, 0, -2, 30, 40] as [number, number, number, number, number, number] };
    expect(detectParagraph(page([stretched, b]), 'a', true)).toBeNull();
  });
  it('preserves exact loaded faces and infers missing bold/italic metadata from PDF names', () => {
    const fonts = [{ id: 'regular', family: 'Liberation Sans', style: 'Regular', weight: 400, italic: false, format: 'ttf' as const },
      { id: 'bold-italic', family: 'Liberation Sans', style: 'Bold Italic', weight: 700, italic: true, format: 'ttf' as const },
      { id: 'imported', family: 'Liberation Sans', style: 'Regular', weight: 400, italic: false, format: 'ttf' as const }];
    expect(resolveParagraphRunFont({ text: 'word', style: { fontId: 'pdf:Helvetica-BoldOblique' }, sourceObjectIds: [] }, fonts)).toBe('bold-italic');
    expect(resolveParagraphRunFont({ text: 'word', style: { fontId: 'imported' }, sourceObjectIds: [] }, fonts)).toBe('imported');
  });
  it('removes parent/child double selection after additive selection too', () => {
    const parent = { ...object('parent', 0, 0, 200, 200), type: 'form' as const }, child = object('child', 20, 20, 20, 20);
    child.locator.containerPath = [0];
    expect(normalizeSelection(page([parent, child]), ['child', 'parent'])).toEqual(['parent']);
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
