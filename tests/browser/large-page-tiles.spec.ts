import { expect, test } from '@playwright/test';

function largePdf(widthPt = 2000, heightPt = 3000): Buffer {
  const stream = 'BT /F1 22 Tf 30 2400 Td (Large page text) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('large PDF renders visible tiles while keeping page selection aligned through zoom and scroll', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'large.pdf', mimeType: 'application/pdf', buffer: largePdf() });
  const tiles = page.locator('.pdf-tile');
  await expect.poll(async () => tiles.evaluateAll(elements => elements.some(element =>
    (element as HTMLCanvasElement).width > 0 && (element as HTMLCanvasElement).height > 0)), { timeout: 60_000 }).toBe(true);
  await expect(page.locator('.pdf-canvas')).toHaveCount(0);
  await expect(page.locator('.page-wrap')).toHaveJSProperty('clientWidth', 2500);
  await expect(page.locator('.page-wrap')).toHaveJSProperty('clientHeight', 3750);
  expect(await tiles.count()).toBeGreaterThan(0);
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  const hitbox = page.locator('.object-hitbox[data-object-type="text"]');
  await hitbox.scrollIntoViewIfNeeded();
  await hitbox.click();
  await expect(hitbox).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => tiles.evaluateAll(elements => elements.some(element =>
    (element as HTMLCanvasElement).width > 0 && (element as HTMLCanvasElement).height > 0))).toBe(true);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);

  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(page.locator('.pdf-canvas')).toHaveCount(1);
  await expect(page.locator('.pdf-tile')).toHaveCount(0);
  await expect(hitbox).toHaveAttribute('aria-pressed', 'true');
});

test('a large visible viewport paints beyond 56 tiles and releases offscreen backing stores', async ({ page }) => {
  await page.setViewportSize({ width: 5000, height: 4000 });
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'wide.pdf', mimeType: 'application/pdf', buffer: largePdf(4000, 4000) });
  const tiles = page.locator('.pdf-tile');
  await expect.poll(() => tiles.count()).toBeGreaterThan(56);
  await expect.poll(() => tiles.evaluateAll(nodes => nodes.every(node => (node as HTMLCanvasElement).width > 0))).toBe(true);
  expect(await page.evaluate(() => {
    const stage = document.querySelector('.canvas-stage')!.getBoundingClientRect();
    const wrapper = document.querySelector('.page-wrap')!.getBoundingClientRect();
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.pdf-tile')];
    Object.assign(window, { largeViewportCanvases: canvases });
    const rects = canvases.map(canvas => canvas.getBoundingClientRect());
    const left = Math.max(stage.left, wrapper.left) + 8, right = Math.min(stage.right, wrapper.right) - 24;
    const top = Math.max(stage.top, wrapper.top) + 8, bottom = Math.min(stage.bottom, wrapper.bottom) - 24;
    return [[left, top], [right, top], [left, bottom], [right, bottom]].every(([x, y]) =>
      rects.some(rect => x! >= rect.left && x! < rect.right && y! >= rect.top && y! < rect.bottom));
  })).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => tiles.count()).toBeLessThan(20);
  expect(await page.evaluate(() => (window as any).largeViewportCanvases
    .filter((canvas: HTMLCanvasElement) => !canvas.isConnected)
    .every((canvas: HTMLCanvasElement) => canvas.width === 0 && canvas.height === 0))).toBe(true);
  await expect(page.getByText('Unable to display this page.', { exact: true })).toHaveCount(0);
});
