import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('tagged text replacement and grouping remain editable after undo and save', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'tagged-content.pdf', mimeType: 'application/pdf', buffer: taggedPdf() });
  const texts = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(texts).toHaveCount(2, { timeout: 60_000 });
  await texts.first().click();
  const editor = page.getByRole('region', { name: 'Manual text editing' });
  const original = editor.getByRole('textbox', { name: 'Original text', exact: true });
  await expect(original).toHaveValue('Alpha');
  await editor.getByRole('textbox', { name: 'Replacement', exact: true }).fill('Alto');
  await editor.getByRole('button', { name: 'Preview layout', exact: true }).click();
  await expect(editor.getByText('Fits current text bounds', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Commit replacement', exact: true }).click();
  await expect(original).toHaveValue('Alto');
  await texts.first().click();
  await texts.last().click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: 'Group selected objects', exact: true }).click();
  await expect(page.locator('.object-hitbox[data-object-type="group"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit group contents', exact: true }).click();
  await expect(texts).toHaveCount(2);
  await page.getByRole('button', { name: 'Select parent group', exact: true }).click();
  await expect(page.locator('.object-hitbox[data-object-type="group"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(texts).toHaveCount(2);
  await texts.first().click();
  await expect(original).toHaveValue('Alto');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'tagged-saved.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(texts).toHaveCount(2);
  await texts.first().click();
  await expect(original).toHaveValue('Alto');
  await texts.last().click();
  await expect(original).toHaveValue('Beta');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

function taggedPdf(): Buffer {
  const content = '/Span << /MCID 0 /ActualText (AlphaBeta) >> BDC BT /F1 18 Tf 30 230 Td (Alpha) Tj ET BT /F1 18 Tf 100 230 Td (Beta) Tj ET EMC';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /StructParents 0 /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 0 >>',
    '<< /Type /StructTreeRoot /K 6 0 R /ParentTree 8 0 R /ParentTreeNextKey 1 >>',
    '<< /Nums [0 [6 0 R]] >>',
  ];
  let output = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(output);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
