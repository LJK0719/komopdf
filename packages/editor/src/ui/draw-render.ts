import type { RenderResult } from '@pdf-editor/contracts';

export function drawRender(canvas: HTMLCanvasElement | null, render: RenderResult): void {
  if (!canvas) return;
  canvas.width = render.width;
  canvas.height = render.height;
  const context = canvas.getContext('2d');
  if (!context) return;

  const rowBytes = render.width * 4;
  let pixels: Uint8ClampedArray<ArrayBuffer>;
  if (render.stride === rowBytes) {
    pixels = new Uint8ClampedArray(render.pixels);
  } else {
    pixels = new Uint8ClampedArray(rowBytes * render.height);
    const source = new Uint8Array(render.pixels);
    for (let row = 0; row < render.height; row += 1) {
      pixels.set(source.subarray(row * render.stride, row * render.stride + rowBytes), row * rowBytes);
    }
  }
  context.putImageData(new ImageData(pixels, render.width, render.height), 0, 0);
}
