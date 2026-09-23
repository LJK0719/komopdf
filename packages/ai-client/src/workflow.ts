import {
  aiRequestSchema,
  type AiRequest,
  type AiResponseEnvelope,
  type EditTransaction,
  type EvidenceBlock,
} from '@pdf-editor/contracts';
import { DocumentAiAuthorization } from './authorization.js';
import { EvidenceSnapshot, type DocumentIdentity } from './evidence.js';
import {
  postAiRequest,
  type AiRequestOutcome,
  type FetchLike,
} from './sse.js';
import {
  assertResponseMatchesSnapshot,
  buildTextProposalTransaction,
  createTransactionPreview,
  type ApplyTransaction,
  type TransactionPreview,
} from './transactions.js';

export type CommandPlanTransactionBuilder = (
  request: AiRequest,
  response: AiResponseEnvelope,
  snapshot: EvidenceSnapshot,
  transactionId: string,
) => EditTransaction;

export interface AiWorkflowOptions<ApplyResult> {
  endpoint: string | URL;
  imageEndpoint?: string | URL;
  authorization: DocumentAiAuthorization;
  getCurrentDocument: () => DocumentIdentity | Promise<DocumentIdentity>;
  /** 生产集成应传入真实 EngineAdapter.apply；本包不会提供 mock 执行器。 */
  apply: ApplyTransaction<ApplyResult>;
  nextTransactionId: () => string;
  fetch?: FetchLike;
  buildCommandPlanTransaction?: CommandPlanTransactionBuilder;
}

export interface RunAiWorkflowInput {
  request: AiRequest;
  snapshot: EvidenceSnapshot;
  /** 来自当前 DocumentInfo.sourceIds；新增来源必须先补充授权。 */
  sourceIds: readonly string[];
  signal?: AbortSignal;
  onEvent?: Parameters<typeof postAiRequest>[0]['onEvent'];
  onDelta?: Parameters<typeof postAiRequest>[0]['onDelta'];
}

export interface AiWorkflowResult<ApplyResult> extends AiRequestOutcome {
  readonly preview?: TransactionPreview<ApplyResult>;
}

export class AiWorkflow<ApplyResult> {
  readonly #options: AiWorkflowOptions<ApplyResult>;

  constructor(options: AiWorkflowOptions<ApplyResult>) {
    this.#options = options;
  }

  async run(input: RunAiWorkflowInput): Promise<AiWorkflowResult<ApplyResult>> {
    const request = deepFreeze(aiRequestSchema.parse(input.request));
    assertRequestMatchesSnapshot(request, input.snapshot);
    assertSnapshotSourcesDeclared(input.snapshot, input.sourceIds);
    const handle = this.#options.authorization.beginRequest(
      request.document.id,
      input.sourceIds,
      input.signal,
    );
    try {
      const hasImages = (request.context.images?.length ?? 0) > 0;
      let endpoint = this.#options.endpoint;
      if (hasImages) {
        if (this.#options.imageEndpoint) {
          endpoint = this.#options.imageEndpoint;
        } else if (typeof endpoint === 'string') {
          if (endpoint.endsWith('/requests')) {
            endpoint = endpoint.replace(/\/requests$/, '/image-requests');
          } else if (endpoint.endsWith('/api/v1/ai')) {
            endpoint = `${endpoint}/image-requests`;
          } else if (endpoint.includes('/api/v1/ai/requests')) {
            endpoint = endpoint.replace('/api/v1/ai/requests', '/api/v1/ai/image-requests');
          }
        }
      }
      const outcome = await postAiRequest({
        endpoint,
        request,
        signal: handle.signal,
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
        ...(input.onEvent ? { onEvent: input.onEvent } : {}),
        ...(input.onDelta ? { onDelta: input.onDelta } : {}),
      });
      const preview = this.#createPreview(request, input.snapshot, outcome.response);
      return Object.freeze({ ...outcome, ...(preview ? { preview } : {}) });
    } finally {
      handle.release();
    }
  }

  createSubsetPreview(
    snapshot: EvidenceSnapshot,
    response: AiResponseEnvelope,
    selectedEvidenceIds: ReadonlySet<string> | readonly string[],
  ): TransactionPreview<ApplyResult> {
    assertResponseMatchesSnapshot(response, snapshot);
    const transactionId = this.#options.nextTransactionId();
    const transaction = buildTextProposalTransaction(response, snapshot, transactionId, selectedEvidenceIds);
    return createTransactionPreview(
      response,
      transaction,
      this.#options.getCurrentDocument,
      this.#options.apply,
    );
  }

  #createPreview(
    request: AiRequest,
    snapshot: EvidenceSnapshot,
    response: AiResponseEnvelope,
  ): TransactionPreview<ApplyResult> | undefined {
    assertResponseMatchesSnapshot(response, snapshot);
    const kind = response.result.kind;
    if (kind !== 'textProposal' && kind !== 'translation' && kind !== 'commandPlan') return undefined;

    const transactionId = this.#options.nextTransactionId();
    let transaction: EditTransaction;
    if (kind === 'commandPlan') {
      const builder = this.#options.buildCommandPlanTransaction;
      if (!builder) throw new Error('Command plan requires a local validation builder injected by @pdf-editor/commands');
      transaction = builder(request, response, snapshot, transactionId);
    } else {
      transaction = buildTextProposalTransaction(response, snapshot, transactionId);
    }
    if (
      transaction.docId !== response.document.id ||
      transaction.baseRevision !== response.document.baseRevision ||
      transaction.source !== 'ai'
    ) {
      throw new Error('Injected AI transaction identity does not match response');
    }
    return createTransactionPreview(
      response,
      transaction,
      this.#options.getCurrentDocument,
      this.#options.apply,
    );
  }
}

function assertRequestMatchesSnapshot(request: AiRequest, snapshot: EvidenceSnapshot): void {
  if (
    request.requestId !== snapshot.requestId ||
    request.protocolVersion !== snapshot.protocolVersion ||
    request.feature !== snapshot.feature ||
    request.document.id !== snapshot.document.id ||
    request.document.revision !== snapshot.document.revision ||
    request.context.evidence.length !== snapshot.evidence.length ||
    request.context.evidence.some((evidence, index) =>
      !sameEvidence(evidence, snapshot.evidence[index]?.evidence),
    )
  ) {
    throw new Error('AI request content or identity does not match frozen evidence snapshot');
  }
}

function sameEvidence(left: EvidenceBlock, right: Readonly<EvidenceBlock> | undefined): boolean {
  return right !== undefined &&
    left.id === right.id &&
    left.docId === right.docId &&
    left.revision === right.revision &&
    left.pageId === right.pageId &&
    left.pageNumber === right.pageNumber &&
    left.blockId === right.blockId &&
    left.text === right.text &&
    sameTuple(left.characterRange, right.characterRange) &&
    sameTuple(left.bounds, right.bounds);
}

function sameTuple(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSnapshotSourcesDeclared(
  snapshot: EvidenceSnapshot,
  sourceIds: readonly string[],
): void {
  const declared = new Set(sourceIds);
  for (const item of snapshot.evidence) {
    if (!declared.has(item.sourceId)) throw new Error('Request source list does not cover frozen evidence sources');
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
