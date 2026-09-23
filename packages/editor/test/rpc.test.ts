import { describe, expect, it } from 'vitest';
import { EngineError, type EngineAdapter, type WorkerHandshake } from '@pdf-editor/contracts';
import { WorkerRpcClient } from '../src/rpc/client.js';
import {
  type EngineRpcRequest,
  type EngineRpcResponse,
  type EngineWorkerClientEndpoint,
  type EngineWorkerServerEndpoint,
  type RpcFailureEvent,
  type RpcMessageEvent,
} from '../src/rpc/protocol.js';
import { attachEngineWorker } from '../src/rpc/server.js';
import { WasmEngineAdapter } from '../src/rpc/wasm-engine-adapter.js';

const HANDSHAKE: WorkerHandshake = {
  protocolVersion: 1,
  coreBuildId: 'test-core',
  capabilities: [],
};

describe('Worker RPC', () => {
  it('completes handshake and correlates out-of-order responses by requestId', async () => {
    const endpoint = new ManualClientEndpoint();
    const client = new WorkerRpcClient(endpoint);

    const handshakePromise = client.handshake();
    const handshakeRequest = endpoint.requests[0]?.message;
    expect(handshakeRequest?.kind).toBe('handshake');
    endpoint.emitMessage({
      kind: 'handshake-result',
      requestId: requestIdOf(handshakeRequest),
      handshake: HANDSHAKE,
    });
    await expect(handshakePromise).resolves.toEqual(HANDSHAKE);

    const undo = client.call('undo', ['doc-a']);
    const redo = client.call('redo', ['doc-a']);
    await Promise.resolve();

    const undoRequest = endpoint.requests[1]?.message;
    const redoRequest = endpoint.requests[2]?.message;
    endpoint.emitMessage({ kind: 'engine-result', requestId: requestIdOf(redoRequest), result: 'redo-result' });
    endpoint.emitMessage({ kind: 'engine-result', requestId: requestIdOf(undoRequest), result: 'undo-result' });

    await expect(undo).resolves.toBe('undo-result');
    await expect(redo).resolves.toBe('redo-result');
    client.dispose();
  });

  it('transfers ArrayBuffer as transferable when opening document', async () => {
    const endpoint = new ManualClientEndpoint();
    const client = new WorkerRpcClient(endpoint);
    const adapter = new WasmEngineAdapter(client);

    const initialized = adapter.initialize();
    const handshakeRequest = endpoint.requests[0]?.message;
    endpoint.emitMessage({
      kind: 'handshake-result',
      requestId: requestIdOf(handshakeRequest),
      handshake: HANDSHAKE,
    });
    await initialized;

    const bytes = new ArrayBuffer(16);
    const opening = adapter.open({ kind: 'bytes', sourceId: 'source-a', name: 'a.pdf', bytes });
    await Promise.resolve();
    const openRequest = endpoint.requests[1];
    expect(openRequest?.transfer).toEqual([bytes]);
    endpoint.emitMessage({
      kind: 'engine-error',
      requestId: requestIdOf(openRequest?.message),
      error: { code: 'CORE_UNAVAILABLE', message: 'test stop' },
    });
    await expect(opening).rejects.toMatchObject({ code: 'CORE_UNAVAILABLE' });
    adapter.dispose();
  });

  it('fails all pending requests with WORKER_EXITED when worker exits', async () => {
    const endpoint = new ManualClientEndpoint();
    const client = new WorkerRpcClient(endpoint);

    const pending = client.handshake();
    endpoint.emitError('worker crashed');

    await expect(pending).rejects.toMatchObject({ code: 'WORKER_EXITED', message: 'worker crashed' });
    await expect(client.handshake()).rejects.toMatchObject({ code: 'WORKER_EXITED' });
  });

  it('executes engine calls serially without blocking subsequent calls on failure', async () => {
    const pair = createLinkedEndpoints();
    const first = deferred<never>();
    const started = deferred<void>();
    const calls: string[] = [];
    const engine = {
      undo: async () => {
        calls.push('undo');
        started.resolve(undefined);
        return first.promise;
      },
      redo: async () => {
        calls.push('redo');
        return { ok: true };
      },
    } as unknown as EngineAdapter;
    const detach = attachEngineWorker(pair.server, async () => ({ handshake: HANDSHAKE, engine }));
    const client = new WorkerRpcClient(pair.client);
    await client.handshake();

    const undo = client.call('undo', ['doc-a']);
    const redo = client.call('redo', ['doc-a']);
    await started.promise;
    expect(calls).toEqual(['undo']);

    first.reject(new EngineError('DOCUMENT_NOT_FOUND', 'missing'));
    await expect(undo).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    await expect(redo).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['undo', 'redo']);

    client.dispose();
    detach();
  });

  it('returns CORE_UNAVAILABLE without fallback when core module is missing', async () => {
    const pair = createLinkedEndpoints();
    const detach = attachEngineWorker(pair.server, async () => {
      throw new EngineError('CORE_UNAVAILABLE', '/engines/pdf-core.js does not exist');
    });
    const client = new WorkerRpcClient(pair.client);

    await expect(client.handshake()).rejects.toMatchObject({
      code: 'CORE_UNAVAILABLE',
      message: '/engines/pdf-core.js does not exist',
    });

    client.dispose();
    detach();
  });
});

class ManualClientEndpoint implements EngineWorkerClientEndpoint {
  readonly requests: { message: EngineRpcRequest; transfer: Transferable[] }[] = [];
  private readonly messageListeners = new Set<(event: RpcMessageEvent) => void>();
  private readonly errorListeners = new Set<(event: RpcFailureEvent) => void>();
  private readonly messageErrorListeners = new Set<(event: RpcFailureEvent) => void>();

  postMessage(message: EngineRpcRequest, transfer: Transferable[] = []): void {
    this.requests.push({ message, transfer });
  }

  addEventListener(type: 'message' | 'error' | 'messageerror', listener: ((event: RpcMessageEvent) => void) | ((event: RpcFailureEvent) => void)): void {
    if (type === 'message') this.messageListeners.add(listener as (event: RpcMessageEvent) => void);
    else if (type === 'error') this.errorListeners.add(listener as (event: RpcFailureEvent) => void);
    else this.messageErrorListeners.add(listener as (event: RpcFailureEvent) => void);
  }

  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: ((event: RpcMessageEvent) => void) | ((event: RpcFailureEvent) => void)): void {
    if (type === 'message') this.messageListeners.delete(listener as (event: RpcMessageEvent) => void);
    else if (type === 'error') this.errorListeners.delete(listener as (event: RpcFailureEvent) => void);
    else this.messageErrorListeners.delete(listener as (event: RpcFailureEvent) => void);
  }

  emitMessage(message: EngineRpcResponse): void {
    for (const listener of this.messageListeners) listener({ data: message });
  }

  emitError(message: string): void {
    for (const listener of this.errorListeners) listener({ message });
  }
}

function createLinkedEndpoints(): { client: EngineWorkerClientEndpoint; server: EngineWorkerServerEndpoint } {
  const clientMessageListeners = new Set<(event: RpcMessageEvent) => void>();
  const clientFailureListeners = new Set<(event: RpcFailureEvent) => void>();
  const serverMessageListeners = new Set<(event: RpcMessageEvent) => void>();

  const client: EngineWorkerClientEndpoint = {
    postMessage(message) {
      queueMicrotask(() => {
        for (const listener of serverMessageListeners) listener({ data: message });
      });
    },
    addEventListener(type, listener) {
      if (type === 'message') clientMessageListeners.add(listener as (event: RpcMessageEvent) => void);
      else clientFailureListeners.add(listener as (event: RpcFailureEvent) => void);
    },
    removeEventListener(type, listener) {
      if (type === 'message') clientMessageListeners.delete(listener as (event: RpcMessageEvent) => void);
      else clientFailureListeners.delete(listener as (event: RpcFailureEvent) => void);
    },
  };

  const server: EngineWorkerServerEndpoint = {
    postMessage(message) {
      queueMicrotask(() => {
        for (const listener of clientMessageListeners) listener({ data: message });
      });
    },
    addEventListener(_type, listener) {
      serverMessageListeners.add(listener);
    },
    removeEventListener(_type, listener) {
      serverMessageListeners.delete(listener);
    },
  };

  return { client, server };
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestIdOf(request: EngineRpcRequest | undefined): string {
  if (!request) throw new Error('Missing test request');
  return request.requestId;
}
