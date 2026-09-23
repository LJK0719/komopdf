import { describe, expect, it } from 'vitest';
import { AI_FEATURES, type AiFeature, type AiRequest } from '@pdf-editor/contracts';
import { prepareProviderInput } from '../src/templates.js';
import { OutputValidationError, parseAndValidateResult } from '../src/validation.js';

function request(feature: AiFeature): AiRequest {
  return {
    protocolVersion: 1, requestId: 'r1', feature, document: { id: 'd1', revision: 1 },
    context: {
      scope: 'page',
      evidence: [{ id: 'e1', docId: 'd1', revision: 1, pageId: 'p1', pageNumber: 1, blockId: 'b1', text: 'evidence text' }],
      pages: [{ id: 'p1', pageNumber: 1 }],
      objects: [
        { id: 'o1', pageId: 'p1', type: 'text', blockId: 'metadata-block' },
        { id: 'image-object', pageId: 'p1', type: 'image' },
      ],
      fields: [{ id: 'f1', name: 'name', type: 'text' }],
      availableCommands: ['pages.rotate', 'pages.insert', 'objects.delete'],
    },
    instruction: 'do the requested task', options: {},
  };
}

describe('feature templates and output validation', () => {
  it('prepares a fixed structured template for all twelve features', () => {
    expect(AI_FEATURES).toHaveLength(12);
    for (const feature of AI_FEATURES) {
      const prepared = prepareProviderInput(request(feature), 8192);
      expect(prepared.input.systemInstruction).toContain('untrusted data');
      expect(prepared.input.responseSchema).toBeTruthy();
      expect(prepared.input.maxOutputTokens).toBe(8192);
    }
  });

  it('intersects client commands with the server proposal schemas', () => {
    const prepared = prepareProviderInput(request('commands.plan'), 8192);
    expect([...prepared.allowedCommands]).toEqual(['objects.delete', 'pages.rotate']);
    const schema = JSON.stringify(prepared.input.responseSchema);
    expect(schema).toContain('pages.rotate');
    expect(schema).not.toContain('pages.insert');
  });

  it('rejects command targets outside the supplied context', () => {
    const prepared = prepareProviderInput(request('commands.plan'), 8192);
    const raw = JSON.stringify({
      kind: 'commandPlan', explanation: 'rotate', commands: [{ type: 'pages.rotate', pageIds: ['unknown'], degrees: 90 }],
    });
    expect(() => parseAndValidateResult(raw, request('commands.plan'), prepared.expectedKind, prepared.allowedCommands, 1024 * 1024))
      .toThrow(OutputValidationError);
  });

  it('requires document translation to cover every evidence ID exactly once', () => {
    const translationRequest: AiRequest = {
      ...request('document.translate'),
      context: {
        ...request('document.translate').context,
        evidence: [
          ...request('document.translate').context.evidence,
          { id: 'e2', docId: 'd1', revision: 1, pageId: 'p1', pageNumber: 1, blockId: 'b2', text: 'second' },
        ],
      },
    };
    const prepared = prepareProviderInput(translationRequest, 8192);
    const incomplete = JSON.stringify({ kind: 'translation', blocks: [{ evidenceId: 'e1', text: 'first translated' }] });
    expect(() => parseAndValidateResult(incomplete, translationRequest, prepared.expectedKind, prepared.allowedCommands, 1024 * 1024))
      .toThrow(/completely cover/);
    const complete = JSON.stringify({ kind: 'translation', blocks: [
      { evidenceId: 'e1', text: 'first translated' }, { evidenceId: 'e2', text: 'second translated' },
    ] });
    expect(parseAndValidateResult(complete, translationRequest, prepared.expectedKind, prepared.allowedCommands, 1024 * 1024).kind)
      .toBe('translation');
  });

  it('accepts text.style only for evidence blocks or explicit text-object blockId metadata', () => {
    const commandRequest = request('commands.plan');
    const allowed = new Set(['text.style']);
    const accepted = JSON.stringify({
      kind: 'commandPlan', explanation: 'style',
      commands: [{ type: 'text.style', pageId: 'p1', blockIds: ['metadata-block'], style: { fontSize: 12 } }],
    });
    expect(parseAndValidateResult(accepted, commandRequest, 'commandPlan', allowed, 1024 * 1024).kind).toBe('commandPlan');

    const imageObjectId = JSON.stringify({
      kind: 'commandPlan', explanation: 'invalid style target',
      commands: [{ type: 'text.style', pageId: 'p1', blockIds: ['image-object'], style: { fontSize: 12 } }],
    });
    expect(() => parseAndValidateResult(imageObjectId, commandRequest, 'commandPlan', allowed, 1024 * 1024))
      .toThrow(/does not match page/);
  });

  it('constrains real form suggestions to the supplied field value types', () => {
    const formRequest: AiRequest = {
      ...request('form.suggest'),
      context: { ...request('form.suggest').context,
        availableCommands: ['form.fill'],
        fields: [{ id: 'name-field', name: 'Name', type: 'text' },
          { id: 'city-field', name: 'City', type: 'choice', options: ['Beijing', 'Shanghai'] },
          { id: 'agree-field', name: 'Agree', type: 'checkbox' }] },
    };
    const prepared = prepareProviderInput(formRequest, 8192);
    expect(JSON.stringify(prepared.input.responseSchema)).toContain('"value":{"anyOf":[{"type":"STRING"},{"type":"BOOLEAN"}]}');
    const plan = (commands: unknown[]) => JSON.stringify({ kind: 'commandPlan', commands, explanation: 'Synthetic form' });
    expect(() => parseAndValidateResult(plan([{ type: 'form.fill', fieldId: 'name-field', value: ['Alice'] }]),
      formRequest, 'commandPlan', prepared.allowedCommands, 1024 * 1024)).toThrow(/field type/);
    expect(() => parseAndValidateResult(plan([{ type: 'form.fill', fieldId: 'city-field', value: 'London' }]),
      formRequest, 'commandPlan', prepared.allowedCommands, 1024 * 1024)).toThrow(/field option/);
    expect(parseAndValidateResult(plan([
      { type: 'form.fill', fieldId: 'name-field', value: 'Alice' },
      { type: 'form.fill', fieldId: 'city-field', value: 'Beijing' },
      { type: 'form.fill', fieldId: 'agree-field', value: true },
    ]), formRequest, 'commandPlan', prepared.allowedCommands, 1024 * 1024).kind).toBe('commandPlan');
  });

  it('requires document answers to carry verified evidence citations', () => {
    const prepared = prepareProviderInput(request('document.ask'), 8192);
    const noCitation = JSON.stringify({ kind: 'answer', text: 'unsupported', citations: [] });
    expect(() => parseAndValidateResult(noCitation, request('document.ask'), prepared.expectedKind, prepared.allowedCommands, 1024 * 1024))
      .toThrow(/missing evidence citation/);

    const badQuote = JSON.stringify({ kind: 'answer', text: 'answer', citations: [{ evidenceId: 'e1', quote: 'not present' }] });
    expect(() => parseAndValidateResult(badQuote, request('document.ask'), prepared.expectedKind, prepared.allowedCommands, 1024 * 1024))
      .toThrow(/Citation quote/);
  });
});
