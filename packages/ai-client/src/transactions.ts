import {
  editTransactionSchema,
  type AiResponseEnvelope,
  type EditCommand,
  type EditTransaction,
} from '@pdf-editor/contracts';
import { EvidenceSnapshot, type DocumentIdentity } from './evidence.js';

export type PreviewErrorCode =
  | 'RESPONSE_SNAPSHOT_MISMATCH'
  | 'UNSUPPORTED_RESULT'
  | 'DUPLICATE_TARGET'
  | 'STALE_REVISION'
  | 'ALREADY_APPLIED'
  | 'APPLY_IN_PROGRESS';

export class AiPreviewError extends Error {
  constructor(public readonly code: PreviewErrorCode, message: string) {
    super(message);
    this.name = 'AiPreviewError';
  }
}

export type ApplyTransaction<Result> = (transaction: EditTransaction) => Promise<Result>;
export type CurrentDocument = () => DocumentIdentity | Promise<DocumentIdentity>;

export interface TransactionPreview<Result> {
  readonly response: AiResponseEnvelope;
  readonly transaction: EditTransaction;
  readonly state: () => 'pending' | 'applying' | 'applied';
  /** 只应绑定到用户明确点击“应用”的动作。 */
  readonly accept: () => Promise<Result>;
}

export function buildTextProposalTransaction(
  response: AiResponseEnvelope,
  snapshot: EvidenceSnapshot,
  transactionId: string,
  selectedEvidenceIds?: ReadonlySet<string> | readonly string[],
): EditTransaction {
  assertResponseMatchesSnapshot(response, snapshot);
  const result = response.result;
  let replacements = result.kind === 'textProposal'
    ? result.replacements.map(item => ({ evidenceId: item.targetEvidenceId, text: item.text }))
    : result.kind === 'translation'
      ? result.blocks.map(item => ({ evidenceId: item.evidenceId, text: item.text }))
      : undefined;

  if (!replacements) {
    throw new AiPreviewError('UNSUPPORTED_RESULT', 'Only text proposals and translations can construct transactions directly from local evidence');
  }

  if (selectedEvidenceIds !== undefined) {
    const filterSet = selectedEvidenceIds instanceof Set ? selectedEvidenceIds : new Set(selectedEvidenceIds);
    replacements = replacements.filter(item => filterSet.has(item.evidenceId));
    if (replacements.length === 0) {
      throw new AiPreviewError('UNSUPPORTED_RESULT', 'No candidates selected for transaction');
    }
  }

  const targets = new Set<string>();
  const commands: EditCommand[] = replacements.map(replacement => {
    if (targets.has(replacement.evidenceId)) {
      throw new AiPreviewError('DUPLICATE_TARGET', `Same evidence cannot be replaced twice in one transaction: ${replacement.evidenceId}`);
    }
    targets.add(replacement.evidenceId);
    const target = snapshot.get(replacement.evidenceId);
    if (!target) throw new AiPreviewError('RESPONSE_SNAPSHOT_MISMATCH', 'Candidate references evidence outside the request');
    return {
      type: 'text.replace',
      pageId: target.evidence.pageId,
      blockId: target.evidence.blockId,
      range: [target.sourceRange[0], target.sourceRange[1]],
      text: replacement.text,
    };
  });
  commands.sort((left, right) => {
    if (left.type !== 'text.replace' || right.type !== 'text.replace') return 0;
    return left.pageId.localeCompare(right.pageId) ||
      left.blockId.localeCompare(right.blockId) ||
      right.range[0] - left.range[0];
  });
  for (let index = 1; index < commands.length; index += 1) {
    const previous = commands[index - 1];
    const current = commands[index];
    if (previous?.type === 'text.replace' && current?.type === 'text.replace' &&
        previous.pageId === current.pageId && previous.blockId === current.blockId &&
        current.range[1] > previous.range[0]) {
      throw new AiPreviewError('DUPLICATE_TARGET', 'AI replacement ranges within the same text block cannot overlap');
    }
  }

  return freezeTransaction(editTransactionSchema.parse({
    id: transactionId,
    docId: snapshot.document.id,
    baseRevision: snapshot.document.revision,
    source: 'ai',
    commands,
  }));
}

export function createTransactionPreview<Result>(
  response: AiResponseEnvelope,
  transactionInput: EditTransaction,
  getCurrentDocument: CurrentDocument,
  apply: ApplyTransaction<Result>,
): TransactionPreview<Result> {
  const transaction = freezeTransaction(editTransactionSchema.parse(transactionInput));
  if (
    response.document.id !== transaction.docId ||
    response.document.baseRevision !== transaction.baseRevision
  ) {
    throw new AiPreviewError('RESPONSE_SNAPSHOT_MISMATCH', 'Preview transaction identity does not match AI response');
  }

  let state: 'pending' | 'applying' | 'applied' = 'pending';
  const preview: TransactionPreview<Result> = {
    response,
    transaction,
    state: () => state,
    accept: async () => {
      if (state === 'applying') throw new AiPreviewError('APPLY_IN_PROGRESS', 'This preview is currently being applied');
      if (state === 'applied') throw new AiPreviewError('ALREADY_APPLIED', 'This preview has already been applied');
      state = 'applying';
      try {
        const current = await getCurrentDocument();
        if (current.id !== transaction.docId || current.revision !== transaction.baseRevision) {
          throw new AiPreviewError('STALE_REVISION', 'Document has changed; please regenerate modifications based on current revision');
        }
        const result = await apply(transaction);
        state = 'applied';
        return result;
      } catch (error) {
        state = 'pending';
        throw error;
      }
    },
  };
  return Object.freeze(preview);
}

export function assertResponseMatchesSnapshot(
  response: AiResponseEnvelope,
  snapshot: EvidenceSnapshot,
): void {
  if (
    response.requestId !== snapshot.requestId ||
    response.protocolVersion !== snapshot.protocolVersion ||
    response.feature !== snapshot.feature ||
    response.document.id !== snapshot.document.id ||
    response.document.baseRevision !== snapshot.document.revision
  ) {
    throw new AiPreviewError('RESPONSE_SNAPSHOT_MISMATCH', 'AI response does not belong to this frozen evidence snapshot');
  }
}

function freezeTransaction(transaction: EditTransaction): EditTransaction {
  for (const command of transaction.commands) deepFreeze(command);
  Object.freeze(transaction.commands);
  return Object.freeze(transaction);
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  Object.freeze(value);
}
