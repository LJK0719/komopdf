import { EngineError, WEB_LIMITS, type EngineAdapter, type RenderRequest, type RenderResult } from '@pdf-editor/contracts';
import { renderWork, type RenderWorkOptions } from './render-work.js';

type Entry = { docId: string; pageId: string; version: number; result: RenderResult };

/** Bounds retained RGBA buffers; mounted canvases retain their existing visible-page lifecycle. */
export class PageBitmapCache {
  private static nextGeneration = 0;
  readonly generation = PageBitmapCache.nextGeneration++;
  private entries = new Map<string, Entry>();
  private buffers = new Map<ArrayBuffer, { bytes: number; references: number }>();
  private epochs = new Map<string, number>();
  private retainedBytes = 0;
  constructor(private readonly budget = WEB_LIMITS.bitmapCacheBytes) {}
  get bytes(): number { return this.retainedBytes; }
  epoch(docId: string): number { return this.epochs.get(docId) ?? 0; }

  get(key: string): RenderResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.result;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    const buffer = this.buffers.get(entry.result.pixels)!;
    if (--buffer.references === 0) {
      this.retainedBytes -= buffer.bytes;
      this.buffers.delete(entry.result.pixels);
    }
  }

  put(key: string, entry: Entry): void {
    this.remove(key);
    for (const [other, cached] of this.entries) {
      if (cached.docId === entry.docId && cached.pageId === entry.pageId && cached.version !== entry.version) this.remove(other);
    }
    const bytes = entry.result.pixels.byteLength;
    if (bytes > this.budget) return;
    let buffer = this.buffers.get(entry.result.pixels);
    if (!buffer) {
      buffer = { bytes, references: 0 }; this.buffers.set(entry.result.pixels, buffer); this.retainedBytes += bytes;
    }
    buffer.references++;
    this.entries.set(key, entry);
    while (this.retainedBytes > this.budget) this.remove(this.entries.keys().next().value!);
  }

  clear(docId?: string): void {
    if (docId !== undefined) this.epochs.set(docId, this.epoch(docId) + 1);
    for (const [key, entry] of this.entries) if (docId === undefined || entry.docId === docId) this.remove(key);
  }
}

const caches = new WeakMap<EngineAdapter, PageBitmapCache>();
function cacheFor(engine: EngineAdapter): PageBitmapCache {
  let cache = caches.get(engine);
  if (!cache) { cache = new PageBitmapCache(); caches.set(engine, cache); }
  return cache;
}

export function clearPageBitmaps(engine: EngineAdapter, docId?: string): void {
  const cache = caches.get(engine);
  cache?.clear(docId);
  if (docId === undefined) caches.delete(engine);
}

export function requestPageBitmap(engine: EngineAdapter, request: RenderRequest, version: number, options: RenderWorkOptions = {}): Promise<RenderResult> {
  if (options.signal?.aborted) return Promise.reject(new DOMException('Rendering cancelled', 'AbortError'));
  const cache = cacheFor(engine), epoch = cache.epoch(request.docId);
  const clip = request.clip;
  const key = JSON.stringify([cache.generation, request.docId, request.pageId, version, epoch, request.scale,
    clip ? [clip.x, clip.y, clip.width, clip.height] : null]);
  const current = () => caches.get(engine) === cache && cache.epoch(request.docId) === epoch &&
    (engine.getPageVersion?.(request.docId, request.pageId) ?? version) === version;
  if (!current()) return Promise.reject(new EngineError('STALE_REVISION', 'Page changed before rendering'));
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  return renderWork(engine, async signal => {
    if (!current()) throw new EngineError('STALE_REVISION', 'Page changed before rendering');
    const result = await engine.render(request, { signal });
    if (signal.aborted) throw new DOMException('Rendering cancelled', 'AbortError');
    if (!current()) throw new EngineError('STALE_REVISION', 'Page changed while rendering');
    if (engine.getPageVersion || result.revision === version) cache.put(key, { docId: request.docId, pageId: request.pageId, version, result });
    return result;
  }, { ...options, key: `raster:${key}` });
}
