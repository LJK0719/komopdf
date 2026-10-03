import { EngineError, WEB_LIMITS, type ConversionRequest, type ConversionProgress, type ConvertedDocument, type DocumentInfo, type EngineAdapter, type PageModel } from '@pdf-editor/contracts';
import { readingRegions } from './reading-order.js';

export const BROWSER_EXPORT_LIMITS = Object.freeze({ pageInstances: 200, bufferedBytes: 64 * 1024 * 1024, htmlBytes: 16 * 1024 * 1024 });
const exportMemoryError = () => new EngineError('RESOURCE_LIMIT', 'Browser export would exceed its memory budget. Export fewer pages, lower DPI, or use the desktop app.');

export function conversionPages(input: string, total: number, current: number, maxInstances = Infinity): number[] {
  const value = input.trim().toLowerCase();
  if (!value || value === 'all') {
    if (total > maxInstances) throw exportMemoryError();
    return Array.from({ length: total }, (_, index) => index);
  }
  if (value === 'current') return [current];
  const result: number[] = [];
  for (const part of value.split(/[,，]/)) {
    const match = part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!match) throw new Error('Use page numbers or ranges, for example 1-3,5');
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end < 1 || start > total || end > total) throw new Error('Page range is outside the document');
    if (result.length + Math.abs(end - start) + 1 > maxInstances) throw exportMemoryError();
    const step = start <= end ? 1 : -1;
    for (let page = start; ; page += step) { result.push(page - 1); if (page === end) break; }
  }
  return result;
}

export function pageText(page: PageModel): string {
  return readingRegions(page).map(region => region.text).join('\n\n');
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const dataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
});

export async function convertInBrowser(engine: EngineAdapter, document: DocumentInfo, name: string,
  request: ConversionRequest, progress: (value: ConversionProgress) => void, signal: AbortSignal): Promise<ConvertedDocument> {
  if (request.format === 'docx') throw new EngineError('UNSUPPORTED_CAPABILITY', 'Word conversion is available in the desktop app');
  if (!request.pageIndices.length || request.pageIndices.length > BROWSER_EXPORT_LIMITS.pageInstances) throw exportMemoryError();
  const limit = request.format === 'html' ? BROWSER_EXPORT_LIMITS.htmlBytes : BROWSER_EXPORT_LIMITS.bufferedBytes;
  let retainedBytes = 0;
  const reserve = (bytes: number) => {
    if (bytes > limit - retainedBytes) throw exportMemoryError();
    retainedBytes += bytes;
  };
  reserve(2048 + name.length * 6);
  const files: Record<string, Uint8Array> = {}, pages: string[] = [];
  const warnings: ConvertedDocument['warnings'] = [];
  const notify = (completed: number, stage = 'converting') => progress({ jobId: request.jobId, completed,
    total: request.pageIndices.length, progress: completed / request.pageIndices.length, stage });
  let output: ArrayBuffer | undefined;
  let extension: string = request.format === 'jpeg' ? 'jpg' : request.format;
  let mimeType = request.format === 'txt' ? 'text/plain;charset=utf-8' : request.format === 'html' ? 'text/html;charset=utf-8' : `image/${request.format}`;
  for (let index = 0; index < request.pageIndices.length; index++) {
    signal.throwIfAborted();
    const pageIndex = request.pageIndices[index]!, id = document.pageOrder[pageIndex];
    if (!id) throw new EngineError('INVALID_REQUEST', 'Page range is outside the document');
    const page = await engine.describePage(document.id, id);
    const text = request.format === 'txt' || request.format === 'html' ? pageText(page) : '';
    if ((request.format === 'txt' || request.format === 'html') && !text.trim())
      warnings.push({ code: 'NO_TEXT', message: 'This page has no text layer. Run OCR in the desktop app to extract scanned text.', pageIndices: [pageIndex] });
    if (request.format === 'txt') { reserve(text.length * 3 + 3); pages.push(text); }
    else {
      const scale = request.dpi / 72;
      if (Math.ceil(page.widthPt * scale) * Math.ceil(page.heightPt * scale) > WEB_LIMITS.renderPixels)
        throw new EngineError('RESOURCE_LIMIT', 'This resolution exceeds the browser image budget. Choose a lower DPI or export in the desktop app.');
      const render = await engine.render({ docId: document.id, pageId: id, scale });
      signal.throwIfAborted();
      const canvas = new OffscreenCanvas(render.width, render.height), context = canvas.getContext('2d');
      if (!context) throw new Error('Image encoding is unavailable');
      try {
        context.putImageData(new ImageData(new Uint8ClampedArray(render.pixels), render.width, render.height), 0, 0);
        const blob = await canvas.convertToBlob({ type: request.format === 'jpeg' ? 'image/jpeg' : 'image/png', quality: request.quality / 100 });
        signal.throwIfAborted();
        if (request.format === 'html') {
          // Account for base64 expansion and escaped Unicode before allocating either.
          reserve(4 * Math.ceil(blob.size / 3) + text.length * 6 + 512);
          pages.push(`<section><img src="${await dataUrl(blob)}" alt="Page ${pageIndex + 1}" width="${Math.round(page.widthPt)}" height="${Math.round(page.heightPt)}"><details><summary>Page ${pageIndex + 1} — text</summary><pre>${escapeHtml(text)}</pre></details></section>`);
        } else {
          reserve(blob.size + 256); // Includes ZIP record/name overhead.
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (request.pageIndices.length === 1) output = bytes.buffer;
          else files[`${String(index + 1).padStart(3, '0')}-page-${pageIndex + 1}.${extension}`] = bytes;
        }
      } finally { canvas.width = 1; canvas.height = 1; }
    }
    notify(index + 1);
  }
  signal.throwIfAborted();
  if (request.format === 'txt') output = new TextEncoder().encode(pages.join('\n\f\n')).buffer;
  else if (request.format === 'html') output = new TextEncoder().encode(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)}</title><style>body{margin:0;padding:24px;background:#e9eceb;font-family:system-ui}section{width:max-content;max-width:100%;margin:0 auto 24px;background:white;box-shadow:0 1px 5px #0002}img{display:block;max-width:100%;height:auto}details{padding:12px}pre{white-space:pre-wrap;max-width:80ch}@media print{body{padding:0;background:white}section{break-after:page;box-shadow:none;margin:0}details{display:none}}</style><body>${pages.join('\n')}</body></html>`).buffer;
  else if (request.pageIndices.length > 1) {
    const { zipSync } = await import('fflate');
    signal.throwIfAborted();
    output = zipSync(files, { level: 0 }).buffer as ArrayBuffer;
    extension = 'zip'; mimeType = 'application/zip';
  }
  if (!output) throw new Error('No pages were selected');
  notify(request.pageIndices.length, 'completed');
  return { kind: 'bytes', bytes: output, jobId: request.jobId, extension, mimeType, warnings, pageIndices: request.pageIndices };
}
