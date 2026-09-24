import { describe, expect, it } from 'vitest';
import type { AiRequest, AiResponseEnvelope, DocumentInfo, EditableObject, PageModel } from '@pdf-editor/contracts';
import { createAiTransaction, type CommandContext } from '../src/index.js';

function context(secondIndex = 1, firstFont?: string): CommandContext {
  const objects: EditableObject[] = ['First line', 'Second line'].map((text, index) => ({
    id: `obj-${index}`, pageId: 'p1', type: 'text' as const,
    bounds: { x: 20, y: 30 + index * 18, width: 130, height: 18 },
    transform: [1, 0, 0, 1, 0, 0],
    locator: { pageId: 'p1', containerPath: [], objectIndex: index ? secondIndex : 0 },
    textBlock: { id: `block-${index}`, pageId: 'p1', sourceObjectIds: [`obj-${index}`],
      runs: [{ text, style: { ...(firstFont ? { fontId: firstFont } : {}), fontSize: 12 }, sourceObjectIds: [`obj-${index}`] }],
      bounds: { x: 20, y: 30 + index * 18, width: 130, height: 18 },
      transform: [1, 0, 0, 1, 0, 0], editability: 'direct' },
  }));
  const page: PageModel = { id: 'p1', widthPt: 595, heightPt: 842, rotation: 0, objects };
  const document = { id: 'doc', revision: 1, savedRevision: 1, pageOrder: ['p1'], sourceIds: ['source'],
    permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false },
    capabilities: ['text.reflow'] } as DocumentInfo;
  return { document, pages: new Map([['p1', page]]), fontIds: new Set(['font-body']) };
}

const request: AiRequest = { protocolVersion: 1, requestId: 'req', feature: 'blocks.organize',
  document: { id: 'doc', revision: 1 },
  context: { scope: 'selection', evidence: [], availableCommands: ['text.reflow'],
    availableFontIds: ['font-body'], objects: [
      { id: 'obj-0', pageId: 'p1', type: 'text', blockId: 'block-0' },
      { id: 'obj-1', pageId: 'p1', type: 'text', blockId: 'block-1' },
    ] }, instruction: 'Combine two adjacent lines', options: {} };

function proposal(blockIds: string[]): AiResponseEnvelope {
  return { protocolVersion: 1, requestId: 'req', document: { id: 'doc', baseRevision: 1 },
    feature: 'blocks.organize', result: { kind: 'commandPlan', explanation: 'Merge into one paragraph',
      commands: [{ type: 'text.reflow', pageId: 'p1', blockIds }] } };
}

describe('AI proposed text block merge', () => {
  it('builds actual paragraph text, geometry and font from the current PDF instead of model guesses', () => {
    const transaction = createAiTransaction(request, proposal(['block-1', 'block-0']), context(1, 'font-body'), 'tx');
    expect(transaction.commands[0]).toMatchObject({ type: 'text.reflow', pageId: 'p1',
      blockIds: ['block-1', 'block-0'], text: 'Second line\nFirst line',
      bounds: { x: 20, y: 30, width: 130, height: 36 }, style: { fontId: 'font-body', fontSize: 12 } });
  });

  it('requires explicit font selection when the source font is not registered', () => {
    expect(() => createAiTransaction(request, proposal(['block-0', 'block-1']), context(), 'tx'))
      .toThrow('Select a registered, editable font');
    expect(createAiTransaction(request, proposal(['block-0', 'block-1']), context(), 'tx', 'font-body').commands[0])
      .toMatchObject({ type: 'text.reflow', style: { fontId: 'font-body' } });
  });

  it('rejects blocks outside selection and nonadjacent source objects', () => {
    expect(() => createAiTransaction(request, proposal(['block-0', 'block-foreign']), context(1, 'font-body'), 'tx'))
      .toThrow('Paragraph merge requires editable top-level text blocks');
    expect(() => createAiTransaction(request, proposal(['block-0', 'block-1']), context(2, 'font-body'), 'tx'))
      .toThrow('requires adjacent text objects');
  });
});
