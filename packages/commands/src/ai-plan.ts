import { aiRequestSchema, aiResponseEnvelopeSchema, EngineError, assertTextRange,
  type AiRequest, type AiResponseEnvelope, type EditCommand, type EditTransaction, type EvidenceBlock } from '@pdf-editor/contracts';
import { validateTransaction, type CommandContext } from './registry.js';

function reject(message: string): never { throw new EngineError('INVALID_REQUEST', message); }
function replacement(evidenceId: string, text: string, request: AiRequest, context: CommandContext): EditCommand {
  const evidence = request.context.evidence.find(item => item.id === evidenceId);
  if (!evidence) reject('Candidate references evidence outside the request');
  const range = evidence.characterRange ?? [0, evidence.text.length];
  const block = context.pages.get(evidence.pageId)?.objects.find(object => object.textBlock?.id === evidence.blockId)?.textBlock;
  if (!block || block.runs.map(run => run.text).join('').slice(...range) !== evidence.text) reject('Target text does not match request snapshot');
  return { type: 'text.replace', pageId: evidence.pageId, blockId: evidence.blockId, range: [range[0]!, range[1]!], text };
}
function mergeTextBlocks(command: { pageId: string; blockIds: string[] }, context: CommandContext, preferredFontId?: string): EditCommand {
  const page = context.pages.get(command.pageId);
  if (!page) reject('Paragraph source page is unavailable');
  const objects = command.blockIds.map(id => page.objects.find(object => object.textBlock?.id === id));
  if (objects.some(object => !object || object.type !== 'text' || object.locator.containerPath.length ||
      object.textBlock?.editability === 'geometry-only')) reject('Paragraph merge requires editable top-level text blocks');
  const sources = objects.map(object => object!);
  const positions = sources.map(object => object.locator.objectIndex).sort((a, b) => a - b);
  if (positions.some((position, index) => index > 0 && position !== positions[index - 1]! + 1)) {
    reject('Paragraph merge requires adjacent text objects in content order');
  }
  const originalStyle = sources[0]!.textBlock?.runs[0]?.style;
  if (!originalStyle) reject('Paragraph source has no text style');
  const format = (style: typeof originalStyle) => JSON.stringify({
    ...style, ...(preferredFontId ? { fontId: preferredFontId } : {}),
  });
  if (sources.some(object => object.textBlock!.runs.some(run => format(run.style) !== format(originalStyle)))) {
    reject('Mixed text formatting needs range-preserving paragraph support; merge unchanged-style blocks only');
  }
  const fontId = preferredFontId ?? originalStyle.fontId;
  const fontSize = originalStyle.fontSize;
  if (!fontId || !context.fontIds?.has(fontId) || !fontSize) {
    reject('Select a registered, editable font for the source paragraph before merging');
  }
  const rects = sources.map(object => object.bounds);
  const x = Math.min(...rects.map(rect => rect.x));
  const y = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  const alignment = originalStyle.alignment;
  return {
    type: 'text.reflow', pageId: command.pageId, blockIds: command.blockIds,
    objectId: crypto.randomUUID(), bounds: { x, y, width: right - x, height: bottom - y },
    text: sources.map(object => object.textBlock!.runs.map(run => run.text).join('')).join('\n'),
    style: { fontId, fontSize,
      ...(originalStyle.color ? { color: originalStyle.color } : {}),
      ...(originalStyle.characterSpacing !== undefined ? { characterSpacing: originalStyle.characterSpacing } : {}),
      ...(originalStyle.lineHeight !== undefined ? { lineHeight: originalStyle.lineHeight } : {}),
      ...(originalStyle.underline !== undefined ? { underline: originalStyle.underline } : {}),
      ...(alignment === 'center' || alignment === 'right' ? { alignment } : {}),
    },
  };
}

function assertScope(command: EditCommand, request: AiRequest): void {
  const pageIds = new Set([...(request.context.pages ?? []).map(page => page.id), ...request.context.evidence.map(item => item.pageId), ...(request.context.objects ?? []).map(object => object.pageId)]);
  if ('pageIds' in command && command.pageIds.some(id => !pageIds.has(id))) reject('Candidate page is outside request scope');
  if ('pageId' in command && !pageIds.has(command.pageId)) reject('Candidate page is outside request scope');
  if ('objectIds' in command) {
    for (const id of command.objectIds) if (!request.context.objects?.some(object => object.id === id && object.pageId === command.pageId)) reject('Candidate object is outside request scope');
  }
  if (command.type === 'text.style' || command.type === 'text.reflow') {
    for (const id of command.blockIds) {
      const metadataTarget = request.context.objects?.some(object => object.type === 'text' && object.blockId === id && object.pageId === command.pageId);
      const evidenceTarget = request.context.evidence.some(item => item.blockId === id && item.pageId === command.pageId && !item.characterRange);
      if (!metadataTarget && !evidenceTarget) reject('Block-level format target is not in this request');
    }
  }
  if (command.type === 'form.fill' && !request.context.fields?.some(field => field.id === command.fieldId)) reject('Candidate field is outside request scope');
  if ('style' in command && command.style?.fontId && !request.context.availableFontIds?.includes(command.style.fontId)) reject('Candidate font is outside request scope');
}
function sortReplacements(commands: EditCommand[]): EditCommand[] {
  return commands.sort((a, b) => a.type === 'text.replace' && b.type === 'text.replace'
    ? a.blockId.localeCompare(b.blockId) || b.range[0] - a.range[0] : 0);
}

/** 只构建待预览事务；调用者必须在用户点击应用后才交给 CommandRegistry.execute。 */
export function createAiTransaction(requestInput: AiRequest, responseInput: AiResponseEnvelope, context: CommandContext, transactionId: string, preferredFontId?: string): EditTransaction {
  const request = aiRequestSchema.parse(requestInput);
  const response = aiResponseEnvelopeSchema.parse(responseInput);
  if (response.requestId !== request.requestId || response.feature !== request.feature ||
      response.document.id !== request.document.id || response.document.baseRevision !== request.document.revision ||
      context.document.id !== request.document.id || context.document.revision !== request.document.revision) {
    throw new EngineError('STALE_REVISION', 'AI candidate does not match request or current document revision');
  }
  const result = response.result;
  let commands: EditCommand[];
  if (result.kind === 'textProposal') {
    commands = sortReplacements(result.replacements.map(item => replacement(item.targetEvidenceId, item.text, request, context)));
  } else if (result.kind === 'translation') {
    commands = sortReplacements(result.blocks.map(item => replacement(item.evidenceId, item.text, request, context)));
  } else if (result.kind === 'commandPlan') {
    commands = result.commands.map(command => {
      if (!request.context.availableCommands?.includes(command.type)) reject('Candidate command is not allowed in this request');
      const local: EditCommand = command.type === 'text.replace'
        ? replacement(command.targetEvidenceId, command.text, request, context)
        : command.type === 'text.reflow' ? mergeTextBlocks(command, context, preferredFontId) : command;
      assertScope(local, request);
      return local;
    });
  } else {
    reject('Answers, extractions, and clarifications are not executable edit plans');
  }
  return validateTransaction({ id: transactionId, docId: request.document.id, baseRevision: request.document.revision, source: 'ai', commands }, context);
}

/** 调用前选择必须来自本地核心标准文本；只发送实际选区，不自动附上整页。 */
export function makeSelectionEvidence(base: Omit<EvidenceBlock, 'text' | 'characterRange'>, blockText: string, range: [number, number]): EvidenceBlock {
  assertTextRange(blockText, range);
  return { ...base, text: blockText.slice(...range), characterRange: [...range] };
}
