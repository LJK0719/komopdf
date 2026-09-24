import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function sharedNestedPdf(): Buffer {
  const stream = (content: string, extra = '') =>
    `<< /Length ${Buffer.byteLength(content)} ${extra} >>\nstream\n${content}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 6 0 R >> >> /Contents 5 0 R >>',
    stream('q /Outer Do Q'),
    stream('q /Inner Do Q q 1 0 0 1 0 -50 cm /Inner Do Q',
      '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /XObject << /Inner 7 0 R >> >>'),
    stream('BT /F1 20 Tf 30 200 Td (ORIGINAL) Tj ET',
      '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /Font << /F1 8 0 R >> >>'),
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

test('real WASM isolates one nested Form text instance across pages and save/reopen', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'shared-form.pdf', mimeType: 'application/pdf', buffer: sharedNestedPdf() });
  const hitboxes = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(hitboxes).toHaveCount(2, { timeout: 60_000 });
  await hitboxes.first().click();
  const original = page.getByRole('textbox', { name: 'Original text' });
  await expect(original).toHaveValue('ORIGINAL');
  await page.getByRole('textbox', { name: 'Replacement' }).fill('HI');
  await page.getByRole('button', { name: 'Preview layout' }).click();
  await expect(page.getByText('Fits current text bounds')).toBeVisible();
  await page.getByRole('button', { name: 'Commit replacement' }).click();
  await expect(original).toHaveValue('HI');
  await hitboxes.last().click();
  await expect(original).toHaveValue('ORIGINAL');
  await page.getByRole('button', { name: 'Open page 2' }).click();
  await expect(hitboxes).toHaveCount(2);
  await hitboxes.first().click();
  await expect(original).toHaveValue('ORIGINAL');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'reopened-form.pdf', mimeType: 'application/pdf', buffer: saved });
  await hitboxes.first().click();
  await expect(original).toHaveValue('HI');
  await page.getByRole('button', { name: 'Open page 2' }).click();
  await hitboxes.first().click();
  await expect(original).toHaveValue('ORIGINAL');
});
