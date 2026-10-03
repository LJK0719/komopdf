import type { EngineAdapter, Rect, RenderResult } from '@pdf-editor/contracts';

/**
 * 将渲染得到的 RGBA 像素或截图裁剪转为网关所需的 base64 编码 PNG 字符串。
 */
export async function renderResultToPngBase64(render: RenderResult): Promise<string> {
  return encodeRenderedImage(render, 'image/png');
}

export function encodeRenderedImage(render: RenderResult, mimeType: 'image/png' | 'image/jpeg'): string {
  if (typeof document === 'undefined') throw new Error('Page image encoding is unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = render.width;
  canvas.height = render.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Page image encoding is unavailable');
  const rowBytes = render.width * 4;
  const source = new Uint8Array(render.pixels);
  if (render.stride < rowBytes || source.length < render.stride * render.height) {
    throw new Error('Page image pixels are incomplete');
  }
  const pixels = new Uint8ClampedArray(rowBytes * render.height);
  for (let row = 0; row < render.height; row += 1) {
    pixels.set(source.subarray(row * render.stride, row * render.stride + rowBytes), row * rowBytes);
  }
  ctx.putImageData(new ImageData(pixels, render.width, render.height), 0, 0);
  // JPEG has no alpha; composite transparent page areas onto white before encoding.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const prefix = `data:${mimeType};base64,`;
  const dataUrl = canvas.toDataURL(mimeType, 0.8);
  if (!dataUrl.startsWith(prefix)) throw new Error('Page image encoding failed');
  return dataUrl.slice(prefix.length);
}

/**
 * 从引擎渲染选定区域并返回 base64 编码的 PNG 数据。
 */
export async function captureRegionImage(
  engine: EngineAdapter,
  docId: string,
  pageId: string,
  bounds?: Rect,
  scale = 1.5,
): Promise<string> {
  const render = await engine.render({
    docId,
    pageId,
    scale,
    ...(bounds ? { clip: bounds } : {}),
  });
  return renderResultToPngBase64(render);
}
