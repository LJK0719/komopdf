import { EngineError, type EngineAdapter, type EngineErrorCode, type WorkerHandshake } from '@pdf-editor/contracts';
import {
  isRpcRequest,
  type EngineMethod,
  type EngineRpcRequest,
  type EngineRpcResponse,
  type EngineWorkerServerEndpoint,
  type RpcMessageEvent,
} from './protocol.js';

export type WasmCoreBinding = {
  handshake: WorkerHandshake;
  engine: EngineAdapter;
};

export type WasmCoreBindingFactory = () => Promise<WasmCoreBinding>;
type QueuedRequest = Exclude<EngineRpcRequest, { kind: 'engine-cancel' }>;

export function attachEngineWorker(
  endpoint: EngineWorkerServerEndpoint,
  loadBinding: WasmCoreBindingFactory,
): () => void {
  let bindingPromise: Promise<WasmCoreBinding> | null = null;
  let executionQueue: Promise<void> = Promise.resolve();
  const renders = new Map<string, { controller: AbortController; docId: unknown }>();
  const getBinding = (): Promise<WasmCoreBinding> => {
    bindingPromise ??= loadBinding();
    return bindingPromise;
  };

  const onMessage = (event: RpcMessageEvent): void => {
    if (!isRpcRequest(event.data)) {
      if (isRecord(event.data) && event.data.kind === 'engine-request' && typeof event.data.requestId === 'string') {
        endpoint.postMessage({ kind: 'engine-error', requestId: event.data.requestId,
          error: { code: 'UNSUPPORTED_CAPABILITY', message: 'PDF worker does not recognize this engine method' } });
      }
      return;
    }
    const request = event.data;
    if (request.kind === 'engine-cancel') {
      // Never queue cancellation behind the render that is awaiting its next time slice.
      renders.get(request.requestId)?.controller.abort();
      return;
    }
    if (request.kind === 'engine-request' && ['close', 'apply', 'undo', 'redo'].includes(request.method)) {
      const target = request.args[0];
      const docId = request.method === 'apply' && isRecord(target) ? target.docId : target;
      if (typeof docId === 'string') {
        for (const render of renders.values()) if (render.docId === docId) render.controller.abort();
      }
    }
    const controller = request.kind === 'engine-request' && request.method === 'render' ? new AbortController() : undefined;
    if (controller) {
      const input = request.kind === 'engine-request' ? request.args[0] : undefined;
      renders.set(request.requestId, { controller, docId: isRecord(input) ? input.docId : undefined });
    }
    const execute = async (): Promise<void> => {
      try {
        await handleRequest(endpoint, getBinding, request, controller?.signal);
      } finally {
        if (controller) renders.delete(request.requestId);
      }
    };
    executionQueue = executionQueue.then(execute, execute);
  };

  endpoint.addEventListener('message', onMessage);
  return () => {
    endpoint.removeEventListener('message', onMessage);
    for (const { controller } of renders.values()) controller.abort();
  };
}

async function handleRequest(
  endpoint: EngineWorkerServerEndpoint,
  getBinding: () => Promise<WasmCoreBinding>,
  request: QueuedRequest,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (signal?.aborted) throw cancelled();
    const binding = await getBinding();
    if (request.kind === 'handshake') {
      endpoint.postMessage({ kind: 'handshake-result', requestId: request.requestId, handshake: binding.handshake });
      return;
    }
    if (signal?.aborted) throw cancelled();
    if (request.method === 'render' && request.args.length !== 1) {
      throw new EngineError('INVALID_REQUEST', 'Render requires one request; cancellation is sent separately');
    }
    const args = signal ? [request.args[0], { signal }] : request.args;
    const result = await invokeEngine(binding.engine, request.method, args);
    if (signal?.aborted) throw cancelled();
    endpoint.postMessage(
      { kind: 'engine-result', requestId: request.requestId, result },
      responseTransferables(request.method, result),
    );
  } catch (error) {
    endpoint.postMessage({ kind: 'engine-error', requestId: request.requestId, error: serializeError(error) });
  }
}

async function invokeEngine(engine: EngineAdapter, method: EngineMethod, args: unknown[]): Promise<unknown> {
  const implementation = engine[method] as unknown;
  if (typeof implementation !== 'function') {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `PDF core has not implemented ${method}`);
  }
  return (implementation as (...methodArgs: unknown[]) => Promise<unknown>).apply(engine, args);
}

function responseTransferables(method: EngineMethod, result: unknown): Transferable[] {
  // Render buffers are owned by this response, not retained in a worker bitmap cache.
  if (method === 'render' && isRecord(result) && result.pixels instanceof ArrayBuffer) return [result.pixels];
  if ((method === 'save' || method === 'extractPages') && isRecord(result) && result.kind === 'bytes' && result.bytes instanceof ArrayBuffer) {
    return [result.bytes];
  }
  if (method === 'exportRecovery' && isRecord(result) && result.kind === 'bytes' && result.bytes instanceof ArrayBuffer) {
    return [result.bytes];
  }
  return [];
}

function cancelled(): EngineError {
  return new EngineError('CANCELLED', 'PDF rendering was cancelled');
}

function serializeError(error: unknown): { code: EngineErrorCode; message: string } {
  if (error instanceof EngineError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'CORE_UNAVAILABLE', message: error.message };
  return { code: 'CORE_UNAVAILABLE', message: 'PDF core is unavailable' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function notifyWorkerExit(endpoint: EngineWorkerServerEndpoint, message = 'PDF Worker exited'): void {
  const response: EngineRpcResponse = { kind: 'worker-exited', message };
  endpoint.postMessage(response);
}
