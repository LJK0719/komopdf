import { describe, expect, it } from 'vitest';
import { aiRequestSchema, type AiRequest } from '@pdf-editor/contracts';
import { parseAndValidateResult } from '../src/validation.js';
import { prepareProviderInput } from '../src/templates.js';

const request: AiRequest = {
  protocolVersion: 1, requestId: 'references', feature: 'document.ask', document: { id: 'main', revision: 2 },
  instruction: 'Compare the two documents.', options: {},
  context: { scope: 'document', evidence: [{ id: 'e1', docId: 'main', revision: 2, pageId: 'p1', pageNumber: 1, blockId: 'b1', text: 'Main text' }],
    sourceDocuments: [{ id: 'reference', revision: 5, name: 'Reference.pdf', sourceIds: ['ref-source'], pageIds: ['ref-page'] }],
    referenceEvidence: [{ id: 'r1', docId: 'reference', revision: 5, sourceId: 'ref-source', materialId: 'material', kind: 'source',
      pageId: 'ref-page', pageNumber: 1, blockId: 'ref-block', text: 'Reference original', characterRange: [0, 18] }],
  },
};
function copy(): AiRequest { return structuredClone(request); }
function validate(body: unknown, input = request, kind: 'answer' | 'textProposal' | 'commandPlan' = 'answer') {
  return parseAndValidateResult(JSON.stringify(body), input, kind, new Set(['text.replace', 'pages.delete']), 10000);
}

describe('read-only multi-document evidence protocol', () => {
  it('retains real reference identities without relaxing primary evidence identity', () => {
    expect(aiRequestSchema.parse(request).context.referenceEvidence?.[0]?.docId).toBe('reference');
    const forged = copy(); forged.context.evidence[0]!.docId = 'reference';
    expect(aiRequestSchema.safeParse(forged).success).toBe(false);
    const mixedRevision = copy(); mixedRevision.context.evidence[0]!.revision = 5;
    expect(aiRequestSchema.safeParse(mixedRevision).success).toBe(false);
  });
  it.each([
    ['missing manifest', (input: AiRequest) => { delete input.context.sourceDocuments; }],
    ['missing document', (input: AiRequest) => { input.context.sourceDocuments = []; }],
    ['wrong revision', (input: AiRequest) => { input.context.referenceEvidence![0]!.revision = 6; }],
    ['wrong source id', (input: AiRequest) => { input.context.referenceEvidence![0]!.sourceId = 'secret-source'; }],
    ['wrong page', (input: AiRequest) => { input.context.referenceEvidence![0]!.pageId = 'p1'; }],
    ['wrong page number', (input: AiRequest) => { input.context.referenceEvidence![0]!.pageNumber = 2; }],
    ['missing source range', (input: AiRequest) => { delete input.context.referenceEvidence![0]!.characterRange; }],
    ['wrong range length', (input: AiRequest) => { input.context.referenceEvidence![0]!.characterRange = [0, 1]; }],
    ['namespace collision', (input: AiRequest) => { input.context.referenceEvidence![0]!.id = 'e1'; }],
    ['duplicate evidence', (input: AiRequest) => { input.context.referenceEvidence!.push(input.context.referenceEvidence![0]!); }],
    ['duplicate source document', (input: AiRequest) => { input.context.sourceDocuments!.push(input.context.sourceDocuments![0]!); }],
    ['generated offset', (input: AiRequest) => { input.context.referenceEvidence![0]!.kind = 'generated'; }],
  ])('rejects %s', (_name, change) => {
    const input = copy(); change(input); expect(aiRequestSchema.safeParse(input).success).toBe(false);
  });
  it('accepts generated and analysis references without inventing PDF character offsets', () => {
    for (const kind of ['generated', 'analysis'] as const) {
      const input = copy(); input.context.referenceEvidence![0]!.kind = kind;
      delete input.context.referenceEvidence![0]!.characterRange;
      expect(aiRequestSchema.safeParse(input).success).toBe(true);
    }
  });
  it('checks answer citations and quotes against both source namespaces', () => {
    const answer = { kind: 'answer', text: 'Comparison', citations: [{ evidenceId: 'e1' }, { evidenceId: 'r1', quote: 'original' }] };
    expect(validate(answer)).toEqual(answer);
    expect(() => validate({ ...answer, citations: [{ evidenceId: 'r1', quote: 'not in source' }] })).toThrow('Citation quote');
    expect(() => validate({ ...answer, citations: [{ evidenceId: 'unknown' }] })).toThrow('outside the request');
  });
  it('never allows reference ids in text proposals or command targets', () => {
    expect(() => validate({ kind: 'textProposal', replacements: [{ targetEvidenceId: 'r1', text: 'write' }] }, request, 'textProposal')).toThrow();
    expect(() => validate({ kind: 'commandPlan', explanation: 'edit', commands: [{ type: 'text.replace', targetEvidenceId: 'r1', text: 'write' }] }, request, 'commandPlan')).toThrow();
    expect(() => validate({ kind: 'commandPlan', explanation: 'edit', commands: [{ type: 'pages.delete', pageIds: ['ref-page'] }] }, request, 'commandPlan')).toThrow();
    expect(validate({ kind: 'textProposal', replacements: [{ targetEvidenceId: 'e1', text: 'valid' }] }, request, 'textProposal').kind).toBe('textProposal');
  });
  it('sends source declarations as data and explicitly separates derived material from PDF quotations', () => {
    const prepared = prepareProviderInput(request, 1000);
    expect(prepared.input.systemInstruction).toContain('referenceEvidence is read-only');
    expect(prepared.input.systemInstruction).toContain('kind=generated');
    expect(prepared.input.systemInstruction).toContain('kind=analysis');
    expect(prepared.input.systemInstruction).not.toContain('Reference original');
    const payload = JSON.parse((prepared.input.parts[0] as { text: string }).text);
    expect(payload.document.id).toBe('main');
    expect(payload.context.referenceEvidence[0].docId).toBe('reference');
    expect(prepared.allowedCommands.size).toBe(0);
  });
});
