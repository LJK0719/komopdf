import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { finishSse, sendEvent } from '../src/sse.js';

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  readonly frames: string[] = [];
  acceptWrite = false;

  write(frame: string): boolean {
    this.frames.push(frame);
    return this.acceptWrite;
  }

  end(): void {
    this.writableEnded = true;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

function asResponse(response: FakeResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

describe('SSE backpressure lifecycle', () => {
  it('waits for drain when the downstream write buffer is full', async () => {
    const response = new FakeResponse();
    const controller = new AbortController();
    let settled = false;
    const pending = sendEvent(asResponse(response), { type: 'progress', message: 'working' }, controller.signal)
      .then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    response.emit('drain');
    await pending;
    expect(settled).toBe(true);
  });

  it('keeps the lifecycle open until the response finish event', async () => {
    const response = new FakeResponse();
    const controller = new AbortController();
    let settled = false;
    const pending = finishSse(asResponse(response), controller.signal).then(() => { settled = true; });
    await Promise.resolve();
    expect(response.writableEnded).toBe(true);
    expect(settled).toBe(false);
    response.writableFinished = true;
    response.emit('finish');
    await pending;
    expect(settled).toBe(true);
  });
});
