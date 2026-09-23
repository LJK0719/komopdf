import { EngineError, type EngineAdapter, type EngineErrorCode, type WorkerHandshake } from '@pdf-editor/contracts';
import {
  isRpcRequest,
  type EngineMethod,
  type EngineRpcResponse,
  type EngineWorkerServerEndpoint,
  type RpcMessageEvent,
} from './protocol.js';

export type WasmCoreBinding = {
  handshake: WorkerHandshake;
  engine: EngineAdapter;
};

export type WasmCoreBindingFactory = () => Promise<WasmCoreBinding>;

export function attachEngineWorker(
  endpoint: EngineWorkerServerEndpoint,
  loadBinding: WasmCoreBindingFactory,
): () => void {
  let bindingPromise: Promise<WasmCoreBinding> | null = null;
  let executionQueue: Promise<void> = Promise.resolve();
  const getBinding = (): Promise<WasmCoreBinding> => {
    bindingPromise ??= loadBinding();
    return bindingPromise;
  };

  const onMessage = (event: RpcMessageEvent): void => {
    if (!isRpcRequest(event.data)) return;
    const request = event.data;
    executionQueue = executionQueue.then(
      () => handleRequest(endpoint, getBinding, request),
      () => handleRequest(endpoint, getBinding, request),
    );
  };

  endpoint.addEventListener('message', onMessage);
  return () => endpoint.removeEventListener('message', onMessage);
}

async function handleRequest(
  endpoint: EngineWorkerServerEndpoint,
  getBinding: () => Promise<WasmCoreBinding>,
  request: ReturnType<typeof narrowRequest>,
): Promise<void> {
  try {
    const binding = await getBinding();
    if (request.kind === 'handshake') {
      endpoint.postMessage({ kind: 'handshake-result', requestId: request.requestId, handshake: binding.handshake });
      return;
    }

    const result = await invokeEngine(binding.engine, request.method, request.args);
    endpoint.postMessage(
      { kind: 'engine-result', requestId: request.requestId, result },
      responseTransferables(request.method, result),
    );
  } catch (error) {
    endpoint.postMessage({ kind: 'engine-error', requestId: request.requestId, error: serializeError(error) });
  }
}

function narrowRequest(value: unknown) {
  if (!isRpcRequest(value)) throw new EngineError('INVALID_REQUEST', 'Invalid Worker request');
  return value;
}

async function invokeEngine(engine: EngineAdapter, method: EngineMethod, args: unknown[]): Promise<unknown> {
  const implementation = engine[method] as unknown;
  if (typeof implementation !== 'function') {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `PDF core has not implemented ${method}`);
  }
  return (implementation as (...methodArgs: unknown[]) => Promise<unknown>).apply(engine, args);
}

function responseTransferables(method: EngineMethod, result: unknown): Transferable[] {
  if (method === 'render' && isRecord(result) && result.pixels instanceof ArrayBuffer) return [result.pixels];
  if (method === 'save' && isRecord(result) && result.kind === 'bytes' && result.bytes instanceof ArrayBuffer) {
    return [result.bytes];
  }
  if (method === 'exportRecovery' && isRecord(result) && result.kind === 'bytes' && result.bytes instanceof ArrayBuffer) {
    return [result.bytes];
  }
  return [];
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
