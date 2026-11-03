import { describe, expect, it, vi } from 'vitest';
import { WEB_LIMITS, type EngineAdapter, type PageModel, type RenderResult } from '@pdf-editor/contracts';
import { matchesPageRender, pageRenderGeometry, renderPage, tileClip } from '../src/ui/draw-render.js';

const page: PageModel = { id: 'page-1', widthPt: 2000, heightPt: 3000, rotation: 0, objects: [] };
const small: RenderResult = { width: 1000, height: 1500, stride: 4000, format: 'rgba', pixels: new ArrayBuffer(4), revision: 3 };

describe('page rendering budget and pixel density', () => {
  it('keeps logical geometry separate from the engine bitmap', async () => {
    const render = vi.fn().mockResolvedValue(small);
    const result = await renderPage({ render } as unknown as EngineAdapter, 'doc-1', page, 0.5, 3, 1);
    expect(result).toMatchObject({ width: 1000, height: 1500, zoom: 0.5, pixelRatio: 1, mode: 'full', revision: 3 });
    expect(result.bitmap).toBe(small);
    expect(render).toHaveBeenCalledWith({ docId: 'doc-1', pageId: page.id, scale: 0.5 });
  });

  it.each([1, 1.25, 2, 3])('renders at DPR %s without scaling page or editing coordinates', async pixelRatio => {
    const model = { ...page, widthPt: 612, heightPt: 792 };
    const zoom = 1.25;
    const render = vi.fn().mockImplementation(async ({ scale }) => ({ ...small,
      width: Math.ceil(model.widthPt * scale), height: Math.ceil(model.heightPt * scale) }));
    const result = await renderPage({ render } as unknown as EngineAdapter, 'doc-1', model, zoom, 3, pixelRatio);
    expect(result.width).toBe(765); expect(result.height).toBe(990);
    expect(result.bitmap?.width).toBe(Math.ceil(765 * pixelRatio));
    expect(result.bitmap?.height).toBe(Math.ceil(990 * pixelRatio));
    expect(render).toHaveBeenCalledWith({ docId: 'doc-1', pageId: page.id, scale: zoom * pixelRatio });
  });

  it('selects tiles from the physical pixel budget without allocating a full-page bitmap', async () => {
    const render = vi.fn();
    const result = await renderPage({ render } as unknown as EngineAdapter, 'doc-1', page, 0.75, 3, 2);
    expect(result).toMatchObject({ width: 1500, height: 2250, zoom: 0.75, pixelRatio: 2, mode: 'tiles', bitmap: null, revision: 3 });
    expect(result.width * result.height).toBeLessThan(WEB_LIMITS.renderPixels);
    expect(render).not.toHaveBeenCalled();
    expect(pageRenderGeometry({ ...page, widthPt: 5000, heightPt: 10 }, 1, 3, 2).mode).toBe('tiles');
  });

  it('does not confuse matching physical dimensions with matching zoom and density', async () => {
    const render = vi.fn().mockResolvedValue(small);
    const result = await renderPage({ render } as unknown as EngineAdapter, 'doc-1', page, 0.5, 3, 1);
    expect(matchesPageRender(result, 0.5, 1)).toBe(true);
    expect(matchesPageRender(result, 0.25, 2)).toBe(false);
    expect(matchesPageRender(result, 0.5, 2)).toBe(false);
    expect(matchesPageRender({ ...result, bitmap: null }, 0.5, 1)).toBe(false);
    expect(matchesPageRender(pageRenderGeometry(page, 4, 3, 2), 4, 2)).toBe(true);
  });

  it('retains the actual bitmap revision for stale-response checks', async () => {
    const render = vi.fn().mockResolvedValue({ ...small, revision: 4 });
    expect((await renderPage({ render } as unknown as EngineAdapter, 'doc-1', page, 0.5, 3, 1)).revision).toBe(4);
  });

  it('clips edge tiles to the PDF bounds and overlaps physical pixel boundaries', () => {
    for (const scale of [1.25, 1.953125, 3.814697265625, 2.5, 3.75]) {
      const first = tileClip(page, scale, 0, 0);
      const next = tileClip(page, scale, 1, 0);
      const lastColumn = Math.floor((Math.ceil(page.widthPt * scale) - 1) / 512);
      const lastRow = Math.floor((Math.ceil(page.heightPt * scale) - 1) / 512);
      const edge = tileClip(page, scale, lastColumn, lastRow);
      expect(first.x).toBe(0); expect(first.y).toBe(0);
      expect(Math.floor(next.x * scale)).toBeLessThanOrEqual(Math.ceil((first.x + first.width) * scale));
      expect(edge.x + edge.width).toBeCloseTo(page.widthPt);
      expect(edge.y + edge.height).toBeCloseTo(page.heightPt);
      const tileWidth = Math.ceil((edge.x + edge.width) * scale) - Math.floor(edge.x * scale);
      const tileHeight = Math.ceil((edge.y + edge.height) * scale) - Math.floor(edge.y * scale);
      expect(tileWidth * tileHeight).toBeLessThan(WEB_LIMITS.renderPixels);
    }
  });
});
