import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'paragraph.pdf', mimeType: 'application/pdf', buffer: fixture() });
  await expect(page.locator('.document-pages .page-wrap')).toHaveCount(1, { timeout: 60_000 });
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
}

test('fragmented drawing order becomes one editable paragraph and long text continues without shrinking', async ({ page }) => {
  await open(page);
  const object = page.locator('.object-hitbox[data-object-type="text"]').first();
  await object.dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toHaveText('First line of a paragraph.');
  const long = 'A paragraph keeps its font size and continues to another page. '.repeat(9).trim();
  await input.fill(long);
  await page.getByRole('button', { name: 'Paragraph settings', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'First-line indent (pt)', exact: true }).fill('12');
  await page.getByRole('spinbutton', { name: 'First-line indent (pt)', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Paragraph settings', exact: true }).click();
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => page.locator('.page-chip').count()).toBeGreaterThan(1);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  await expect(input).toHaveText(long);
  await expect(page.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('12');
  await page.getByRole('button', { name: 'Paragraph settings', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'First-line indent (pt)', exact: true })).toHaveValue('12');
  await page.getByRole('button', { name: 'Paragraph settings', exact: true }).click();
  await page.screenshot({ path: 'tmp/browser/paragraph-flow-edit.png' });
  await input.fill('Short paragraph.');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await expect(page.locator('.page-chip')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect.poll(() => page.locator('.page-chip').count()).toBeGreaterThan(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  await writeFile('tmp/browser/edited-flow.pdf', bytes);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'saved-flow.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  await expect(input).toHaveText(long);
});

test('format painter carries paragraph properties into a new text box', async ({ page }) => {
  await open(page);
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('Source style');
  await page.getByRole('button', { name: 'Paragraph settings', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'First-line indent (pt)', exact: true }).fill('8');
  await page.getByRole('spinbutton', { name: 'First-line indent (pt)', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Paragraph settings', exact: true }).click();
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await page.locator('.object-hitbox[data-object-type="text"]').first().click();
  await page.getByRole('button', { name: 'Copy format', exact: true }).click();
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  const placement = await page.locator('.placement-layer').boundingBox();
  await page.mouse.click(placement!.x + placement!.width * 0.08, placement!.y + placement!.height * 0.7);
  await expect(input).toBeVisible();
  await page.getByRole('button', { name: 'Paragraph settings', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'First-line indent (pt)', exact: true })).toHaveValue('8');
  await page.getByRole('button', { name: 'Paragraph settings', exact: true }).click();
  await input.fill('Copied format'); await input.press('Control+Enter');
  await expect(input).toHaveCount(0); await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('browser export writes edited text and real PNG/HTML files without changing save state', async ({ page }) => {
  await open(page);
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('Edited export text'); await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  for (const format of ['txt', 'png', 'html'] as const) {
    await page.getByRole('combobox', { name: 'File format', exact: true }).selectOption(format);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export file', exact: true }).click();
    const file = await download, bytes = await readFile((await file.path())!);
    expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
    if (format === 'txt') expect(bytes.toString('utf8')).toContain('Edited export text');
    if (format === 'png') expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    if (format === 'html') { expect(bytes.toString('utf8')).toContain('data:image/png;base64,'); expect(bytes.toString('utf8')).toContain('Edited export text'); }
    await expect(page.locator('.save-state')).toHaveText('Unsaved changes');
  }
  await page.screenshot({ path: 'tmp/browser/format-export.png' });
});

test('view zoom does not change saved paragraph font size or CJK content', async ({ page }) => {
  await open(page);
  const zoom = page.getByLabel('Zoom', { exact: true });
  await zoom.fill('200%'); await zoom.press('Enter');
  await expect(zoom).toHaveValue('200%');
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('Zoomed 中文 paragraph.'); await input.press('Control+Enter');
  await expect(input).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('12');
  await zoom.fill('75%'); await zoom.press('Enter');
  await expect(zoom).toHaveValue('75%');
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  await expect(input).toHaveText('Zoomed 中文 paragraph.');
  await input.fill('Zoomed 中文 paragraph again.'); await input.press('Control+Enter');
  await expect(input).toHaveCount(0, { timeout: 60_000 });
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  const chooser = page.waitForEvent('filechooser'); await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'zoom-kept.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  await expect(input).toHaveText('Zoomed 中文 paragraph again.');
  await expect(page.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('12');
});

test('reading selection follows text rather than reversed PDF drawing order', async ({ page }) => {
  await open(page);
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const glyphs = page.locator('.pdf-text-layer .pdf-character');
  const first = (await glyphs.first().boundingBox())!, last = (await glyphs.last().boundingBox())!;
  await page.mouse.move(first.x + 0.5, first.y + first.height / 2); await page.mouse.down();
  await page.mouse.move(last.x + last.width - 0.5, last.y + last.height / 2, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('First line of a paragraph.');
});

test('implicit continuation cannot commit a PDF beyond the web page limit', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const original = pageLimitFixture();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'limit.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page.locator('.page-chip')).toHaveCount(200, { timeout: 60_000 });
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('Line\n'.repeat(35)); await input.press('Control+Enter');
  await expect(page.getByText(/exceeds the web page limit/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.page-chip')).toHaveCount(200);
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
  await input.press('Escape');
  // A fresh edit at the still-current base revision must work, and its single
  // undo must restore the original. No invisible failed transaction is allowed.
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  await input.fill('Safe'); await input.press('Control+Enter');
  await expect(input).toHaveCount(0, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  expect(bytes.equals(original)).toBe(true);
  const reopened = page.waitForEvent('filechooser'); await page.keyboard.press('Control+o');
  await (await reopened).setFiles({ name: 'limit-reopened.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByText('limit-reopened.pdf', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.page-chip')).toHaveCount(200);
});

function pageLimitFixture(): Buffer {
  const stream = 'BT /F1 12 Tf 12 135 Td (Seed) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: 200 }, (_, index) => `${index + 5} 0 R`).join(' ')}] /Count 200 >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ...Array.from({ length: 200 }, (_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 160] /Resources << /Font << /F1 3 0 R >> >> ${index === 0 ? '/Contents 4 0 R' : ''} >>`)];
  return pdfBytes(objects);
}

function fixture(): Buffer {
  const pieces: string[] = [];
  ['First line of a ', 'paragraph.'].forEach((line, row) => [...line].forEach((character, column) => {
    pieces.push(`BT /F1 12 Tf 1 0 0 1 ${12 + column * 7.2} ${135 - row * 16} Tm (${character}) Tj ET`);
  }));
  const stream = [...pieces.reverse(), '0.2 0.6 0.3 rg 10 50 170 20 re f'].join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  return pdfBytes(objects);
}

function pdfBytes(objects: string[]): Buffer {
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
