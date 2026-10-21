import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function fixture(): Buffer {
  const stream = 'BT /F1 18 Tf 20 240 Td (Original text) Tj ET\nq 40 0 0 20 180 20 cm /Im1 Do Q';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /ASCIIHexDecode /Length 25 >>\nstream\nff000000ff000000ffffffff>\nendstream'];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function open(page: Page, bytes = fixture()) {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'text-frame.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.document-pages .page-wrap')).toHaveCount(1, { timeout: 60_000 });
  const zoom = page.getByLabel('Zoom', { exact: true });
  await zoom.fill('100%'); await zoom.press('Enter');
  await expect(zoom).toHaveValue('100%');
}

async function edit(page: Page) {
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
}

async function resize(page: Page, handle: string, dx: number, dy: number) {
  const target = page.locator(`.selection-handle[data-handle="scale-${handle}"]`);
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
}

async function firstGlyphHeight(page: Page): Promise<number> {
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.locator('.pdf-character').first()).toBeVisible();
  return (await page.locator('.pdf-character').first().boundingBox())!.height;
}

test('increasing the frame of unchanged original PDF text does not scale glyphs', async ({ page }) => {
  await open(page);
  await firstGlyphHeight(page);
  const before = await page.locator('.pdf-canvas').first().evaluate(element => (element as HTMLCanvasElement).toDataURL());
  await edit(page);
  const object = page.locator('.object-hitbox[data-object-type="text"]').first();
  await object.click();
  await resize(page, 's', 0, 50);
  await resize(page, 's', 0, 20);
  await expect(page.locator('.save-state')).toHaveText('Unsaved changes');
  await firstGlyphHeight(page);
  const after = await page.locator('.pdf-canvas').first().evaluate(element => (element as HTMLCanvasElement).toDataURL());
  expect(after).toBe(before);
  await page.screenshot({ path: 'tmp/browser/text-frame-original.png' });
});

test('narrowing a text frame wraps content without changing its font size', async ({ page }) => {
  await open(page); await edit(page);
  await page.locator('.object-hitbox[data-object-type="text"]').first().click();
  await resize(page, 's', 0, 100);
  const width = (await page.locator('.selection-box').boundingBox())!.width;
  await resize(page, 'e', -30, 0);
  await expect.poll(async () => (await page.locator('.selection-box').boundingBox())?.width ?? width).toBeLessThan(width - 20);
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  await expect(page.getByRole('textbox', { name: 'Page text', exact: true })).toHaveText('Original text');
  await expect(page.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('18');
});

test('image handles still scale image content instead of using text layout', async ({ page }) => {
  await open(page); await edit(page);
  const image = page.locator('.object-hitbox[data-object-type="image"]').first();
  await image.click();
  const height = (await image.boundingBox())!.height;
  await resize(page, 's', 0, 20);
  await expect.poll(async () => (await image.boundingBox())?.height ?? 0).toBeGreaterThan(height + 15);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect.poll(async () => (await image.boundingBox())?.height ?? 0).toBeCloseTo(height, 1);
});

test('appending explicit lines commits complete source text before resizing', async ({ page }) => {
  await open(page); await edit(page);
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('Original text\nAdded first line\nAdded second line');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  await expect(input).toHaveText('Original text\nAdded first line\nAdded second line', { useInnerText: true });
  await page.screenshot({ path: 'tmp/browser/text-frame-appended.png' });
});

test('undoing a reopened flow resize refreshes retained continuation thumbnails', async ({ page }) => {
  await open(page); await edit(page);
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('Original text '.repeat(45).trim());
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await expect.poll(() => page.locator('.page-chip').count()).toBeGreaterThan(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  const chooser = page.waitForEvent('filechooser'); await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'saved-flow.pdf', mimeType: 'application/pdf', buffer: bytes });
  await edit(page);
  await page.getByRole('button', { name: 'Open page 1', exact: true }).click();
  const thumbnail = page.locator('.page-chip').nth(1).locator('canvas');
  await expect.poll(() => thumbnail.evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
  const original = await thumbnail.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
  await page.locator('.object-hitbox[data-object-type="text"]').first().click();
  await resize(page, 's', 0, 10);
  await expect.poll(() => thumbnail.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).not.toBe(original);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect.poll(() => thumbnail.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).toBe(original);
});

test('fixed frame retains new lines through resizing, undo and PDF reopen', async ({ page }) => {
  await open(page); await edit(page);
  await page.locator('.object-hitbox[data-object-type="text"]').first().click();
  // Helvetica cannot encode Chinese; selecting a Chinese face is an explicit user choice, not a silent fallback.
  await page.getByRole('combobox', { name: 'Font', exact: true }).selectOption('Noto Sans CJK SC');
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  await resize(page, 's', 0, 20);
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('Original text'); await input.press('End'); await input.press('Enter');
  await page.keyboard.insertText('Added line one\nAdded line two 中文\nAdded line three');
  const text = 'Original text\nAdded line one\nAdded line two 中文\nAdded line three';
  await expect(input).toHaveText(text, { useInnerText: true });
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('.page-chip')).toHaveCount(1);
  await page.locator('.object-hitbox[data-object-type="text"]').first().click();
  const small = (await page.locator('.selection-box').boundingBox())!.height;
  await resize(page, 's', 0, 160);
  await expect.poll(async () => (await page.locator('.selection-box').boundingBox())?.height ?? 0).toBeGreaterThan(small + 150);
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  await expect(input).toHaveText(text, { useInnerText: true });
  await expect(page.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('18');
  await input.press('Escape');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect.poll(async () => (await page.locator('.selection-box').boundingBox())?.height ?? 0).toBeCloseTo(small, 1);
  await page.getByRole('button', { name: 'Redo (Ctrl Shift Z)', exact: true }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  const chooser = page.waitForEvent('filechooser'); await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'resized.pdf', mimeType: 'application/pdf', buffer: bytes });
  await edit(page); await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  await expect(input).toHaveText(text, { useInnerText: true });
  await expect(page.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('18');
  await page.screenshot({ path: 'tmp/browser/text-frame-expanded.png' });
});
