import { describe, expect, it } from 'vitest';
import type { DocumentInfo, EditCommand, EditTransaction, FormFieldInfo, PageModel } from '@pdf-editor/contracts';
import { buildCommandImpactPreview } from '../src/ui/AiCommandPreview.js';

const document: DocumentInfo = {
  id: 'doc', revision: 7, savedRevision: 7, pageOrder: ['p1', 'p2'], sourceIds: ['source'],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false },
  capabilities: ['objects.transform', 'text.replace', 'pages.crop', 'pages.reorder', 'pages.delete', 'form.fill', 'objects.group'],
};
const page: PageModel = {
  id: 'p1', widthPt: 600, heightPt: 800, rotation: 90, objects: [{
    id: 'obj', pageId: 'p1', type: 'text', bounds: { x: 10, y: 20, width: 40, height: 12 },
    transform: [2, 0, 0, 2, 10, 5], locator: { pageId: 'p1', containerPath: [], objectIndex: 0 },
    textBlock: {
      id: 'block', pageId: 'p1', sourceObjectIds: ['obj'], bounds: { x: 10, y: 20, width: 40, height: 12 },
      transform: [2, 0, 0, 2, 10, 5], editability: 'direct',
      runs: [{ text: 'A😀B', style: { fontId: 'font1', fontSize: 12 }, sourceObjectIds: ['obj'] }],
    },
  }],
};
const pages = new Map([['p1', page]]);
const transaction = (commands: EditCommand[]): EditTransaction => ({
  id: 'tx', docId: 'doc', baseRevision: 7, source: 'ai', commands,
});

function preview(commands: EditCommand[], pageOrder = ['p1', 'p2']) {
  return buildCommandImpactPreview(transaction(commands), document, pages,
    { docId: 'doc', baseRevision: 7, pageOrder, changedPageIds: ['p1'] });
}

describe('AI command plan structural preview', () => {
  it('shows complete before/after text using UTF-16 replacement ranges', () => {
    const result = preview([{ type: 'text.replace', pageId: 'p1', blockId: 'block', range: [1, 3], text: 'ok' }]);
    expect(result.commands[0]?.changes[0]).toMatchObject({ before: 'A😀B', after: 'AokB' });
    expect(result.requiresManualConfirmation).toBe(false);
  });

  it('shows before/after styles for a whole single-run block and rotations across commands', () => {
    const result = preview([
      { type: 'text.style', pageId: 'p1', blockIds: ['block'], style: { fontSize: 16 } },
      { type: 'pages.rotate', pageIds: ['p1'], degrees: 90 },
      { type: 'pages.rotate', pageIds: ['p1'], degrees: 180 },
    ]);
    expect(result.commands[0]?.changes[0]).toMatchObject({
      before: '{"fontId":"font1","fontSize":12}', after: '{"fontId":"font1","fontSize":16}',
    });
    expect(result.commands[1]?.changes[0]).toMatchObject({ before: '90°', after: '180°' });
    expect(result.commands[2]?.changes[0]).toMatchObject({ before: '180°', after: '0°' });
  });

  it('composes object matrices across two commands instead of presenting the requested delta as a final matrix', () => {
    const result = preview([
      { type: 'objects.transform', pageId: 'p1', objectIds: ['obj'], matrix: [1, 0, 0, 1, 3, -2] },
      { type: 'objects.transform', pageId: 'p1', objectIds: ['obj'], matrix: [1, 0, 0, 1, 1, 1] },
    ]);
    expect(result.commands[0]?.changes[0]).toMatchObject({ before: '[2, 0, 0, 2, 10, 5]', after: '[2, 0, 0, 2, 13, 3]' });
    expect(result.commands[1]?.changes[0]).toMatchObject({ before: '[2, 0, 0, 2, 13, 3]', after: '[2, 0, 0, 2, 14, 4]' });
    expect(result.requiresManualConfirmation).toBe(false);
  });

  it('uses the engine page order and reports crop boundaries as unknown, never inventing a rendered crop', () => {
    const result = preview([
      { type: 'pages.reorder', pageIds: ['p2', 'p1'] },
      { type: 'pages.crop', pageIds: ['p1'], bounds: { x: 10, y: 20, width: 300, height: 400 } },
    ], ['p2', 'p1']);
    expect(result.beforeOrder).toEqual(['p1', 'p2']);
    expect(result.afterOrder).toEqual(['p2', 'p1']);
    expect(result.affectedPages).toEqual(['p1']);
    expect(result.commands[1]?.changes[0]).toMatchObject({ manual: true });
    expect(result.commands[1]?.changes[0]?.before).toContain('current crop not exposed');
    expect(result.requiresManualConfirmation).toBe(true);
  });

  it('shows actual form values and flags missing current values for manual confirmation', () => {
    const fields: FormFieldInfo[] = [{
      id: 'field', name: 'Full name', type: 'text', value: 'Alice', readOnly: false, required: false,
      options: [], widgets: [{ pageId: 'p1', bounds: { x: 0, y: 0, width: 10, height: 10 } }],
    }];
    const cmd: EditCommand = { type: 'form.fill', fieldId: 'field', value: 'Bob' };
    const engineResult = { docId: 'doc', baseRevision: 7, pageOrder: document.pageOrder, changedPageIds: ['p1'] };
    const known = buildCommandImpactPreview(transaction([cmd]), document, pages, engineResult, fields);
    expect(known.commands[0]?.changes[0]).toMatchObject({ before: '"Alice"', after: '"Bob"' });
    expect(known.requiresManualConfirmation).toBe(false);
    const missing = buildCommandImpactPreview(transaction([cmd]), document, pages, engineResult);
    expect(missing.commands[0]?.changes[0]).toMatchObject({ manual: true });
  });

  it('marks group and unknown structural effects for explicit review', () => {
    const result = preview([{ type: 'objects.group', pageId: 'p1', objectIds: ['obj', 'obj2'], groupId: 'group1' }]);
    expect(result.commands[0]?.changes[0]).toMatchObject({ manual: true });
    expect(result.requiresManualConfirmation).toBe(true);
  });
});
