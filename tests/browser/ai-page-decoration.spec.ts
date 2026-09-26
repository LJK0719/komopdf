import { test, expect } from '@playwright/test';

function blankTwoPagePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 6 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const position = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return position;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('page numbers remain available without the retired web AI workflow', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  const aiRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/ai/')) aiRequests.push(request.url()); });
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'blank-pages.pdf', mimeType: 'application/pdf', buffer: blankTwoPagePdf() });
  await expect(page.locator('.page-chip')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Ask komo', exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Pages', exact: true }).click();
  await page.getByRole('button', { name: 'More page tools', exact: true }).click();
  const tools = page.getByRole('region', { name: 'Page and object editing' });
  await tools.getByText('Page numbers & watermark', { exact: true }).click();
  await tools.getByRole('textbox', { name: 'Pages', exact: true }).fill('all');
  await tools.getByRole('button', { name: 'Apply to selected pages' }).click();
  await expect(page.locator('.status-message')).toHaveText('Changes applied');
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  const text = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(text).toHaveCount(1);
  await text.dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toHaveValue('1');
  await input.press('Escape');
  await page.getByRole('button', { name: 'Open page 2' }).click();
  await text.dblclick();
  await expect(input).toHaveValue('2');
  await input.press('Escape');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(text).toHaveCount(0);
  expect(aiRequests).toEqual([]);
});
