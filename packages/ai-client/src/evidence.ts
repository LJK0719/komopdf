import {
  aiRequestSchema,
  assertTextRange,
  type AiFeature,
  type AiRequest,
  type CitationRef,
  type EvidenceBlock,
  type TextRange,
} from '@pdf-editor/contracts';

export type DocumentIdentity = { id: string; revision: number };

export interface LocalEvidenceSource {
  evidenceId: string;
  sourceId: string;
  /** 请求时本地索引保存的完整标准块文字。 */
  blockText: string;
  /** PDF 核心提供时，边界坐标相对于 blockText。 */
  clusterBoundaries?: ReadonlySet<number>;
}

export interface FrozenEvidence {
  readonly evidence: Readonly<EvidenceBlock>;
  readonly sourceId: string;
  readonly blockText: string;
  readonly sourceRange: readonly [number, number];
  readonly clusterBoundaries?: readonly number[];
}

export class EvidenceSnapshot {
  readonly document: Readonly<DocumentIdentity>;
  readonly requestId: string;
  readonly protocolVersion: 1;
  readonly feature: AiFeature;
  readonly evidence: readonly FrozenEvidence[];
  #byId: ReadonlyMap<string, FrozenEvidence>;

  constructor(request: AiRequest, evidence: readonly FrozenEvidence[]) {
    this.document = Object.freeze({ id: request.document.id, revision: request.document.revision });
    this.requestId = request.requestId;
    this.protocolVersion = request.protocolVersion;
    this.feature = request.feature;
    this.evidence = Object.freeze([...evidence]);
    this.#byId = new Map(evidence.map(item => [item.evidence.id, item]));
    Object.freeze(this);
  }

  get(evidenceId: string): FrozenEvidence | undefined {
    return this.#byId.get(evidenceId);
  }
}

export function createEvidenceSnapshot(
  requestInput: AiRequest,
  localSources: readonly LocalEvidenceSource[],
): EvidenceSnapshot {
  const request = aiRequestSchema.parse(requestInput);
  const sourceByEvidenceId = new Map<string, LocalEvidenceSource>();
  for (const source of localSources) {
    if (!source.evidenceId || !source.sourceId) throw new Error('Evidence and source ID cannot be empty');
    if (sourceByEvidenceId.has(source.evidenceId)) throw new Error(`Duplicate local evidence: ${source.evidenceId}`);
    sourceByEvidenceId.set(source.evidenceId, source);
  }

  const frozen = request.context.evidence.map(evidence => {
    const source = sourceByEvidenceId.get(evidence.id);
    if (!source) throw new Error(`Missing local evidence snapshot: ${evidence.id}`);
    const range: TextRange = evidence.characterRange
      ? [evidence.characterRange[0], evidence.characterRange[1]]
      : [0, source.blockText.length];

    assertTextRange(source.blockText, range, source.clusterBoundaries);
    if (source.blockText.slice(range[0], range[1]) !== evidence.text) {
      throw new Error(`Local evidence text does not match request snippet: ${evidence.id}`);
    }

    const clusterBoundaries = source.clusterBoundaries
      ? Object.freeze([...source.clusterBoundaries].sort((a, b) => a - b))
      : undefined;
    return Object.freeze({
      evidence: freezeEvidenceBlock(evidence),
      sourceId: source.sourceId,
      blockText: source.blockText,
      sourceRange: Object.freeze([range[0], range[1]]) as readonly [number, number],
      ...(clusterBoundaries ? { clusterBoundaries } : {}),
    });
  });

  if (sourceByEvidenceId.size !== frozen.length) throw new Error('Local evidence snapshot contains evidence not used in request');
  return new EvidenceSnapshot(request, frozen);
}

export type CitationResolution = ResolvedCitation | UnresolvedCitation;

export interface ResolvedCitation {
  readonly status: 'resolved';
  readonly evidenceId: string;
  readonly match: 'evidence' | 'quote';
  readonly frozenLocation: FrozenCitationLocation;
  /** 只有文档身份和版本仍匹配时才提供当前坐标跳转。 */
  readonly currentLocation?: FrozenCitationLocation;
}

export interface UnresolvedCitation {
  readonly status: 'unresolved';
  readonly evidenceId: string;
  readonly reason: 'unknown-evidence' | 'quote-not-found';
}

export interface FrozenCitationLocation {
  readonly docId: string;
  readonly revision: number;
  readonly pageId: string;
  readonly pageNumber: number;
  readonly blockId: string;
  readonly range: readonly [number, number];
  readonly bounds?: readonly [number, number, number, number];
}

export function resolveCitation(
  snapshot: EvidenceSnapshot,
  citation: CitationRef,
  currentDocument: DocumentIdentity,
): CitationResolution {
  const item = snapshot.get(citation.evidenceId);
  if (!item) {
    return Object.freeze({ status: 'unresolved', evidenceId: citation.evidenceId, reason: 'unknown-evidence' });
  }

  let range = item.sourceRange;
  let match: ResolvedCitation['match'] = 'evidence';
  if (citation.quote !== undefined) {
    const matches = findOccurrences(item.evidence.text, citation.quote);
    if (matches.length === 0) {
      return Object.freeze({ status: 'unresolved', evidenceId: citation.evidenceId, reason: 'quote-not-found' });
    }
    if (matches.length === 1) {
      const start = matches[0];
      if (start === undefined) throw new Error('Unable to read unique citation position');
      const relativeRange: TextRange = [start, start + citation.quote.length];
      try {
        assertTextRange(item.evidence.text, relativeRange);
        const absoluteRange: TextRange = [
          item.sourceRange[0] + relativeRange[0],
          item.sourceRange[0] + relativeRange[1],
        ];
        assertTextRange(
          item.blockText,
          absoluteRange,
          item.clusterBoundaries ? new Set(item.clusterBoundaries) : undefined,
        );
        range = Object.freeze(absoluteRange);
        match = 'quote';
      } catch {
        // 引文切开字形簇时只定位冻结证据块，不猜子范围。
      }
    }
  }

  const frozenLocation = freezeCitationLocation(item, range);
  const isCurrent = currentDocument.id === snapshot.document.id &&
    currentDocument.revision === snapshot.document.revision;
  const base = {
    status: 'resolved' as const,
    evidenceId: citation.evidenceId,
    match,
    frozenLocation,
  };
  return Object.freeze(isCurrent ? { ...base, currentLocation: frozenLocation } : base);
}

function findOccurrences(text: string, quote: string): number[] {
  if (quote.length === 0) return [];
  const matches: number[] = [];
  let from = 0;
  while (from <= text.length - quote.length) {
    const index = text.indexOf(quote, from);
    if (index < 0) break;
    matches.push(index);
    from = index + 1;
  }
  return matches;
}

function freezeEvidenceBlock(evidence: EvidenceBlock): Readonly<EvidenceBlock> {
  const characterRange = evidence.characterRange
    ? Object.freeze([evidence.characterRange[0], evidence.characterRange[1]]) as [number, number]
    : undefined;
  const bounds = evidence.bounds
    ? Object.freeze([...evidence.bounds]) as [number, number, number, number]
    : undefined;
  return Object.freeze({
    ...evidence,
    ...(characterRange ? { characterRange } : {}),
    ...(bounds ? { bounds } : {}),
  });
}

function freezeCitationLocation(
  item: FrozenEvidence,
  range: readonly [number, number],
): FrozenCitationLocation {
  const bounds = item.evidence.bounds
    ? Object.freeze([...item.evidence.bounds]) as readonly [number, number, number, number]
    : undefined;
  return Object.freeze({
    docId: item.evidence.docId,
    revision: item.evidence.revision,
    pageId: item.evidence.pageId,
    pageNumber: item.evidence.pageNumber,
    blockId: item.evidence.blockId,
    range: Object.freeze([range[0], range[1]]) as readonly [number, number],
    ...(bounds ? { bounds } : {}),
  });
}
