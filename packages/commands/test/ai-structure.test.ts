import { describe, expect, it } from 'vitest';
import type { AiRequest, AiResponseEnvelope, AiResult, DocumentInfo, PageModel } from '@pdf-editor/contracts';
import { createAiTransaction, type CommandContext } from '../src/index.js';

const page: PageModel = {
  id: 'p1', widthPt: 612, heightPt: 792, rotation: 0,
  objects: [
    { id: 'o1', pageId: 'p1', type: 'image', bounds: { x: 20, y: 30, width: 50, height: 50 },
      transform: [1, 0, 0, 1, 0, 0], locator: { pageId: 'p1', containerPath: [], objectIndex: 0 } },
    { id: 'o2', pageId: 'p1', type: 'path', bounds: { x: 100, y: 30, width: 50, height: 50 },
      transform: [1, 0, 0, 1, 0, 0], locator: { pageId: 'p1', containerPath: [], objectIndex: 1 } },
  ],
};
const document: DocumentInfo = {
  id: 'doc', revision: 1, savedRevision: 1, pageOrder: ['p1', 'p2'], sourceIds: ['source'],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false },
  capabilities: ['pages.insert', 'pages.duplicate', 'objects.copy', 'objects.group', 'objects.ungroup'],
};
const context: CommandContext = { document, pages: new Map([['p1', page]]) };
const request: AiRequest = {
  protocolVersion: 1, requestId: 'request', feature: 'commands.plan', document: { id: 'doc', revision: 1 },
  context: { scope: 'pages', evidence: [], pages: [{ id: 'p1', pageNumber: 1 }, { id: 'p2', pageNumber: 2 }],
    objects: [{ id: 'o1', pageId: 'p1', type: 'image' }, { id: 'o2', pageId: 'p1', type: 'path' }],
    availableCommands: ['pages.insert', 'pages.duplicate', 'objects.copy', 'objects.group', 'objects.ungroup'] },
  instruction: 'Edit pages and objects', options: {},
};
type PlanCommands = Extract<AiResult, { kind: 'commandPlan' }>['commands'];
function transaction(commands: PlanCommands, input = request, ctx = context) {
  const response: AiResponseEnvelope = { protocolVersion: 1, requestId: 'request', feature: 'commands.plan',
    document: { id: 'doc', baseRevision: 1 }, result: { kind: 'commandPlan', commands, explanation: 'Edit' } };
  return createAiTransaction(input, response, ctx, 'tx');
}

describe('AI page and object structure plans', () => {
  it('derives blank page geometry and before/after anchors locally instead of accepting model IDs', () => {
    const before = transaction([{ type: 'pages.insert', referencePageId: 'p1', position: 'before' }]).commands[0]!;
    const after = transaction([{ type: 'pages.insert', referencePageId: 'p1', position: 'after' }]).commands[0]!;
    expect(before).toMatchObject({ type: 'pages.insert', afterPageId: null, widthPt: 612, heightPt: 792 });
    expect(after).toMatchObject({ type: 'pages.insert', afterPageId: 'p1', widthPt: 612, heightPt: 792 });
    if (before.type !== 'pages.insert' || after.type !== 'pages.insert') throw new Error('Expected insert commands');
    expect(before.pageId).not.toBe('p1');
    expect(after.pageId).not.toBe(before.pageId);
  });

  it('requires the reference page to be loaded; never guesses a different page size', () => {
    expect(() => transaction([{ type: 'pages.insert', referencePageId: 'p2', position: 'after' }]))
      .toThrow('Navigate to the reference page before inserting a blank page');
    const narrowed: AiRequest = { ...request, context: { ...request.context, pages: [{ id: 'p1', pageNumber: 1 }] } };
    expect(() => transaction([{ type: 'pages.insert', referencePageId: 'p2', position: 'after' }], narrowed))
      .toThrow('Page insertion reference is outside request scope');
  });

  it('creates a distinct new page ID for each source and validates the destination scope', () => {
    const command = transaction([{ type: 'pages.duplicate', pageIds: ['p1', 'p2'], afterPageId: 'p2' }]).commands[0]!;
    expect(command).toMatchObject({ type: 'pages.duplicate', pageIds: ['p1', 'p2'], afterPageId: 'p2' });
    if (command.type !== 'pages.duplicate') throw new Error('Expected duplicate command');
    expect(new Set(command.newPageIds).size).toBe(2);
    expect(command.newPageIds).not.toContain('p1');
    expect(command.newPageIds).not.toContain('p2');
    expect(() => transaction([{ type: 'pages.duplicate', pageIds: ['p1'], afterPageId: 'foreign' }]))
      .toThrow('Candidate insertion position is outside request scope');
  });

  it('generates copied object IDs locally and defaults to a small offset when omitted', () => {
    const command = transaction([{ type: 'objects.copy', pageId: 'p1', objectIds: ['o1', 'o2'] }]).commands[0]!;
    expect(command).toMatchObject({ type: 'objects.copy', offset: { x: 12, y: 12 }, objectIds: ['o1', 'o2'] });
    if (command.type !== 'objects.copy') throw new Error('Expected copy command');
    expect(new Set(command.newObjectIds).size).toBe(2);
    expect(command.newObjectIds).not.toContain('o1');
    expect(command.newObjectIds).not.toContain('o2');
    expect(transaction([{ type: 'objects.copy', pageId: 'p1', objectIds: ['o1'], offset: { x: 4, y: -6 } }]).commands[0])
      .toMatchObject({ offset: { x: 4, y: -6 } });
    expect(() => transaction([{ type: 'objects.copy', pageId: 'p1', objectIds: ['foreign'] }]))
      .toThrow('Candidate object is outside request scope');
  });

  it('groups only adjacent top-level objects in the loaded PDF and generates group ID locally', () => {
    const command = transaction([{ type: 'objects.group', pageId: 'p1', objectIds: ['o2', 'o1'] }]).commands[0]!;
    expect(command).toMatchObject({ type: 'objects.group', pageId: 'p1', objectIds: ['o2', 'o1'] });
    if (command.type !== 'objects.group') throw new Error('Expected group command');
    expect(command.groupId).not.toBe('o1');
    expect(command.groupId).not.toBe('o2');

    const gap = { ...page, objects: [page.objects[0]!, { ...page.objects[1]!,
      locator: { pageId: 'p1', containerPath: [], objectIndex: 2 } }] };
    expect(() => transaction([{ type: 'objects.group', pageId: 'p1', objectIds: ['o1', 'o2'] }], request,
      { ...context, pages: new Map([['p1', gap]]) })).toThrow(/adjacent objects/);
    const nested = { ...page, objects: [page.objects[0]!, { ...page.objects[1]!,
      locator: { pageId: 'p1', containerPath: [0], objectIndex: 1 } }] };
    expect(() => transaction([{ type: 'objects.group', pageId: 'p1', objectIds: ['o1', 'o2'] }], request,
      { ...context, pages: new Map([['p1', nested]]) })).toThrow(/top-level/);
    expect(() => transaction([{ type: 'objects.group', pageId: 'p1', objectIds: ['o1', 'foreign'] }]))
      .toThrow(/current PDF/);
    const narrowed: AiRequest = { ...request, context: { ...request.context,
      objects: [{ id: 'o1', pageId: 'p1', type: 'image' }] } };
    expect(() => transaction([{ type: 'objects.group', pageId: 'p1', objectIds: ['o1', 'o2'] }], narrowed))
      .toThrow('Candidate object is outside request scope');
  });

  it('ungroups only an existing selected top-level PDF group', () => {
    const group = { ...page.objects[1]!, id: 'group-1', type: 'group' as const };
    const groupedContext: CommandContext = { ...context,
      pages: new Map([['p1', { ...page, objects: [...page.objects, group] }]]) };
    const scoped: AiRequest = { ...request, context: { ...request.context,
      objects: [...request.context.objects!, { id: 'group-1', pageId: 'p1', type: 'group' }] } };
    expect(transaction([{ type: 'objects.ungroup', pageId: 'p1', groupId: 'group-1' }], scoped,
      groupedContext).commands[0]).toEqual({ type: 'objects.ungroup', pageId: 'p1', groupId: 'group-1' });
    expect(() => transaction([{ type: 'objects.ungroup', pageId: 'p1', groupId: 'group-1' }]))
      .toThrow(/current PDF/);
    expect(() => transaction([{ type: 'objects.ungroup', pageId: 'p1', groupId: 'o1' }]))
      .toThrow(/top-level group/);
    expect(() => transaction([{ type: 'objects.ungroup', pageId: 'p1', groupId: 'group-1' }], request, groupedContext))
      .toThrow('Candidate group is outside request scope');
    const nestedGroup = { ...group, locator: { ...group.locator, containerPath: [0] } };
    expect(() => transaction([{ type: 'objects.ungroup', pageId: 'p1', groupId: 'group-1' }], scoped,
      { ...context, pages: new Map([['p1', { ...page, objects: [...page.objects, nestedGroup] }]]) }))
      .toThrow(/top-level group/);
  });

  it('keeps actual engine capability and permission gates before preview', () => {
    const disabled = { ...context, document: { ...document, capabilities: ['pages.insert'] as DocumentInfo['capabilities'] } };
    expect(() => transaction([{ type: 'objects.copy', pageId: 'p1', objectIds: ['o1'] }], request, disabled))
      .toThrow(/Current engine does not support/);
    const forbidden = { ...context, document: { ...document, permissions: { ...document.permissions, modify: false } } };
    expect(() => transaction([{ type: 'pages.insert', referencePageId: 'p1', position: 'after' }], request, forbidden))
      .toThrow(/not permitted/);
  });
});
