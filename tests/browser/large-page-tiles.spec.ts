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
  expect(await tiles.count()).toBeLessThanOrEqual(56);
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

test('an oversized visible viewport warns instead of silently leaving permanent blank edges', async ({ page }) => {
  await page.setViewportSize({ width: 5000, height: 4000 });
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'wide.pdf', mimeType: 'application/pdf', buffer: largePdf(4000, 4000) });
  await expect(page.locator('.tile-limit-warning')).toContainText('zoom out or reduce the window size', { timeout: 60_000 });
  expect(await page.locator('.pdf-tile').count()).toBeLessThanOrEqual(56);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator('.tile-limit-warning')).toHaveCount(0);
});
