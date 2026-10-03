import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentInfo, EngineAdapter } from '@pdf-editor/contracts';
import { BROWSER_EXPORT_LIMITS, conversionPages, convertInBrowser } from '../src/ui/document-conversion.js';

const document: DocumentInfo = { id: 'doc', revision: 0, savedRevision: 0, pageOrder: ['p'], sourceIds: ['s'],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false }, capabilities: [] };
function fixture(sizes: number[]) {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
  const canvases: { width: number; height: number }[] = [];
  vi.stubGlobal('ImageData', class {});
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) { canvases.push(this); }
    getContext() { return { putImageData() {} }; }
    async convertToBlob() { return { size: sizes.shift(), arrayBuffer }; }
  });
  const engine = {
    describePage: vi.fn(async () => ({ id: 'p', widthPt: 100, heightPt: 100, rotation: 0, objects: [] })),
    render: vi.fn(async () => ({ width: 2, height: 2, stride: 8, pixels: new ArrayBuffer(16), format: 'rgba', revision: 0 })),
  } as unknown as EngineAdapter;
  return { engine, arrayBuffer, canvases };
}
afterEach(() => vi.unstubAllGlobals());
describe('bounded browser exports', () => {
  it('rejects too many repeated page instances before rendering or expanding ranges', async () => {
    expect(() => conversionPages('1-200,1', 200, 0, BROWSER_EXPORT_LIMITS.pageInstances)).toThrow(/memory budget/);
    const { engine } = fixture([]);
    await expect(convertInBrowser(engine, document, 'test.pdf', {
      jobId: 'j', format: 'png', pageIndices: new Array(201).fill(0), dpi: 72, quality: 85,
    }, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(engine.render).not.toHaveBeenCalled();
  });
  it('counts accumulated ZIP input before retaining the next image', async () => {
    const { engine, arrayBuffer, canvases } = fixture([40 * 1024 * 1024, 40 * 1024 * 1024]);
    await expect(convertInBrowser(engine, document, 'test.pdf', {
      jobId: 'j', format: 'png', pageIndices: [0, 0], dpi: 72, quality: 85,
    }, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(canvases.every(canvas => canvas.width === 1 && canvas.height === 1)).toBe(true);
  });
  it('accounts for HTML base64 expansion before constructing a data URL', async () => {
    const { engine, arrayBuffer } = fixture([BROWSER_EXPORT_LIMITS.htmlBytes]);
    const reader = vi.fn(); vi.stubGlobal('FileReader', reader);
    await expect(convertInBrowser(engine, document, 'test.pdf', {
      jobId: 'j', format: 'html', pageIndices: [0], dpi: 72, quality: 85,
    }, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(reader).not.toHaveBeenCalled(); expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
