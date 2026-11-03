import { afterEach, describe, expect, it, vi } from 'vitest';
import { devicePixelRatio } from '../src/ui/draw-render.js';
import { observePixelRatio } from '../src/ui/use-pixel-ratio.js';

afterEach(() => vi.unstubAllGlobals());

describe('display pixel density', () => {
  it('uses a sensible server fallback and preserves fractional display density', () => {
    vi.stubGlobal('window', undefined);
    expect(devicePixelRatio()).toBe(1);
    vi.stubGlobal('window', { devicePixelRatio: 1.25 });
    expect(devicePixelRatio()).toBe(1.25);
  });

  it('rebinds the resolution query after each screen change and cleans up listeners', () => {
    const queries: EventTarget[] = [];
    const target = Object.assign(new EventTarget(), { devicePixelRatio: 1,
      matchMedia: vi.fn(() => { const query = new EventTarget(); queries.push(query); return query; }) });
    vi.stubGlobal('window', target);
    const changed = vi.fn();
    const dispose = observePixelRatio(changed);
    target.devicePixelRatio = 2;
    queries[0]!.dispatchEvent(new Event('change'));
    expect(target.matchMedia).toHaveBeenLastCalledWith('(resolution: 2dppx)');
    target.devicePixelRatio = 1.25;
    queries[0]!.dispatchEvent(new Event('change'));
    expect(changed).toHaveBeenCalledTimes(2);
    queries[1]!.dispatchEvent(new Event('change'));
    target.dispatchEvent(new Event('resize'));
    expect(changed.mock.calls).toEqual([[1], [2], [1.25]]);
    dispose();
    target.devicePixelRatio = 3;
    queries[2]!.dispatchEvent(new Event('change'));
    target.dispatchEvent(new Event('resize'));
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
