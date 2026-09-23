import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function outlinedPdf(): Buffer {
  const first = 'q 1 0 0 rg 20 20 50 50 re f Q';
  const second = 'q 0 0 1 rg 30 30 60 60 re f Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 6 0 R >>',
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
    '<< /Type /Outlines /First 8 0 R /Last 8 0 R /Count 1 >>',
    '<< /Title (Chapter Two) /Parent 7 0 R /Dest [4 0 R /Fit] >>',
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((body, index) => {
    const position = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return position;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('real PDF bookmarks navigate to the right page with visible local thumbnails', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'bookmarks.pdf', mimeType: 'application/pdf', buffer: outlinedPdf() });
  await expect(page.locator('.page-chip')).toHaveCount(2, { timeout: 60_000 });
  const bookmark = page.getByRole('button', { name: 'Go to bookmark Chapter Two' });
  await expect(bookmark).toBeVisible();
  await expect.poll(() => page.locator('.page-chip canvas').first().evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    if (!canvas.width || !canvas.height) return false;
    const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
    return !!pixels && pixels.some((value, index) => index % 4 !== 3 && value < 240);
  })).toBe(true);
  await bookmark.click();
  await expect(page.locator('.page-chip-active')).toHaveAttribute('aria-label', 'Open page 2');
  await page.getByRole('button', { name: 'Move page earlier' }).click();
  await expect(page.locator('.page-chip-active')).toHaveAttribute('aria-label', 'Open page 1');
  await bookmark.click();
  await expect(page.locator('.page-chip-active')).toHaveAttribute('aria-label', 'Open page 1');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('multi-page page numbers are searchable native PDF text in one undo step', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'numbering.pdf', mimeType: 'application/pdf', buffer: outlinedPdf() });
  await expect(page.locator('.page-chip')).toHaveCount(2, { timeout: 60_000 });
  await page.getByText('Page numbers, headers, footers & watermark', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Pages', exact: true }).fill('all');
  await page.getByRole('combobox', { name: 'Decoration font' }).selectOption('liberation-sans-regular');
  await page.getByRole('button', { name: 'Apply to selected pages' }).click();
  const text = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(text).toHaveCount(1, { timeout: 30_000 });
  await text.click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('1');
  await page.getByRole('button', { name: 'Open page 2' }).click();
  await expect(text).toHaveCount(1);
  await text.click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('2');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(text).toHaveCount(0);
  await page.getByRole('button', { name: 'Open page 1' }).click();
  await expect(text).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(text).toHaveCount(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  page.once('dialog', async dialog => { page.once('dialog', discard => discard.accept()); await dialog.dismiss(); });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'numbered.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(text).toHaveCount(1, { timeout: 30_000 });
  await text.click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('1');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});
