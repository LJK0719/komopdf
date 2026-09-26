import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('tagged text edits and grouping survive undo, save and reopen', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'tagged-content.pdf', mimeType: 'application/pdf', buffer: taggedPdf() });
  const editTab = page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true });
  await editTab.click();
  const texts = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(texts).toHaveCount(2, { timeout: 60_000 });
  await texts.first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toHaveValue('Alpha');
  await input.fill('Alto');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await texts.first().click();
  await texts.last().click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: 'Arrange objects', exact: true }).click();
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await expect(page.locator('.object-hitbox[data-object-type="group"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit group contents', exact: true }).click();
  await expect(texts).toHaveCount(2);
  await page.getByRole('button', { name: 'Select parent group', exact: true }).click();
  await expect(page.locator('.object-hitbox[data-object-type="group"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(texts).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'tagged-saved.pdf', mimeType: 'application/pdf', buffer: saved });
  await editTab.click();
  await expect(texts).toHaveCount(2);
  await texts.first().dblclick();
  await expect(input).toHaveValue('Alto');
  await input.press('Escape');
  await texts.last().dblclick();
  await expect(input).toHaveValue('Beta');
  await input.press('Escape');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('navigation', { name: 'Quick tools' }).getByRole('button', { name: 'Find & replace' }).click();
  await expect(page.getByRole('textbox', { name: 'Find text' })).toBeVisible();
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(page.locator('.inspector-panel')).toBeHidden();
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
