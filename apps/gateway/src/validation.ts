import { aiResultSchema, type AiRequest, type AiResult, type ProposedCommand } from '@pdf-editor/contracts';

export class OutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputValidationError';
  }
}

export type ExpectedKind = Exclude<AiResult['kind'], 'clarification'>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new OutputValidationError(message);
}

function validateCitation(evidenceById: Map<string, string>, citation: { evidenceId: string; quote?: string | undefined }): void {
  const evidenceText = evidenceById.get(citation.evidenceId);
  assert(evidenceText !== undefined, 'Result references evidence outside the request');
  if (citation.quote !== undefined) assert(evidenceText.includes(citation.quote), 'Citation quote is not found in the corresponding evidence');
}

function validateCommand(request: AiRequest, command: ProposedCommand, allowedCommands: ReadonlySet<string>): void {
  assert(allowedCommands.has(command.type), 'Result contains unauthorized command type');
  const evidenceById = new Set(request.context.evidence.map(evidence => evidence.id));
  const pageIds = new Set([
    ...request.context.evidence.map(evidence => evidence.pageId),
    ...(request.context.pages ?? []).map(page => page.id),
    ...(request.context.objects ?? []).map(object => object.pageId),
  ]);
  const objectPage = new Map((request.context.objects ?? []).map(object => [object.id, object.pageId]));
  const blockPage = new Map(request.context.evidence.map(evidence => [evidence.blockId, evidence.pageId]));
  for (const object of request.context.objects ?? []) {
    if (object.type === 'text' && object.blockId !== undefined) blockPage.set(object.blockId, object.pageId);
  }
  const fieldIds = new Set((request.context.fields ?? []).map(field => field.id));
  const fontIds = new Set(request.context.availableFontIds ?? []);

  switch (command.type) {
    case 'text.replace':
      assert(evidenceById.has(command.targetEvidenceId), 'Text replacement target is not in requested evidence');
      return;
    case 'text.style':
      assert(pageIds.has(command.pageId), 'Text style page is not in request context');
      for (const blockId of command.blockIds) assert(blockPage.get(blockId) === command.pageId, 'Text style block does not match page');
      if (command.style.fontId !== undefined) assert(fontIds.has(command.style.fontId), 'Result used unauthorized font');
      return;
    case 'objects.transform':
    case 'objects.delete':
    case 'objects.align':
    case 'objects.distribute':
      assert(pageIds.has(command.pageId), 'Object command page is not in request context');
      for (const objectId of command.objectIds) assert(objectPage.get(objectId) === command.pageId, 'Object command target does not match page');
      return;
    case 'pages.rotate':
    case 'pages.crop':
    case 'pages.delete':
    case 'pages.reorder':
      for (const pageId of command.pageIds) assert(pageIds.has(pageId), 'Page command target is not in request context');
      return;
    case 'form.fill': {
      assert(fieldIds.has(command.fieldId), 'Form command target is not in request context');
      if (request.feature === 'form.suggest') {
        const field = request.context.fields!.find(item => item.id === command.fieldId)!;
        assert(field.type === 'checkbox' ? typeof command.value === 'boolean' : typeof command.value === 'string',
          'Form suggestion value does not match the supplied field type');
        if (field.type === 'radio' || field.type === 'choice') {
          assert(typeof command.value === 'string' && field.options?.includes(command.value),
            'Form suggestion value is not a supplied field option');
        }
      }
      return;
    }
  }
}

export function parseAndValidateResult(
  rawText: string,
  request: AiRequest,
  expectedKind: ExpectedKind,
  allowedCommands: ReadonlySet<string>,
  visibleResultBytes: number,
): AiResult {
  assert(Buffer.byteLength(rawText, 'utf8') <= visibleResultBytes, 'Model visible result exceeds size limit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new OutputValidationError('Model did not return complete JSON');
  }
  const checked = aiResultSchema.safeParse(parsed);
  if (!checked.success) throw new OutputValidationError('Model result does not match feature output contract');
  const result = checked.data;
  if (result.kind === 'clarification') return result;
  assert(result.kind === expectedKind, 'Model returned incorrect feature result type');

  const evidenceById = new Map(request.context.evidence.map(evidence => [evidence.id, evidence.text]));
  switch (result.kind) {
    case 'answer':
      for (const citation of result.citations) validateCitation(evidenceById, citation);
      if (request.feature === 'document.ask') assert(result.citations.length > 0, 'Document Q&A missing evidence citation');
      break;
    case 'textProposal': {
      const seen = new Set<string>();
      for (const replacement of result.replacements) {
        assert(evidenceById.has(replacement.targetEvidenceId), 'Text candidate references evidence outside the request');
        assert(!seen.has(replacement.targetEvidenceId), 'Duplicate text candidate for the same evidence');
        seen.add(replacement.targetEvidenceId);
      }
      break;
    }
    case 'translation': {
      const seen = new Set<string>();
      for (const block of result.blocks) {
        assert(evidenceById.has(block.evidenceId), 'Translation references evidence outside the request');
        assert(!seen.has(block.evidenceId), 'Duplicate translation evidence ID');
        seen.add(block.evidenceId);
      }
      assert(seen.size === evidenceById.size, 'Translation does not completely cover this batch of evidence');
      break;
    }
    case 'extraction':
      for (const field of result.fields) {
        assert(field.citations.length > 0, 'Extracted field missing evidence citation');
        for (const citation of field.citations) validateCitation(evidenceById, citation);
      }
      break;
    case 'commandPlan':
      for (const command of result.commands) validateCommand(request, command, allowedCommands);
      break;
  }
  return result;
}
