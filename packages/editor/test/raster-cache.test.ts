import { describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, RenderResult } from '@pdf-editor/contracts';
import { PageBitmapCache, clearPageBitmaps, requestPageBitmap } from '../src/ui/raster-cache.js';

const bitmap = (pixels = new ArrayBuffer(4)): RenderResult => ({ width: pixels.byteLength / 4, height: 1, stride: pixels.byteLength, pixels, format: 'rgba', revision: 0 });
const entry = (result: RenderResult, pageId = 'page', version = 1) => ({ docId: 'doc', pageId, version, result });

describe('retained display pixels', () => {
  it('evicts least recently used buffers within the byte budget', () => {
    const cache = new PageBitmapCache(8), a = bitmap(), b = bitmap(), c = bitmap();
    cache.put('a', entry(a, 'a')); cache.put('b', entry(b, 'b'));
    expect(cache.get('a')).toBe(a);
    cache.put('c', entry(c, 'c'));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(a); expect(cache.get('c')).toBe(c);
    expect(cache.bytes).toBe(8);
  });

  it('counts a shared buffer once and drops obsolete page versions', () => {
    const cache = new PageBitmapCache(8), pixels = new ArrayBuffer(8);
    cache.put('a', entry(bitmap(pixels), 'a'));
    cache.put('b', entry(bitmap(pixels), 'b'));
    expect(cache.bytes).toBe(8);
    cache.put('new-a', entry(bitmap(), 'a', 2));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('new-a')).toBeDefined();
    expect(cache.bytes).toBeLessThanOrEqual(8);
    cache.clear('doc');
    expect(cache.bytes).toBe(0); expect(cache.epoch('doc')).toBe(1);
  });

  it('does not retain a single result larger than the cache budget', () => {
    const cache = new PageBitmapCache(4);
    cache.put('large', entry(bitmap(new ArrayBuffer(8))));
    expect(cache.get('large')).toBeUndefined(); expect(cache.bytes).toBe(0);
  });

  it('shares identical render work and reuses the result for later readers', async () => {
    const result = bitmap(), render = vi.fn(async () => result);
    const engine = { render, getPageVersion: () => 1 } as unknown as EngineAdapter;
    const request = { docId: 'doc', pageId: 'page', scale: 1.25 };
    const [a, b] = await Promise.all([requestPageBitmap(engine, request, 1), requestPageBitmap(engine, request, 1)]);
    expect(a).toBe(result); expect(b).toBe(result);
    expect(await requestPageBitmap(engine, request, 1)).toBe(result);
    expect(render).toHaveBeenCalledTimes(1);
    await requestPageBitmap(engine, { ...request, clip: { x: 0, y: 0, width: 1, height: 1 } }, 1);
    expect(render).toHaveBeenCalledTimes(2);
    clearPageBitmaps(engine);
  });

  it('cannot refill a closed document cache with a late render', async () => {
    let resolve!: (result: RenderResult) => void;
    const engine = { render: () => new Promise<RenderResult>(done => { resolve = done; }), getPageVersion: () => 1 } as unknown as EngineAdapter;
    const pending = requestPageBitmap(engine, { docId: 'doc', pageId: 'page', scale: 1 }, 1);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await Promise.resolve();
    clearPageBitmaps(engine, 'doc'); resolve(bitmap());
    await rejected;
    clearPageBitmaps(engine);
  });

  it.each([undefined, 'doc'])('does not join obsolete work after clearing %s', async docId => {
    let finish!: (result: RenderResult) => void;
    const result = bitmap();
    const render = vi.fn().mockImplementationOnce(() => new Promise<RenderResult>(resolve => { finish = resolve; }))
      .mockResolvedValue(result);
    const engine = { render, getPageVersion: () => 1 } as unknown as EngineAdapter;
    const request = { docId: 'doc', pageId: 'page', scale: 1 };
    const obsolete = requestPageBitmap(engine, request, 1).catch(error => error);
    await Promise.resolve();
    clearPageBitmaps(engine, docId);
    const fresh = requestPageBitmap(engine, request, 1);
    finish(bitmap());
    await expect(fresh).resolves.toBe(result);
    expect(await obsolete).toMatchObject({ code: 'STALE_REVISION' });
    expect(render).toHaveBeenCalledTimes(2);
    expect(await requestPageBitmap(engine, request, 1)).toBe(result);
    expect(render).toHaveBeenCalledTimes(2);
    clearPageBitmaps(engine);
  });

  it('checks content identity before returning a cached frame', async () => {
    let version = 1;
    const render = vi.fn(async () => bitmap());
    const engine = { render, getPageVersion: () => version } as unknown as EngineAdapter;
    const request = { docId: 'doc', pageId: 'page', scale: 1 };
    await requestPageBitmap(engine, request, 1);
    version++;
    await expect(requestPageBitmap(engine, request, 1)).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await requestPageBitmap(engine, request, version);
    expect(render).toHaveBeenCalledTimes(2);
    clearPageBitmaps(engine);
  });
});
