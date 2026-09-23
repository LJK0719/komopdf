import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbRecoveryStore } from '../src/host/web-host-adapter.js';

const originalIndexedDb = globalThis.indexedDB;

afterEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb });
});

describe('IndexedDB recovery store', () => {
  it('fails if transaction aborts after request succeeds', async () => {
    const operationRequest = {} as IDBRequest<unknown>;
    const transaction = {
      error: null,
      objectStore: () => ({ put: () => operationRequest }),
    } as unknown as IDBTransaction;
    const database = {
      transaction: () => transaction,
    } as unknown as IDBDatabase;
    const openRequest = { result: database } as IDBOpenDBRequest;
    const fakeIndexedDb = {
      open: () => {
        queueMicrotask(() => {
          openRequest.onsuccess?.(new Event('success') as unknown as Event & { target: IDBRequest });
          queueMicrotask(() => {
            operationRequest.onsuccess?.(new Event('success') as unknown as Event & { target: IDBRequest });
            transaction.onabort?.(new Event('abort') as unknown as Event & { target: IDBTransaction });
          });
        });
        return openRequest;
      },
    } as unknown as IDBFactory;
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: fakeIndexedDb });

    const store = new IndexedDbRecoveryStore();
    await expect(store.write('session-a', Uint8Array.of(1, 2, 3))).rejects.toThrow('Recovery store transaction aborted');
  });
});
