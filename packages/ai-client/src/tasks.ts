import { DocumentAiAuthorization, type AuthorizedRequestHandle } from './authorization.js';
import { hashStableValue, sha256Text } from './hash.js';

export type LongTaskStatus = 'paused' | 'running' | 'completed' | 'failed' | 'cancelled';
export type LongTaskBatchStatus = 'pending' | 'paused' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface LongTaskBatch<Payload, Result> {
  id: string;
  content: string;
  contentHash: string;
  payloadHash: string;
  /** 同一文档、配置及块内容与 payload（含来源/位置身份）相同才可复用。 */
  cacheKey: string;
  payload: Payload;
  status: LongTaskBatchStatus;
  result?: Result;
  error?: string;
}

export interface LongTaskRecord<Payload, Result> {
  id: string;
  docId: string;
  baseRevision: number;
  sourceIds: string[];
  taskType: string;
  scope: unknown;
  contentFingerprint: string;
  model: string;
  templateVersion: string;
  protocolVersion: number;
  settings?: unknown;
  settingsHash: string;
  hashKey: string;
  status: LongTaskStatus;
  batches: LongTaskBatch<Payload, Result>[];
}

export interface CompletedBatch<Result> {
  cacheKey: string;
  contentHash: string;
  result: Result;
}

/** saveTask 应以单次覆盖写入持久化整条记录。 */
export interface LongTaskStore<Payload, Result> {
  loadTask(taskId: string): Promise<LongTaskRecord<Payload, Result> | undefined>;
  saveTask(task: LongTaskRecord<Payload, Result>): Promise<void>;
  findCompletedBatch(cacheKey: string): Promise<CompletedBatch<Result> | undefined>;
}

export interface CreateLongTaskInput<Payload> {
  id: string;
  docId: string;
  baseRevision: number;
  sourceIds: readonly string[];
  taskType: string;
  scope: unknown;
  /** 整个任务输入内容的稳定指纹。 */
  contentFingerprint: string;
  model: string;
  templateVersion: string;
  protocolVersion: number;
  settings?: unknown;
  batches: readonly { id: string; content: string; payload: Payload }[];
}

export async function createLongTask<Payload, Result = unknown>(
  input: CreateLongTaskInput<Payload>,
): Promise<LongTaskRecord<Payload, Result>> {
  requireNonempty(input.id, 'task id');
  requireNonempty(input.docId, 'docId');
  requireNonempty(input.taskType, 'taskType');
  requireNonempty(input.contentFingerprint, 'contentFingerprint');
  requireNonempty(input.model, 'model');
  requireNonempty(input.templateVersion, 'templateVersion');
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) throw new Error('Invalid baseRevision');
  if (!Number.isInteger(input.protocolVersion) || input.protocolVersion < 0) throw new Error('Invalid protocolVersion');
  const sourceIds = uniqueNonempty(input.sourceIds, 'sourceId');
  const batchIds = uniqueNonempty(input.batches.map(batch => batch.id), 'batch id');
  if (batchIds.length !== input.batches.length || batchIds.length === 0) throw new Error('Batch IDs must be unique and non-empty');

  const settingsHash = await hashStableValue(input.settings ?? null);
  const hashKey = await hashStableValue({
    taskType: input.taskType,
    contentFingerprint: input.contentFingerprint,
    model: input.model,
    templateVersion: input.templateVersion,
    protocolVersion: input.protocolVersion,
    settingsHash,
  });
  // 整篇指纹只用于任务快照身份；批次复用不能绑定整篇内容，否则单块修改会让全部批次失效。
  const batchContextKey = await hashStableValue({
    docId: input.docId,
    taskType: input.taskType,
    model: input.model,
    templateVersion: input.templateVersion,
    protocolVersion: input.protocolVersion,
    settingsHash,
  });
  const batches = await Promise.all(input.batches.map(async batch => {
    const contentHash = await sha256Text(batch.content);
    const payloadHash = await hashStableValue(batch.payload);
    const sourceId = batch.payload && typeof batch.payload === 'object' && 'sourceId' in batch.payload
      ? batch.payload.sourceId : undefined;
    const sourceIdentity = typeof sourceId === 'string' ? sourceId : sourceIds;
    const cacheKey = await hashStableValue({ batchContextKey, sourceIdentity, contentHash, payloadHash });
    return {
      id: batch.id,
      content: batch.content,
      contentHash,
      payloadHash,
      cacheKey,
      payload: batch.payload,
      status: 'pending' as const,
    };
  }));

  return {
    id: input.id,
    docId: input.docId,
    baseRevision: input.baseRevision,
    sourceIds,
    taskType: input.taskType,
    scope: input.scope,
    contentFingerprint: input.contentFingerprint,
    model: input.model,
    templateVersion: input.templateVersion,
    protocolVersion: input.protocolVersion,
    settings: input.settings ?? null,
    settingsHash,
    hashKey,
    status: 'paused',
    batches,
  };
}

export type RunLongTaskBatch<Payload, Result> = (
  task: Readonly<LongTaskRecord<Payload, Result>>,
  batch: Readonly<LongTaskBatch<Payload, Result>>,
  signal: AbortSignal,
) => Promise<Result>;

type ActiveRun = {
  controller: AbortController;
  intent: 'run' | 'pause' | 'cancel';
};

export class LongTaskRunner<Payload, Result> {
  readonly #store: LongTaskStore<Payload, Result>;
  readonly #active = new Map<string, ActiveRun>();

  constructor(store: LongTaskStore<Payload, Result>) {
    this.#store = store;
  }

  async restore(taskId: string): Promise<LongTaskRecord<Payload, Result>> {
    const task = await this.#requireTask(taskId);
    let changed = false;
    if (task.status === 'running') {
      task.status = 'paused';
      changed = true;
    }
    for (const batch of task.batches) {
      if (batch.status === 'running') {
        batch.status = 'paused';
        changed = true;
      }
    }
    if (changed) await this.#store.saveTask(task);
    return task;
  }

  async continueTask(
    taskId: string,
    authorization: DocumentAiAuthorization,
    runBatch: RunLongTaskBatch<Payload, Result>,
    onBatchCompleted?: (task: Readonly<LongTaskRecord<Payload, Result>>) => void,
  ): Promise<LongTaskRecord<Payload, Result>> {
    if (this.#active.has(taskId)) throw new Error('A batch is already in progress for this task');
    const active: ActiveRun = { controller: new AbortController(), intent: 'run' };
    this.#active.set(taskId, active);
    try {
      const task = await this.#requireTask(taskId);
      if (task.status === 'cancelled' || task.status === 'failed') {
        throw new Error('Cancelled or failed tasks will not be retried automatically');
      }
      if (task.status === 'completed') return task;
      authorization.assertAuthorized(task.docId, task.sourceIds);
      task.status = 'running';
      await this.#store.saveTask(task);

      for (const batch of task.batches) {
        if (batch.status !== 'pending' && batch.status !== 'paused') continue;
        if (active.intent !== 'run') {
          await this.#finishInterrupted(task, batch, active.intent);
          return task;
        }
        if (!authorization.isAuthorized(task.docId, task.sourceIds)) {
          await this.#finishInterrupted(task, batch, 'pause');
          return task;
        }

        const cached = this.#findLocalCompleted(task, batch.cacheKey) ??
          await this.#store.findCompletedBatch(batch.cacheKey);
        if (cached && cached.contentHash === batch.contentHash) {
          batch.result = cached.result;
          batch.status = 'completed';
          delete batch.error;
          await this.#store.saveTask(task);
          onBatchCompleted?.(task);
          continue;
        }

        batch.status = 'running';
        delete batch.error;
        await this.#store.saveTask(task);
        let authorizationHandle: AuthorizedRequestHandle | undefined;
        try {
          authorizationHandle = authorization.beginRequest(
            task.docId,
            task.sourceIds,
            active.controller.signal,
          );
          const result = await runBatch(task, batch, authorizationHandle.signal);
          const interruption = interruptionIntent(
            active,
            !authorization.isAuthorized(task.docId, task.sourceIds),
          );
          if (interruption) {
            await this.#finishInterrupted(task, batch, interruption);
            return task;
          }
          batch.result = result;
          batch.status = 'completed';
          // result 和 completed 在同一次 store 写入中提交。
          await this.#store.saveTask(task);
          onBatchCompleted?.(task);
        } catch (error) {
          const interruption = interruptionIntent(
            active,
            !authorization.isAuthorized(task.docId, task.sourceIds),
          );
          if (interruption) {
            await this.#finishInterrupted(task, batch, interruption);
            return task;
          }
          batch.status = 'failed';
          batch.error = errorMessage(error);
          task.status = 'failed';
          await this.#store.saveTask(task);
          throw error;
        } finally {
          authorizationHandle?.release();
        }
      }

      task.status = task.batches.every(batch => batch.status === 'completed') ? 'completed' : 'paused';
      await this.#store.saveTask(task);
      return task;
    } finally {
      this.#active.delete(taskId);
    }
  }

  async pauseTask(taskId: string): Promise<void> {
    const active = this.#active.get(taskId);
    if (active) {
      active.intent = 'pause';
      active.controller.abort(new DOMException('Task paused', 'AbortError'));
      return;
    }
    const task = await this.#requireTask(taskId);
    if (task.status === 'completed' || task.status === 'cancelled') return;
    task.status = 'paused';
    for (const batch of task.batches) if (batch.status === 'running') batch.status = 'paused';
    await this.#store.saveTask(task);
  }

  async cancelTask(taskId: string): Promise<void> {
    const active = this.#active.get(taskId);
    if (active) {
      active.intent = 'cancel';
      active.controller.abort(new DOMException('Task cancelled', 'AbortError'));
      return;
    }
    const task = await this.#requireTask(taskId);
    if (task.status === 'completed' || task.status === 'cancelled') return;
    task.status = 'cancelled';
    for (const batch of task.batches) {
      if (batch.status === 'pending' || batch.status === 'paused' || batch.status === 'running') {
        batch.status = 'cancelled';
      }
    }
    await this.#store.saveTask(task);
  }

  #findLocalCompleted(
    task: LongTaskRecord<Payload, Result>,
    cacheKey: string,
  ): CompletedBatch<Result> | undefined {
    const batch = task.batches.find(item =>
      item.cacheKey === cacheKey && item.status === 'completed' && item.result !== undefined,
    );
    return batch?.result === undefined ? undefined : {
      cacheKey: batch.cacheKey,
      contentHash: batch.contentHash,
      result: batch.result,
    };
  }

  async #finishInterrupted(
    task: LongTaskRecord<Payload, Result>,
    batch: LongTaskBatch<Payload, Result>,
    intent: 'pause' | 'cancel',
  ): Promise<void> {
    batch.status = intent === 'cancel' ? 'cancelled' : 'paused';
    task.status = intent === 'cancel' ? 'cancelled' : 'paused';
    await this.#store.saveTask(task);
  }

  async #requireTask(taskId: string): Promise<LongTaskRecord<Payload, Result>> {
    const task = await this.#store.loadTask(taskId);
    if (!task) throw new Error(`Task does not exist: ${taskId}`);
    return task;
  }
}

function requireNonempty(value: string, label: string): void {
  if (!value) throw new Error(`${label} cannot be empty`);
}

function uniqueNonempty(values: readonly string[], label: string): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    requireNonempty(value, label);
    if (unique.has(value)) throw new Error(`${label} cannot be duplicated`);
    unique.add(value);
  }
  return [...unique];
}

function interruptionIntent(
  active: ActiveRun,
  authorizationLost: boolean,
): 'pause' | 'cancel' | undefined {
  if (active.intent === 'cancel') return 'cancel';
  if (active.intent === 'pause' || active.controller.signal.aborted || authorizationLost) return 'pause';
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
