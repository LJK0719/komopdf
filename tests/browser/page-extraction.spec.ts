import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clickRibbonCommand } from './editor-ui-helpers';

function twoPagePdf(): Buffer {
  const first = 'BT /F1 18 Tf 20 240 Td (First page) Tj ET';
  const second = 'BT /F1 18 Tf 20 240 Td (Second page) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const position = Buffer.byteLength(output);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return position;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

test('page extraction creates a separate PDF without changing the source session', async ({ page }) => {
  test.setTimeout(30_000);
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'source-pages.pdf', mimeType: 'application/pdf', buffer: twoPagePdf() });
  await expect(page.locator('.page-chip')).toHaveCount(2, { timeout: 60_000 });
  const currentPage = page.getByRole('spinbutton', { name: 'Page', exact: true });
  await currentPage.fill('2');
  await currentPage.press('Enter');
  await expect(currentPage).toHaveValue('2');
  await expect(page.locator('.page-wrap[data-page-number="2"] .pdf-text-layer')).toContainText('Second page');
  const download = page.waitForEvent('download');
  await clickRibbonCommand(page, 'Extract pages');
  const extracted = await readFile((await (await download).path())!);
  await expect(page.locator('.page-chip')).toHaveCount(2);
  await expect(page.locator('.save-state')).toHaveText('No changes');
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();

  chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'only-second.pdf', mimeType: 'application/pdf', buffer: extracted });
  const tabs = page.getByRole('navigation', { name: 'Open PDFs', exact: true });
  await expect(tabs.getByRole('tab', { name: 'only-second.pdf', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.page-chip')).toHaveCount(1);
  await expect(page.locator('.page-wrap .pdf-text-layer')).toHaveText('Second page');
  await tabs.getByRole('tab', { name: 'source-pages.pdf', exact: true }).click();
  await expect(page.locator('.page-chip')).toHaveCount(2);
  await expect(currentPage).toHaveValue('2');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.locator('.page-wrap[data-page-number="1"] .pdf-text-layer')).toHaveText('First page');
  await expect(page.locator('.save-state')).toHaveText('No changes');
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
});
