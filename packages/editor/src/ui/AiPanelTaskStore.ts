import type { CompletedBatch, LongTaskRecord, LongTaskStore } from '@pdf-editor/ai-client';

const DB_NAME = 'komo_ai_tasks';
const DB_VERSION = 1;
const TASKS_STORE = 'tasks';
const BATCHES_STORE = 'completed_batches';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TASKS_STORE)) {
        const taskStore = db.createObjectStore(TASKS_STORE, { keyPath: 'id' });
        taskStore.createIndex('docId', 'docId', { unique: false });
      }
      if (!db.objectStoreNames.contains(BATCHES_STORE)) {
        db.createObjectStore(BATCHES_STORE, { keyPath: 'cacheKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

/**
 * Memory fallback when IndexedDB is unavailable (e.g. private browsing restriction or headless test).
 */
class MemoryTaskStore<Payload, Result> implements LongTaskStore<Payload, Result> {
  readonly #tasks = new Map<string, LongTaskRecord<Payload, Result>>();
  readonly #batches = new Map<string, CompletedBatch<Result>>();

  async loadTask(taskId: string): Promise<LongTaskRecord<Payload, Result> | undefined> {
    const t = this.#tasks.get(taskId);
    return t ? structuredClone(t) : undefined;
  }

  async saveTask(task: LongTaskRecord<Payload, Result>): Promise<void> {
    this.#tasks.set(task.id, structuredClone(task));
    for (const b of task.batches) {
      if (b.status === 'completed' && b.result !== undefined) {
        this.#batches.set(b.cacheKey, {
          cacheKey: b.cacheKey,
          contentHash: b.contentHash,
          result: structuredClone(b.result),
        });
      }
    }
  }

  async findCompletedBatch(cacheKey: string): Promise<CompletedBatch<Result> | undefined> {
    const b = this.#batches.get(cacheKey);
    return b ? structuredClone(b) : undefined;
  }

  async getLatestTaskForDocument(docId: string, taskType?: string): Promise<LongTaskRecord<Payload, Result> | undefined> {
    const matching: LongTaskRecord<Payload, Result>[] = [];
    for (const t of this.#tasks.values()) {
      if (t.docId === docId && (!taskType || t.taskType === taskType)) {
        matching.push(t);
      }
    }
    return matching[matching.length - 1];
  }
}

const memoryFallback = new MemoryTaskStore<any, any>();

/**
 * IndexedDB-backed task store that preserves completed batches across browser reloads.
 * Does not store credentials or authorization tokens.
 */
export class IndexedDbTaskStore<Payload, Result> implements LongTaskStore<Payload, Result> {
  async loadTask(taskId: string): Promise<LongTaskRecord<Payload, Result> | undefined> {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(TASKS_STORE, 'readonly');
        const store = tx.objectStore(TASKS_STORE);
        const req = store.get(taskId);
        req.onsuccess = () => resolve(req.result ? structuredClone(req.result) : undefined);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return memoryFallback.loadTask(taskId);
    }
  }

  async saveTask(task: LongTaskRecord<Payload, Result>): Promise<void> {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([TASKS_STORE, BATCHES_STORE], 'readwrite');
        const taskStore = tx.objectStore(TASKS_STORE);
        const batchStore = tx.objectStore(BATCHES_STORE);

        taskStore.put(structuredClone(task));
        for (const b of task.batches) {
          if (b.status === 'completed' && b.result !== undefined) {
            batchStore.put({
              cacheKey: b.cacheKey,
              contentHash: b.contentHash,
              result: structuredClone(b.result),
            });
          }
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      return memoryFallback.saveTask(task);
    }
  }

  async findCompletedBatch(cacheKey: string): Promise<CompletedBatch<Result> | undefined> {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(BATCHES_STORE, 'readonly');
        const store = tx.objectStore(BATCHES_STORE);
        const req = store.get(cacheKey);
        req.onsuccess = () => resolve(req.result ? structuredClone(req.result) : undefined);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return memoryFallback.findCompletedBatch(cacheKey);
    }
  }

  async getLatestTaskForDocument(
    docId: string,
    taskType?: string,
  ): Promise<LongTaskRecord<Payload, Result> | undefined> {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(TASKS_STORE, 'readonly');
        const store = tx.objectStore(TASKS_STORE);
        const index = store.index('docId');
        const req = index.getAll(docId);
        req.onsuccess = () => {
          const all = (req.result ?? []) as LongTaskRecord<Payload, Result>[];
          const filtered = taskType ? all.filter(t => t.taskType === taskType) : all;
          resolve(filtered[filtered.length - 1]);
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return memoryFallback.getLatestTaskForDocument(docId, taskType);
    }
  }
}
