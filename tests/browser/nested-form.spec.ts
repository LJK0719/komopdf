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
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'shared-form.pdf', mimeType: 'application/pdf', buffer: sharedNestedPdf() });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  const hitboxes = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(hitboxes).toHaveCount(2, { timeout: 60_000 });
  const draft = page.getByRole('textbox', { name: 'Page text', exact: true });
  await hitboxes.first().dblclick();
  await expect(draft).toHaveValue('ORIGINAL');
  await draft.fill('HI');
  await draft.press('Control+Enter');
  await expect(draft).toHaveCount(0);
  await hitboxes.last().dblclick();
  await expect(draft).toHaveValue('ORIGINAL');
  await draft.press('Escape');
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await expect(hitboxes).toHaveCount(2);
  await hitboxes.first().dblclick();
  await expect(draft).toHaveValue('ORIGINAL');
  await draft.press('Escape');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'reopened-form.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.locator('.document-title strong')).toHaveText('reopened-form.pdf');
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('1');
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await hitboxes.first().dblclick();
  await expect(draft).toHaveValue('HI');
  await draft.press('Escape');
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await hitboxes.first().dblclick();
  await expect(draft).toHaveValue('ORIGINAL');
});
