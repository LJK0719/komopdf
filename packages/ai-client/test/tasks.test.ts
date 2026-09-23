import { describe, expect, it, vi } from 'vitest';
import {
  DocumentAiAuthorization,
  LongTaskRunner,
  chunkText,
  createLongTask,
  type CompletedBatch,
  type LongTaskRecord,
  type LongTaskStore,
} from '../src/index.js';

type Payload = { index: number };
type Result = { translated: string };

class MemoryStore implements LongTaskStore<Payload, Result> {
  readonly tasks = new Map<string, LongTaskRecord<Payload, Result>>();

  async loadTask(taskId: string): Promise<LongTaskRecord<Payload, Result> | undefined> {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  async saveTask(task: LongTaskRecord<Payload, Result>): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }

  async findCompletedBatch(cacheKey: string): Promise<CompletedBatch<Result> | undefined> {
    for (const task of this.tasks.values()) {
      const batch = task.batches.find(item => item.cacheKey === cacheKey && item.status === 'completed');
      if (batch?.result) return {
        cacheKey: batch.cacheKey,
        contentHash: batch.contentHash,
        result: structuredClone(batch.result),
      };
    }
    return undefined;
  }
}

async function makeTask(): Promise<LongTaskRecord<Payload, Result>> {
  return createLongTask<Payload, Result>({
    id: 'task-1',
    docId: 'doc-1',
    baseRevision: 1,
    sourceIds: ['source-1'],
    taskType: 'document.translate',
    scope: { pageIds: ['page-1'] },
    contentFingerprint: 'document-content-hash',
    model: 'gemini-3.8-flash-high',
    templateVersion: '1',
    protocolVersion: 1,
    settings: { targetLanguage: 'zh' },
    batches: [
      { id: 'batch-1', content: 'same content', payload: { index: 0 } },
      { id: 'batch-2', content: 'same content', payload: { index: 0 } },
    ],
  });
}

describe('长任务恢复与去重', () => {
  it('恢复时把遗留 running 固定转换为 paused', async () => {
    const store = new MemoryStore();
    const task = await makeTask();
    task.status = 'running';
    const first = task.batches[0];
    if (!first) throw new Error('测试批次缺失');
    first.status = 'running';
    await store.saveTask(task);

    const restored = await new LongTaskRunner(store).restore(task.id);
    expect(restored.status).toBe('paused');
    expect(restored.batches[0]?.status).toBe('paused');
  });

  it('相同任务键、内容与 payload 的已完成批次不会重复请求', async () => {
    const store = new MemoryStore();
    const task = await makeTask();
    await store.saveTask(task);
    const authorization = new DocumentAiAuthorization('doc-1');
    authorization.enable(['source-1']);
    const runBatch = vi.fn(async (_task, batch: Readonly<(typeof task.batches)[number]>) => ({
      translated: batch.content.toUpperCase(),
    }));

    const completed = await new LongTaskRunner(store).continueTask(task.id, authorization, runBatch);
    expect(completed.status).toBe('completed');
    expect(completed.batches.map(batch => batch.status)).toEqual(['completed', 'completed']);
    expect(completed.batches[1]?.result).toEqual(completed.batches[0]?.result);
    expect(runBatch).toHaveBeenCalledTimes(1);
  });

  it('相同文字但 payload 身份不同不会复用旧结果', async () => {
    const store = new MemoryStore();
    const base = await makeTask();
    const distinctTask = await createLongTask<Payload, Result>({
      id: base.id,
      docId: base.docId,
      baseRevision: base.baseRevision,
      sourceIds: base.sourceIds,
      taskType: base.taskType,
      scope: base.scope,
      contentFingerprint: base.contentFingerprint,
      model: base.model,
      templateVersion: base.templateVersion,
      protocolVersion: base.protocolVersion,
      settings: { targetLanguage: 'zh' },
      batches: [
        { id: 'batch-1', content: 'same content', payload: { index: 0 } },
        { id: 'batch-2', content: 'same content', payload: { index: 1 } },
      ],
    });
    expect(distinctTask.batches[0]?.cacheKey).not.toBe(distinctTask.batches[1]?.cacheKey);
    await store.saveTask(distinctTask);
    const authorization = new DocumentAiAuthorization('doc-1');
    authorization.enable(['source-1']);
    const runBatch = vi.fn(async (_task, batch: Readonly<(typeof distinctTask.batches)[number]>) => ({
      translated: `result-${batch.payload.index}`,
    }));

    const completed = await new LongTaskRunner(store).continueTask(distinctTask.id, authorization, runBatch);
    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(completed.batches.map(batch => batch.result?.translated)).toEqual(['result-0', 'result-1']);
  });

  it('撤回授权会即时 abort 正在运行的长任务批次', async () => {
    const store = new MemoryStore();
    const task = await makeTask();
    await store.saveTask(task);
    const authorization = new DocumentAiAuthorization('doc-1');
    authorization.enable(['source-1']);
    let receivedSignal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const runBatch = vi.fn(async (_task, _batch, signal: AbortSignal): Promise<Result> => {
      receivedSignal = signal;
      started?.();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      throw new Error('unreachable');
    });
    const running = new LongTaskRunner(store).continueTask(task.id, authorization, runBatch);
    await startedPromise;
    authorization.revoke();

    const paused = await running;
    expect(receivedSignal?.aborted).toBe(true);
    expect(paused.status).toBe('paused');
    expect(paused.batches[0]?.status).toBe('paused');
    expect(runBatch).toHaveBeenCalledTimes(1);
  });
});

describe('全文切块', () => {
  it('预算切分不拆开代理对或组合字形', () => {
    const chunks = chunkText('A😀éB', 2);
    expect(chunks.map(chunk => chunk.text)).toEqual(['A😀', 'éB']);
    expect(chunks.map(chunk => chunk.graphemeCount)).toEqual([2, 2]);
    expect(chunks.map(chunk => chunk.text).join('')).toBe('A😀éB');
  });

  it('预算允许时优先在最靠后的段落边界切分', () => {
    const chunks = chunkText('第一段\n第二段\n第三段', 7);
    expect(chunks.map(chunk => chunk.text).join('')).toBe('第一段\n第二段\n第三段');
    expect(chunks.every(chunk => chunk.graphemeCount <= 7)).toBe(true);
    expect(chunks[0]?.text.endsWith('\n')).toBe(true);
  });
});
