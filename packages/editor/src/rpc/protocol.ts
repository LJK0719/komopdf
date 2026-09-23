import type { EngineAdapter, EngineErrorCode, WorkerHandshake } from '@pdf-editor/contracts';

export const ENGINE_METHODS = [
  'open',
  'describePage',
  'describeForms',
  'describeAnnotations',
  'describeOutline',
  'describeFonts',
  'render',
  'extract',
  'previewText',
  'previewTextInsert',
  'registerResource',
  'inspectFont',
  'registerFont',
  'previewTransaction',
  'confirmSave',
  'apply',
  'undo',
  'redo',
  'save',
  'close',
  'exportRecovery',
  'restoreRecovery',
] as const satisfies readonly (keyof EngineAdapter)[];

export type EngineMethod = (typeof ENGINE_METHODS)[number];

export type EngineRpcRequest =
  | { kind: 'handshake'; requestId: string }
  | { kind: 'engine-request'; requestId: string; method: EngineMethod; args: unknown[] };

export type EngineRpcFailure = {
  code: EngineErrorCode;
  message: string;
};

export type EngineRpcResponse =
  | { kind: 'handshake-result'; requestId: string; handshake: WorkerHandshake }
  | { kind: 'engine-result'; requestId: string; result: unknown }
  | { kind: 'engine-error'; requestId: string; error: EngineRpcFailure }
  | { kind: 'worker-exited'; message: string };

export type RpcMessageEvent = { data: unknown };
export type RpcFailureEvent = { message?: string };

export interface EngineWorkerClientEndpoint {
  postMessage(message: EngineRpcRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: RpcMessageEvent) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: RpcFailureEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: RpcMessageEvent) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: RpcFailureEvent) => void): void;
  terminate?(): void;
}

export interface EngineWorkerServerEndpoint {
  postMessage(message: EngineRpcResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: RpcMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: RpcMessageEvent) => void): void;
}

export function isEngineMethod(value: unknown): value is EngineMethod {
  return typeof value === 'string' && (ENGINE_METHODS as readonly string[]).includes(value);
}

export function isRpcRequest(value: unknown): value is EngineRpcRequest {
  if (!isRecord(value) || typeof value.requestId !== 'string') return false;
  if (value.kind === 'handshake') return true;
  return value.kind === 'engine-request' && isEngineMethod(value.method) && Array.isArray(value.args);
}

export function isRpcResponse(value: unknown): value is EngineRpcResponse {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'worker-exited') return typeof value.message === 'string';
  if (typeof value.requestId !== 'string') return false;
  if (value.kind === 'engine-result') return 'result' in value;
  if (value.kind === 'engine-error') {
    return isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string';
  }
  return value.kind === 'handshake-result' && isHandshake(value.handshake);
}

export function isHandshake(value: unknown): value is WorkerHandshake {
  return isRecord(value)
    && value.protocolVersion === 1
    && typeof value.coreBuildId === 'string'
    && value.coreBuildId.length > 0
    && Array.isArray(value.capabilities)
    && value.capabilities.every(isEngineMethodCapability);
}

function isEngineMethodCapability(value: unknown): boolean {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
