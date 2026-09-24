import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

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
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'source-pages.pdf', mimeType: 'application/pdf', buffer: twoPagePdf() });
  await expect(page.locator('.page-chip')).toHaveCount(2, { timeout: 60_000 });
  const tools = page.getByRole('region', { name: 'Page and object editing' });
  await tools.getByText('Extract pages to a new PDF').click();
  await tools.getByRole('textbox', { name: 'Pages to extract' }).fill('2');
  const download = page.waitForEvent('download');
  await tools.getByRole('button', { name: 'Extract PDF copy' }).click();
  await expect(tools.getByRole('button', { name: 'Extract PDF copy' })).toBeEnabled({ timeout: 5_000 });
  const extracted = await readFile((await (await download).path())!);
  await expect(page.locator('.page-chip')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'only-second.pdf', mimeType: 'application/pdf', buffer: extracted });
  await expect(page.locator('.page-chip')).toHaveCount(1);
  await page.getByRole('button', { name: 'Select Text object' }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Second page');
  await page.getByRole('navigation', { name: 'Open PDFs' }).getByRole('button', { name: 'source-pages.pdf' }).click();
  await expect(page.locator('.page-chip')).toHaveCount(2);
  await page.getByRole('button', { name: 'Select Text object' }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('First page');
});
