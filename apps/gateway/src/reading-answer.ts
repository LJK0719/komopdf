import type { AiRequest, AiResult, CitationRef } from '@pdf-editor/contracts';
import { identityReply, isIdentityQuestion } from './komo-identity.js';

export function readingAnswer(value: unknown, request: AiRequest): AiResult | undefined {
  if (isIdentityQuestion(request.instruction)) return identityReply(request);
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (data.kind === 'clarification' && typeof data.question === 'string' && data.question.trim()) {
    return { kind: 'clarification', question: data.question };
  }
  const text = typeof value === 'string' ? value : typeof data.text === 'string' ? data.text : data.answer;
  if (typeof text !== 'string' || !text.trim()) return;
  const evidence = new Map([...request.context.evidence, ...request.context.referenceEvidence ?? []].map(item => [item.id, item.text]));
  const citations = new Map<string, CitationRef>();
  for (const item of Array.isArray(data.citations) ? data.citations : []) {
    const citation = typeof item === 'string' ? { evidenceId: item } : item;
    if (!citation || typeof citation.evidenceId !== 'string' || !evidence.has(citation.evidenceId)) continue;
    citations.set(citation.evidenceId, { evidenceId: citation.evidenceId,
      ...(typeof citation.quote === 'string' && citation.quote && evidence.get(citation.evidenceId)!.includes(citation.quote) ? { quote: citation.quote } : {}) });
  }
  const clean = text.replace(/\[([^\]\n]+)\]/g, (marker, id: string) => {
    if (!evidence.has(id)) return marker;
    if (!citations.has(id)) citations.set(id, { evidenceId: id });
    return '';
  });
  return { kind: 'answer', text: clean.trim(), citations: [...citations.values()] };
}

/** Decode the answer string while its surrounding JSON is still arriving. */
export class ReadingAnswerStream {
  private raw = '';
  private start = -1;
  private cursor = 0;
  private decoded = '';
  private ended = false;

  push(chunk: string): string {
    this.raw += chunk;
    if (this.start < 0) {
      const match = /"(?:text|answer|question)"\s*:\s*"/.exec(this.raw);
      if (match) this.start = this.cursor = match.index + match[0].length;
      else return /^\s*(?:\{|"|```)/.test(this.raw) ? '' : this.raw;
    }
    while (!this.ended && this.cursor < this.raw.length) {
      const unit = this.raw[this.cursor]!;
      if (unit === '"') { this.ended = true; break; }
      if (unit !== '\\') { this.decoded += unit; this.cursor++; continue; }
      const escape = this.raw[this.cursor + 1];
      if (!escape) break;
      const length = escape === 'u' ? 6 : 2;
      if (this.cursor + length > this.raw.length) break;
      this.decoded += JSON.parse(`"${this.raw.slice(this.cursor, this.cursor + length)}"`) as string;
      this.cursor += length;
    }
    // A provider can split an escaped UTF-16 pair between events.
    return /[\uD800-\uDBFF]$/.test(this.decoded) ? this.decoded.slice(0, -1) : this.decoded;
  }
}
