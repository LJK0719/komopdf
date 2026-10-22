import { describe, expect, it, vi } from 'vitest';
import type { DocumentInfo, EditableObject, EngineAdapter, PageModel } from '@pdf-editor/contracts';
import { selectionMaterial, selectionUnits, textActionSelection, textActionTarget, textActionUnits } from '../src/ui/text-actions.js';
import { prepareTextActionApplication } from '../src/ui/text-action-application.js';

const document: DocumentInfo = { id: 'doc', revision: 2, savedRevision: 0, pageOrder: ['p1'], sourceIds: ['source'],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false }, capabilities: ['text.replace', 'text.reflow'] };
function glyphPage(text: string): PageModel {
  const objects: EditableObject[] = Array.from(text, (char, index) => {
    const id = `glyph-${index}`, bounds = { x: 20 + index * 12, y: 30, width: 12, height: 12 };
    return { id, pageId: 'p1', type: 'text', bounds, transform: [1, 0, 0, 1, bounds.x, bounds.y], locator: { pageId: 'p1', containerPath: [], objectIndex: index },
      textBlock: { id: `${id}:text`, pageId: 'p1', sourceId: 'source', sourceObjectIds: [id], bounds, transform: [1, 0, 0, 1, bounds.x, bounds.y], editability: 'direct',
        runs: [{ text: char, style: { fontSize: 12, fontId: 'Helvetica' }, sourceObjectIds: [id] }],
        characters: [{ range: [0, char.length], bounds, angle: 0, rtl: false }] } };
  });
  return { id: 'p1', widthPt: 612, heightPt: 792, rotation: 0, objects };
}
function targets(page: PageModel) { return page.objects.flatMap(object => { const target = textActionTarget(object, 1); return target ? [target] : []; }); }

describe('semantic AI text units', () => {
  it('combines a Chinese sentence stored as individual glyphs without character requests or newlines', () => {
    const page = glyphPage('这是完整的一句话。');
    const selected = targets(page);
    const units = textActionUnits(page, selected);
    expect(units).toHaveLength(1);
    expect(units[0]?.text).toBe('这是完整的一句话。');
    expect(units[0]?.targetIds).toEqual(selected.map(target => target.id));
    const selection = textActionSelection(document, 'source.pdf', selected, 'translate', [page]);
    expect(selectionUnits(selection)).toEqual(units);
    expect(selectionMaterial(selection).text).toBe('这是完整的一句话。');
    expect(selectionMaterial(selection).locations).toHaveLength(selected.length);
  });
  it('does not include unselected words or join disjoint ranges', () => {
    const page = glyphPage('ABCD');
    const selected = targets(page).filter((_, index) => index === 0 || index === 3);
    expect(textActionUnits(page, selected).map(unit => unit.text)).toEqual(['A', 'D']);
  });
  it('keeps real English word gaps without putting one newline between each object', () => {
    const page = glyphPage('Hello world.');
    expect(textActionUnits(page, targets(page)).map(unit => unit.text).join('\n\n')).toBe('Hello world.');
  });
  it('converts one source paragraph and replaces a multi-glyph selection exactly once', async () => {
    const page = glyphPage('ABCDE');
    const selected = targets(page).slice(1, 4);
    const units = textActionUnits(page, selected);
    const engine = { describePage: vi.fn(async () => page), previewTransaction: vi.fn(async () => ({ pageOrder: ['p1'] })), previewText: vi.fn() } as unknown as EngineAdapter;
    const result = await prepareTextActionApplication({ engine, document, targets: selected, units, texts: { [units[0]!.id]: 'Translated' }, style: {} });
    const commands = result.transaction!.commands;
    expect(commands.filter(command => command.type === 'text.reflow')).toHaveLength(1);
    const replace = commands.filter(command => command.type === 'text.replace');
    expect(replace).toHaveLength(1);
    expect(replace[0]).toMatchObject({ text: 'Translated', range: [1, 4] });
    expect(engine.previewText).not.toHaveBeenCalled();
    expect(engine.previewTransaction).toHaveBeenCalledOnce();
  });
});
