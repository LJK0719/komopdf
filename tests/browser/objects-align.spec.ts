import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function shapesPdf(three = false): Buffer {
  const stream = three
    ? 'q 1 0 0 rg 20 30 30 40 re f Q\nq 0 0 1 rg 70 110 45 35 re f Q\nq 0 0.6 0 rg 240 185 30 30 re f Q'
    : 'q 1 0 0 rg 20 30 30 40 re f Q\nq 0 0 1 rg 130 110 45 35 re f Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('real WASM aligns multiple native PDF objects in one transaction and preserves it after save', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'align.pdf', mimeType: 'application/pdf', buffer: shapesPdf() });
  const shapes = page.locator('.object-hitbox[data-object-type="path"]');
  await expect(shapes).toHaveCount(2, { timeout: 60_000 });
  const x = async (index: number) => shapes.nth(index).evaluate(element => parseFloat((element as HTMLElement).style.left));
  const before = [await x(0), await x(1)];
  expect(Math.abs(before[0]! - before[1]!)).toBeGreaterThan(50);
  await shapes.nth(0).click();
  await shapes.nth(1).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Align left', exact: true }).click();
  await expect.poll(async () => Math.abs((await x(0)) - (await x(1)))).toBeLessThan(0.1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => Math.abs((await x(0)) - (await x(1)))).toBeGreaterThan(50);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => Math.abs((await x(0)) - (await x(1)))).toBeLessThan(0.1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  page.once('dialog', async dialog => { page.once('dialog', discard => discard.accept()); await dialog.dismiss(); });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'aligned.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(shapes).toHaveCount(2, { timeout: 60_000 });
  await expect.poll(async () => Math.abs((await x(0)) - (await x(1)))).toBeLessThan(0.1);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('real WASM crops a page using its native CropBox and restores it through history', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'crop.pdf', mimeType: 'application/pdf', buffer: shapesPdf() });
  const canvas = page.locator('.pdf-canvas');
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  const width = () => canvas.evaluate(element => (element as HTMLCanvasElement).width);
  const before = await width();
  await page.getByText('Insert & format', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'X (pt)', exact: true }).fill('10');
  await page.getByRole('spinbutton', { name: 'Y (pt)', exact: true }).fill('10');
  await page.getByRole('spinbutton', { name: 'Width (pt)', exact: true }).fill('260');
  await page.getByRole('spinbutton', { name: 'Height (pt)', exact: true }).fill('260');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Crop page to box' }).click();
  await expect.poll(width).toBeLessThan(before);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(width).toBe(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(width).toBeLessThan(before);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  page.once('dialog', async dialog => { page.once('dialog', discard => discard.accept()); await dialog.dismiss(); });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'cropped.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect.poll(width).toBeLessThan(before);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('real WASM distributes three vector objects by center, then saves their geometry', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'spacing.pdf', mimeType: 'application/pdf', buffer: shapesPdf(true) });
  const shapes = page.locator('.object-hitbox[data-object-type="path"]');
  await expect(shapes).toHaveCount(3, { timeout: 60_000 });
  const x = (index: number) => shapes.nth(index).evaluate(element => parseFloat((element as HTMLElement).style.left));
  const before = await x(1);
  await shapes.nth(0).click();
  await shapes.nth(1).click({ modifiers: ['Shift'] });
  await shapes.nth(2).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Distribute horizontally' }).click();
  await expect.poll(() => x(1)).toBeGreaterThan(before + 30);
  const after = await x(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => x(1)).toBeCloseTo(before, 1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => x(1)).toBeCloseTo(after, 1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  page.once('dialog', async dialog => { page.once('dialog', discard => discard.accept()); await dialog.dismiss(); });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'spaced.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(shapes).toHaveCount(3, { timeout: 60_000 });
  await expect.poll(() => x(1)).toBeCloseTo(after, 1);
});
