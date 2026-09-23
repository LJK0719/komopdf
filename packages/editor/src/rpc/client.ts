import { EngineError, WORKER_PROTOCOL_VERSION, type WorkerHandshake } from '@pdf-editor/contracts';
import {
  isRpcResponse,
  type EngineMethod,
  type EngineRpcRequest,
  type EngineWorkerClientEndpoint,
  type RpcFailureEvent,
  type RpcMessageEvent,
} from './protocol.js';

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

export class WorkerRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private requestSequence = 0;
  private handshakePromise: Promise<WorkerHandshake> | null = null;
  private exitedError: EngineError | null = null;

  private readonly onMessage = (event: RpcMessageEvent): void => {
    const message = event.data;
    if (!isRpcResponse(message)) return;
    if (message.kind === 'worker-exited') {
      this.failPending(new EngineError('WORKER_EXITED', message.message));
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);

    if (message.kind === 'engine-error') {
      pending.reject(new EngineError(message.error.code, message.error.message));
    } else if (message.kind === 'handshake-result') {
      pending.resolve(message.handshake);
    } else {
      pending.resolve(message.result);
    }
  };

  private readonly onWorkerFailure = (event: RpcFailureEvent): void => {
    this.failPending(new EngineError('WORKER_EXITED', event.message || 'PDF Worker exited'));
  };

  constructor(private readonly endpoint: EngineWorkerClientEndpoint) {
    endpoint.addEventListener('message', this.onMessage);
    endpoint.addEventListener('error', this.onWorkerFailure);
    endpoint.addEventListener('messageerror', this.onWorkerFailure);
  }

  handshake(): Promise<WorkerHandshake> {
    if (!this.handshakePromise) {
      this.handshakePromise = this.request<WorkerHandshake>({ kind: 'handshake' }).then((handshake) => {
        if (handshake.protocolVersion !== WORKER_PROTOCOL_VERSION) {
          throw new EngineError(
            'CORE_UNAVAILABLE',
            `PDF Worker protocol incompatible: requires ${WORKER_PROTOCOL_VERSION}, found ${handshake.protocolVersion}`,
          );
        }
        return handshake;
      });
    }
    return this.handshakePromise;
  }

  async call<Result>(method: EngineMethod, args: unknown[], transfer: Transferable[] = []): Promise<Result> {
    await this.handshake();
    return this.request<Result>({ kind: 'engine-request', method, args }, transfer);
  }

  dispose(): void {
    this.endpoint.removeEventListener('message', this.onMessage);
    this.endpoint.removeEventListener('error', this.onWorkerFailure);
    this.endpoint.removeEventListener('messageerror', this.onWorkerFailure);
    this.endpoint.terminate?.();
    this.failPending(new EngineError('WORKER_EXITED', 'PDF Worker closed'));
  }

  private request<Result>(
    message:
      | { kind: 'handshake' }
      | { kind: 'engine-request'; method: EngineMethod; args: unknown[] },
    transfer: Transferable[] = [],
  ): Promise<Result> {
    if (this.exitedError) return Promise.reject(this.exitedError);

    const requestId = `worker-${++this.requestSequence}`;
    const request = { ...message, requestId } as EngineRpcRequest;

    return new Promise<Result>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.endpoint.postMessage(request, transfer);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private failPending(error: EngineError): void {
    this.exitedError = error;
    this.handshakePromise = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
