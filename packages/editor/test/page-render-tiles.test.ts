import { describe, expect, it, vi } from 'vitest';
import { WEB_LIMITS, type EngineAdapter, type PageModel, type RenderResult } from '@pdf-editor/contracts';
import { renderPage, tileClip } from '../src/ui/draw-render.js';

const page: PageModel = { id: 'page-1', widthPt: 2000, heightPt: 3000, rotation: 0, objects: [] };
const small: RenderResult = { width: 1000, height: 1500, stride: 4000, format: 'rgba', pixels: new ArrayBuffer(4), revision: 3 };

describe('page rendering budget', () => {
  it('keeps the ordinary full-page render below the pixel limit', async () => {
    const render = vi.fn().mockResolvedValue(small);
    const result = await renderPage({ render } as unknown as EngineAdapter, 'doc-1', page, 0.5, 3);
    expect(result).toBe(small);
    expect(render).toHaveBeenCalledWith({ docId: 'doc-1', pageId: page.id, scale: 0.5 });
  });

  it('retains page geometry without ever requesting an oversized full-page bitmap', async () => {
    const render = vi.fn();
    const result = await renderPage({ render } as unknown as EngineAdapter, 'doc-1', page, 4, 3);
    expect(result.width).toBe(8000);
    expect(result.height).toBe(12000);
    expect(result.pixels.byteLength).toBe(0);
    expect(result.revision).toBe(3);
    expect(result.width * result.height).toBeGreaterThan(WEB_LIMITS.renderPixels);
    expect(render).not.toHaveBeenCalled();
  });

  it('clips edge tiles to the PDF bounds and overlaps pixel-rounded tile boundaries', () => {
    for (const scale of [1.25, 1.953125, 3.814697265625]) {
      const first = tileClip(page, scale, 0, 0);
      const next = tileClip(page, scale, 1, 0);
      const lastColumn = Math.floor((Math.ceil(page.widthPt * scale) - 1) / 512);
      const lastRow = Math.floor((Math.ceil(page.heightPt * scale) - 1) / 512);
      const edge = tileClip(page, scale, lastColumn, lastRow);
      expect(first.x).toBe(0);
      expect(first.y).toBe(0);
      expect(Math.floor(next.x * scale)).toBeLessThanOrEqual(Math.ceil((first.x + first.width) * scale));
      expect(edge.x + edge.width).toBeCloseTo(page.widthPt);
      expect(edge.y + edge.height).toBeCloseTo(page.heightPt);
      const tileWidth = Math.ceil((edge.x + edge.width) * scale) - Math.floor(edge.x * scale);
      const tileHeight = Math.ceil((edge.y + edge.height) * scale) - Math.floor(edge.y * scale);
      expect(tileWidth * tileHeight).toBeLessThan(WEB_LIMITS.renderPixels);
    }
  });
});
