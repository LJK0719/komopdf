import { describe, expect, it, vi } from 'vitest';
import type { CommitResult, PageModel } from '@pdf-editor/contracts';
import { PageCache } from '../src/rpc/page-cache.js';

const page = (id: string): PageModel => ({ id, widthPt: 600, heightPt: 800, rotation: 0, objects: [] });
const commit = (changedPageIds: string[], pageOrder = ['a', 'b']): CommitResult => ({ docId: 'doc', revision: 2, changedPageIds, pageOrder, canUndo: true, canRedo: false });

describe('derived page cache', () => {
  it('shares pending and completed descriptions; only affected pages change identity', async () => {
    const cache = new PageCache();
    const load = vi.fn(async () => page('b'));
    const version = cache.version('doc', 'b');
    const first = cache.describe('doc', 'b', load), second = cache.describe('doc', 'b', load);
    expect(first).toBe(second);
    const result = await first;
    cache.commit(commit(['a']));
    expect(cache.version('doc', 'b')).toBe(version);
    expect(await cache.describe('doc', 'b', load)).toBe(result);
    expect(load).toHaveBeenCalledTimes(1);
    cache.commit(commit(['b']));
    expect(cache.version('doc', 'b')).not.toBe(version);
    expect(await cache.describe('doc', 'b', load)).not.toBe(result);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('retains identity on page reorder but not deletion, undo or a new session', async () => {
    const cache = new PageCache();
    const original = await cache.describe('doc', 'a', async () => page('a'));
    const version = cache.version('doc', 'a');
    cache.commit(commit([], ['b', 'a']));
    expect(cache.version('doc', 'a')).toBe(version);
    expect(await cache.describe('doc', 'a', async () => page('a'))).toBe(original);
    cache.commit(commit([], ['b']));
    cache.commit(commit(['a']));
    expect(cache.version('doc', 'a')).not.toBe(version);
    const restored = cache.version('doc', 'a');
    cache.close('doc');
    expect(cache.version('doc', 'a')).not.toBe(restored);
  });

  it.each(['commit', 'close', 'clear'] as const)('does not refill invalidated entries after %s', async operation => {
    const cache = new PageCache();
    let resolve!: (value: PageModel) => void;
    const pending = cache.describe('doc', 'a', () => new Promise<PageModel>(done => { resolve = done; }));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'STALE_REVISION' });
    if (operation === 'commit') cache.commit(commit(['a']));
    else if (operation === 'close') cache.close('doc');
    else cache.clear();
    const current = await cache.describe('doc', 'a', async () => page('a'));
    resolve(page('old'));
    await rejected;
    expect(await cache.describe('doc', 'a', async () => page('wrong'))).toBe(current);
  });

  it('retains in-flight results across unrelated commits and releases failures', async () => {
    const cache = new PageCache();
    let resolve!: (value: PageModel) => void;
    const pending = cache.describe('doc', 'b', () => new Promise<PageModel>(done => { resolve = done; }));
    cache.commit(commit(['a']));
    resolve(page('b'));
    expect((await pending).id).toBe('b');
    await expect(cache.describe('doc', 'a', async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    expect((await cache.describe('doc', 'a', async () => page('a'))).id).toBe('a');
  });
});
