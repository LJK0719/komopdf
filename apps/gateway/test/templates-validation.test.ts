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
    expect([...prepared.allowedCommands]).toEqual(['objects.delete', 'pages.rotate', 'pages.insert']);
    const schema = JSON.stringify(prepared.input.responseSchema);
    expect(schema).toContain('pages.rotate');
    expect(schema).toContain('pages.insert');
    expect(schema).not.toContain('pages.duplicate');
  });

  it('rejects command targets outside the supplied context', () => {
    const prepared = prepareProviderInput(request('commands.plan'), 8192);
    const raw = JSON.stringify({
      kind: 'commandPlan', explanation: 'rotate', commands: [{ type: 'pages.rotate', pageIds: ['unknown'], degrees: 90 }],
    });
    expect(() => parseAndValidateResult(raw, request('commands.plan'), prepared.expectedKind, prepared.allowedCommands, 1024 * 1024))
      .toThrow(OutputValidationError);
  });

  it('accepts only scoped page insertion, duplication and object copy proposals without generated IDs', () => {
    const base = request('commands.plan');
    const scoped: AiRequest = { ...base, context: { ...base.context,
      availableCommands: ['pages.insert', 'pages.duplicate', 'objects.copy'] } };
    const prepared = prepareProviderInput(scoped, 8192);
    expect([...prepared.allowedCommands]).toEqual(['objects.copy', 'pages.insert', 'pages.duplicate']);
    const schema = JSON.stringify(prepared.input.responseSchema);
    expect(schema).not.toContain('newPageIds');
    expect(schema).not.toContain('newObjectIds');
    const plan = (commands: unknown[]) => JSON.stringify({ kind: 'commandPlan', explanation: 'Edit', commands });
    const validate = (commands: unknown[]) => parseAndValidateResult(plan(commands), scoped, 'commandPlan',
      prepared.allowedCommands, 1024 * 1024);
    expect(validate([
      { type: 'pages.insert', referencePageId: 'p1', position: 'before' },
      { type: 'pages.duplicate', pageIds: ['p1'], afterPageId: null },
      { type: 'objects.copy', pageId: 'p1', objectIds: ['o1'], offset: { x: 8, y: 2 } },
    ]).kind).toBe('commandPlan');
    expect(() => validate([{ type: 'pages.insert', referencePageId: 'not-shared', position: 'after' }]))
      .toThrow(/reference is not in request context/);
    expect(() => validate([{ type: 'pages.duplicate', pageIds: ['p1'], afterPageId: 'not-shared' }]))
      .toThrow(/position is not in request context/);
    expect(() => validate([{ type: 'objects.copy', pageId: 'p1', objectIds: ['not-shared'] }]))
      .toThrow(/does not match page/);
    expect(() => validate([{ type: 'pages.insert', referencePageId: 'p1', position: 'after', pageId: 'fake' }]))
      .toThrow(/output contract/);
    expect(() => validate([{ type: 'pages.duplicate', pageIds: ['p1'], afterPageId: 'p1', newPageIds: ['fake'] }]))
      .toThrow(/output contract/);
    expect(() => validate([{ type: 'objects.copy', pageId: 'p1', objectIds: ['o1'], newObjectIds: ['fake'] }]))
      .toThrow(/output contract/);
  });

  it('gates group/ungroup proposals for A05 and A11 to supplied objects without model-created IDs', () => {
    for (const feature of ['commands.plan', 'blocks.organize'] as const) {
      const base = request(feature);
      const scoped: AiRequest = { ...base, context: { ...base.context,
        objects: [...base.context.objects!, { id: 'group-1', pageId: 'p1', type: 'group' }],
        availableCommands: ['objects.group', 'objects.ungroup'] } };
      const prepared = prepareProviderInput(scoped, 8192);
      expect([...prepared.allowedCommands]).toEqual(['objects.group', 'objects.ungroup']);
      const schema = JSON.stringify(prepared.input.responseSchema);
      expect(schema).toContain('objects.group');
      expect(schema).not.toContain('newGroupId');
      const plan = (commands: unknown[]) => JSON.stringify({ kind: 'commandPlan', explanation: 'Group objects', commands });
      const validate = (commands: unknown[]) => parseAndValidateResult(plan(commands), scoped, 'commandPlan',
        prepared.allowedCommands, 1024 * 1024);
      expect(validate([
        { type: 'objects.group', pageId: 'p1', objectIds: ['o1', 'image-object'] },
        { type: 'objects.ungroup', pageId: 'p1', groupId: 'group-1' },
      ]).kind).toBe('commandPlan');
      expect(() => validate([{ type: 'objects.group', pageId: 'p1', objectIds: ['o1'], groupId: 'invented' }]))
        .toThrow(/output contract/);
      expect(() => validate([{ type: 'objects.group', pageId: 'p1', objectIds: ['o1', 'group-1'] }]))
        .toThrow(/unsupported object type/);
      expect(() => validate([{ type: 'objects.group', pageId: 'p1', objectIds: ['o1', 'foreign'] }]))
        .toThrow(/does not match page/);
      expect(() => validate([{ type: 'objects.ungroup', pageId: 'p1', groupId: 'o1' }]))
        .toThrow(/Group target is not in request context/);
    }
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

  it('allows only selected text blocks in AI paragraph merge plans', () => {
    const base = request('blocks.organize');
    const scoped: AiRequest = { ...base, context: { ...base.context,
      availableCommands: ['text.reflow'],
      objects: [{ id: 'o1', pageId: 'p1', type: 'text', blockId: 'b1' },
        { id: 'o2', pageId: 'p1', type: 'text', blockId: 'b2' }] } };
    const prepared = prepareProviderInput(scoped, 8192);
    expect(prepared.allowedCommands.has('text.reflow')).toBe(true);
    const plan = (blockIds: string[]) => JSON.stringify({ kind: 'commandPlan', explanation: 'Merge',
      commands: [{ type: 'text.reflow', pageId: 'p1', blockIds }] });
    expect(parseAndValidateResult(plan(['b1', 'b2']), scoped, prepared.expectedKind,
      prepared.allowedCommands, 1024 * 1024).kind).toBe('commandPlan');
    expect(() => parseAndValidateResult(plan(['b1', 'unselected']), scoped, prepared.expectedKind,
      prepared.allowedCommands, 1024 * 1024)).toThrow(/block does not match page/);
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
