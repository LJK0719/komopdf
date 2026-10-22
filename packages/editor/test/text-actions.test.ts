import { describe, expect, it } from 'vitest';
import type { DocumentInfo, EditableObject } from '@pdf-editor/contracts';
import { selectionMaterial, splitTextActionTargets, textActionSelection, textActionTarget } from '../src/ui/text-actions.js';

const document: DocumentInfo = { id: 'doc', revision: 3, savedRevision: 1, pageOrder: ['p1', 'p2'], sourceIds: ['s1'],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false }, capabilities: ['text.replace'] };
function object(value = 'Hello world'): EditableObject {
  return { id: 'object', pageId: 'p1', type: 'text', locator: { pageId: 'p1', containerPath: [], objectIndex: 0 },
    bounds: { x: 10, y: 20, width: 100, height: 12 }, transform: [1, 0, 0, 1, 0, 0],
    textBlock: { id: 'block', pageId: 'p1', sourceId: 's1', sourceObjectIds: ['object'], runs: [{ text: value, style: { fontSize: 12 }, sourceObjectIds: ['object'] }],
      bounds: { x: 10, y: 20, width: 100, height: 12 }, transform: [1, 0, 0, 1, 0, 0], editability: 'direct' } };
}
describe('text action selection snapshots', () => {
  it('keeps the selected UTF-16 range and complete source without replacing the whole object', () => {
    const target = textActionTarget(object('A😀B'), 1, [1, 3])!;
    expect(target.text).toBe('😀'); expect(target.blockText).toBe('A😀B'); expect(target.range).toEqual([1, 3]);
    const selection = textActionSelection(document, 'paper.pdf', [target]);
    expect(selection).toMatchObject({ documentId: 'doc', revision: 3, action: 'translate' });
  });
  it('preserves reading whitespace separately from native offsets', () => {
    const target = textActionTarget(object('HelloWorld'), 1, [0, 10], 'Hello World')!;
    expect(target.text).toBe('Hello World'); expect(target.blockText).toBe('HelloWorld'); expect(target.range).toEqual([0, 10]);
  });
  it('splits long selections without losing text or splitting surrogate pairs', () => {
    const original = 'A😀B '.repeat(3000) + 'Done.';
    const target = textActionTarget(object(original), 1)!;
    const chunks = splitTextActionTargets([target], 400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(item => item.text).join('')).toBe(original);
    for (const chunk of chunks) { expect(chunk.text.length).toBeLessThanOrEqual(400); expect(chunk.text.isWellFormed()).toBe(true); }
  });
  it('keeps every page in the handoff and distinguishes generated text from the original', () => {
    const first = textActionTarget(object(), 1)!;
    const second = { ...textActionTarget(object('Second page'), 2)!, pageId: 'p2' };
    const material = selectionMaterial(textActionSelection(document, 'paper.pdf', [first, second]), '译文', { sourceLanguage: 'en', targetLanguage: 'zh' });
    expect(material.text).toBe('Hello world\n\nSecond page'); expect(material.generatedText).toBe('译文');
    expect(material.locations.map(item => item.pageNumber)).toEqual([1, 2]);
    expect(material.kind).toBe('selection');
  });
  it('does not invent original-PDF character citations for a modified draft', () => {
    const selection = textActionSelection(document, 'paper.pdf', [textActionTarget(object('Edited draft'), 1)!]);
    selection.draft = { current: () => true, replace: () => true };
    const material = selectionMaterial(selection, 'Result');
    expect(material.kind).toBe('text'); expect(material.locations[0]).not.toHaveProperty('range');
    expect(material.locations[0]).not.toHaveProperty('blockId'); expect(material.text).toBe('Edited draft');
  });
});
