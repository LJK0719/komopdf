import { describe, expect, it } from 'vitest';
import type { AiRequest } from '@pdf-editor/contracts';
import { ReadingAnswerStream } from '../src/reading-answer.js';
import { parseAndValidateResult } from '../src/validation.js';

const request: AiRequest = { protocolVersion: 1, requestId: 'question', feature: 'image.explain',
  document: { id: 'report', revision: 0 }, context: { scope: 'page', evidence: [
    { id: 'e1', docId: 'report', revision: 0, pageId: 'p1', pageNumber: 1, blockId: 'b1', text: 'Throughput increased by 20 percent.' },
  ] }, instruction: 'Summarize the result.', options: {} };
const parse = (value: unknown) => parseAndValidateResult(JSON.stringify(value), request, 'answer', new Set(), 8192);

describe('reading answers', () => {
  it('accepts the answer field returned by the live image provider', () => {
    expect(parse({ answer: 'Throughput increased by 20 percent.[e1]' })).toEqual({
      kind: 'answer', text: 'Throughput increased by 20 percent.', citations: [{ evidenceId: 'e1' }],
    });
  });

  it('retains the answer when optional citations are absent or malformed', () => {
    expect(parse({ kind: 'answer', text: 'A readable answer', citations: [
      { evidenceId: 'missing' }, { evidenceId: 'e1', quote: 'not a verbatim quotation' },
    ] })).toEqual({ kind: 'answer', text: 'A readable answer', citations: [{ evidenceId: 'e1' }] });
    expect(parse({ text: 'A visual answer' })).toEqual({ kind: 'answer', text: 'A visual answer', citations: [] });
  });

  it('decodes escaped strings before the provider finishes the wrapper', () => {
    const stream = new ReadingAnswerStream();
    expect(stream.push('{"kind":"answer","text":"First ')).toBe('First ');
    expect(stream.push('line\\n\\"quoted\\" \\uD83D')).toBe('First line\n"quoted" ');
    expect(stream.push('\\uDE00","citations":')).toBe('First line\n"quoted" 😀');
    expect(stream.push('[]}')).toBe('First line\n"quoted" 😀');
  });

  it('accepts a complete plain Markdown response without making it a PDF command', () => {
    expect(parseAndValidateResult('## Result\nA useful answer', request, 'answer', new Set(), 8192)).toEqual({
      kind: 'answer', text: '## Result\nA useful answer', citations: [],
    });
  });
});
