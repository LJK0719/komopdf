import { describe, expect, it } from 'vitest';
import type { AiRequest, AiResponseEnvelope, AiResult, DocumentInfo, PageModel } from '@pdf-editor/contracts';
import { createAiTransaction, type CommandContext } from '../src/index.js';

const document: DocumentInfo = {
  id: 'doc', revision: 2, savedRevision: 2, pageOrder: ['p1', 'p2', 'p3'], sourceIds: ['source'],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false },
  capabilities: ['text.insert'],
};
const pages: PageModel[] = [
  { id: 'p1', widthPt: 612, heightPt: 792, rotation: 0, objects: [] },
  { id: 'p2', widthPt: 595, heightPt: 842, rotation: 0, objects: [] },
  { id: 'p3', widthPt: 300, heightPt: 500, rotation: 0, objects: [] },
];
const context: CommandContext = { document, pages: new Map(pages.map(page => [page.id, page])),
  fontIds: new Set(['font-body']) };
const request: AiRequest = {
  protocolVersion: 1, requestId: 'req', feature: 'commands.plan', document: { id: 'doc', revision: 2 },
  context: { scope: 'pages', evidence: [], pages: pages.map((page, index) => ({ id: page.id, pageNumber: index + 1 })),
    availableCommands: ['pages.decorate'], availableFontIds: ['font-body'] },
  instruction: '给第1页与第3页加页码 Page {page}，页眉 Project Q3，页脚 End of report，水印 Confidential', options: {},
};
type Proposals = Extract<AiResult, { kind: 'commandPlan' }>['commands'];
function build(commands: Proposals, input = request, ctx = context, fontId: string | undefined = 'font-body') {
  const response: AiResponseEnvelope = { protocolVersion: 1, requestId: 'req', feature: 'commands.plan',
    document: { id: 'doc', baseRevision: 2 }, result: { kind: 'commandPlan', explanation: 'Decorate pages', commands } };
  return createAiTransaction(input, response, ctx, 'tx-ai-decorations', fontId);
}

describe('AI page range decorations', () => {
  it('expands selected pages into one atomic transaction with local absolute page numbers and distinct IDs', () => {
    const untrusted: AiRequest = { ...request, context: { ...request.context,
      pages: request.context.pages!.map(page => page.id === 'p3' ? { ...page, pageNumber: 99 } : page) } };
    const transaction = build([{ type: 'pages.decorate', pageIds: ['p1', 'p3'], decoration: 'number' }], untrusted);
    expect(transaction).toMatchObject({ id: 'tx-ai-decorations', source: 'ai', docId: 'doc', baseRevision: 2 });
    expect(transaction.commands).toHaveLength(2);
    expect(transaction.commands.map(command => command.type === 'text.insert'
      ? [command.type, command.pageId, command.text] : [command.type, null, null])).toEqual([
      ['text.insert', 'p1', '1'], ['text.insert', 'p3', '3'],
    ]);
    const [first, third] = transaction.commands;
    expect(first).toMatchObject({ bounds: { x: 36, y: 708, width: 540, height: 48 },
      style: { fontId: 'font-body', fontSize: 12, alignment: 'right', color: [0, 0, 0] }, paragraph: true });
    expect(third).toMatchObject({ bounds: { x: 24, y: 428, width: 252, height: 48 } });
    if (first?.type !== 'text.insert' || third?.type !== 'text.insert') throw new Error('Expected text.insert');
    expect(first.objectId).not.toBe(third.objectId);
  });

  it('preserves exact supplied text while replacing page tokens locally and uses light watermark color', () => {
    const transaction = build([
      { type: 'pages.decorate', pageIds: ['p1', 'p3'], decoration: 'number', text: 'Page {page}' },
      { type: 'pages.decorate', pageIds: ['p3'], decoration: 'header', text: 'Project Q3' },
      { type: 'pages.decorate', pageIds: ['p3'], decoration: 'footer', text: 'End of report' },
      { type: 'pages.decorate', pageIds: ['p3'], decoration: 'watermark', text: 'Confidential' },
    ]);
    expect(transaction.commands.map(command => command.type === 'text.insert' ? command.text : null))
      .toEqual(['Page 1', 'Page 3', 'Project Q3', 'End of report', 'Confidential']);
    expect(transaction.commands[2]).toMatchObject({ bounds: { x: 24, y: 24, width: 252, height: 48 } });
    expect(transaction.commands[3]).toMatchObject({ bounds: { x: 24, y: 428, width: 252, height: 48 } });
    expect(transaction.commands[4]).toMatchObject({ bounds: { x: 24, y: 226, width: 252, height: 48 },
      style: { color: [0.65, 0.65, 0.65], alignment: 'center' } });
  });

  it('fails if any target page is missing; it never borrows another page size', () => {
    const missing = { ...context, pages: new Map([['p1', pages[0]!]]) };
    expect(() => build([{ type: 'pages.decorate', pageIds: ['p1', 'p3'], decoration: 'number' }], request, missing))
      .toThrow('Load every target page before preparing page decorations');
    const narrowed: AiRequest = { ...request, context: { ...request.context,
      pages: [{ id: 'p1', pageNumber: 1 }] } };
    expect(() => build([{ type: 'pages.decorate', pageIds: ['p3'], decoration: 'number' }], narrowed))
      .toThrow('Decoration page is outside request scope');
  });

  it('rejects invented text, unregistered fonts and unsupported native insert capability', () => {
    expect(() => build([{ type: 'pages.decorate', pageIds: ['p1'], decoration: 'watermark', text: 'Invented' }]))
      .toThrow(/verbatim/);
    expect(() => build([{ type: 'pages.decorate', pageIds: ['p1'], decoration: 'footer' }]))
      .toThrow(/text is required/);
    expect(() => build([{ type: 'pages.decorate', pageIds: ['p1'], decoration: 'number' }], request, context, ''))
      .toThrow(/registered, editable font/);
    expect(() => build([{ type: 'pages.decorate', pageIds: ['p1'], decoration: 'number' }], request, context, 'unlisted-font'))
      .toThrow(/registered, editable font/);
    expect(() => build([{ type: 'pages.decorate', pageIds: ['p1'], decoration: 'number' }], request,
      { ...context, document: { ...document, capabilities: [] } }))
      .toThrow(/Current engine does not support/);
  });
});
