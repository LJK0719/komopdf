import { describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, RenderResult } from '@pdf-editor/contracts';
import { renderWork, setRenderWorkPaused } from '../src/ui/render-work.js';
import { rgbaPixels } from '../src/ui/draw-render.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('display work before the serial engine', () => {
  it('prioritizes the active page over queued neighboring pages and thumbnails', async () => {
    const engine = {} as EngineAdapter, owner = {}, order: string[] = [];
    setRenderWorkPaused(engine, owner, true);
    const run = (name: string) => async () => { order.push(name); return name; };
    const thumbnail = renderWork(engine, run('thumbnail'), { priority: 'thumbnail' });
    const page = renderWork(engine, run('page'), { priority: 'page' });
    const active = renderWork(engine, run('active'));
    await Promise.resolve();
    expect(order).toEqual([]);
    setRenderWorkPaused(engine, owner, false);
    await Promise.all([thumbnail, page, active]);
    expect(order).toEqual(['active', 'page', 'thumbnail']);
  });

  it('drops superseded targets without queuing them into an already busy engine', async () => {
    const engine = {} as EngineAdapter, first = deferred<number>();
    const calls: number[] = [];
    const oldController = new AbortController();
    const old = renderWork(engine, () => { calls.push(0); return first.promise; }, { signal: oldController.signal }).catch(error => error.name);
    await Promise.resolve();
    oldController.abort();
    expect(await old).toBe('AbortError');
    let controller: AbortController | null = null;
    const pending: Promise<unknown>[] = [];
    for (let value = 1; value <= 100; value++) {
      controller?.abort(); controller = new AbortController();
      pending.push(renderWork(engine, async () => { calls.push(value); return value; }, { signal: controller.signal }).catch(error => error.name));
    }
    await Promise.resolve();
    expect(calls).toEqual([0]);
    first.resolve(0);
    expect((await Promise.all(pending)).at(-1)).toBe(100);
    expect(calls).toEqual([0, 100]);
  });

  it('keeps the lane occupied until an aborted in-flight call really finishes', async () => {
    const engine = {} as EngineAdapter, first = deferred<void>(), controller = new AbortController();
    const next = vi.fn(async () => 'next');
    const old = renderWork(engine, () => first.promise, { signal: controller.signal }).catch(() => undefined);
    await Promise.resolve(); controller.abort(); await old;
    const result = renderWork(engine, next);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    first.resolve();
    expect(await result).toBe('next');
  });

  it('continues after a failed current call without retries', async () => {
    const engine = {} as EngineAdapter;
    const fail = vi.fn(async () => { throw new Error('render failed'); });
    const first = renderWork(engine, fail).catch(error => error.message);
    const second = renderWork(engine, async () => 2);
    expect(await first).toBe('render failed'); expect(await second).toBe(2);
    expect(fail).toHaveBeenCalledTimes(1);
  });
});

describe('shared display consumers', () => {
  it('does not cancel a shared provider when only one consumer aborts', async () => {
    const engine = {}, done = deferred<number>(), first = new AbortController();
    let signal!: AbortSignal;
    const run = vi.fn((value: AbortSignal) => { signal = value; return done.promise; });
    const a = renderWork(engine, run, { key: 'page', signal: first.signal }).catch(error => error.name);
    const b = renderWork(engine, run, { key: 'page' });
    await Promise.resolve(); first.abort();
    expect(await a).toBe('AbortError'); expect(signal.aborted).toBe(false);
    done.resolve(7); expect(await b).toBe(7); expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancels the provider only after the final consumer leaves, retaining the lane until it ends', async () => {
    const engine = {}, done = deferred<void>(), a = new AbortController(), b = new AbortController();
    let signal!: AbortSignal;
    const run = (value: AbortSignal) => { signal = value; return done.promise; };
    const first = renderWork(engine, run, { key: 'page', signal: a.signal }).catch(() => undefined);
    const second = renderWork(engine, run, { key: 'page', signal: b.signal }).catch(() => undefined);
    await Promise.resolve(); a.abort(); b.abort(); await Promise.all([first, second]);
    expect(signal.aborted).toBe(true);
    const next = vi.fn(async () => 9);
    const fresh = renderWork(engine, next, { key: 'page' });
    await Promise.resolve(); expect(next).not.toHaveBeenCalled();
    done.resolve(); expect(await fresh).toBe(9);
  });

  it('promotes shared work and orders equal priorities by visible distance', async () => {
    const engine = {} as EngineAdapter, owner = {}, order: string[] = [];
    setRenderWorkPaused(engine, owner, true);
    const run = (name: string) => async () => { order.push(name); return name; };
    const a = renderWork(engine, run('shared'), { key: 'shared', priority: 'thumbnail' });
    const far = renderWork(engine, run('far'), { priority: 'page', distance: 8 });
    const near = renderWork(engine, run('near'), { priority: 'page', distance: 1 });
    const promoted = renderWork(engine, run('never'), { key: 'shared', priority: 'active' });
    setRenderWorkPaused(engine, owner, false);
    await Promise.all([a, far, near, promoted]);
    expect(order).toEqual(['shared', 'near', 'far']);
  });

  it('allows explicit interaction work through a background pause', async () => {
    const engine = {} as EngineAdapter, owner = {}, background = vi.fn(async () => 2);
    setRenderWorkPaused(engine, owner, true);
    const waiting = renderWork(engine, background, { priority: 'background' });
    expect(await renderWork(engine, async () => 1, { priority: 'interaction' })).toBe(1);
    expect(background).not.toHaveBeenCalled();
    setRenderWorkPaused(engine, owner, false); expect(await waiting).toBe(2);
  });
});

describe('pixel views without whole-frame copies', () => {
  it('views a native metadata-prefixed buffer directly, including an unaligned byte offset', () => {
    const bytes = new Uint8Array([99, 99, 99, 99, 99, 10, 20, 30, 255, 40, 50, 60, 255]);
    const render: RenderResult = { width: 2, height: 1, stride: 8, format: 'rgba', revision: 0, pixels: bytes.buffer, byteOffset: 5 };
    const pixels = rgbaPixels(render);
    expect(pixels.buffer).toBe(bytes.buffer); expect(pixels.byteOffset).toBe(5);
    expect([...pixels]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('removes row padding after the metadata prefix without treating either as pixels', () => {
    const bytes = new Uint8Array([99, 99, 99, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 9, 10, 11, 12, 13, 14, 15, 16, 0, 0, 0, 0]);
    const pixels = rgbaPixels({ width: 2, height: 2, stride: 12, format: 'rgba', revision: 0, pixels: bytes.buffer, byteOffset: 3 });
    expect([...pixels]).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
  });
});
