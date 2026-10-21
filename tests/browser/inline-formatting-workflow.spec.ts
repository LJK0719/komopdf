import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const original = 'Alpha bravo charlie delta';
function fixture() {
  const stream = `BT /F1 18 Tf 0.4 Tc 40 240 Td (${original}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 450 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
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
  await (await chooser).setFiles({ name: 'formatting.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toBeFocused();
  return input;
}

test('collapsed formatting changes only subsequent input and survives commit/reopen', async ({ page }) => {
  const input = await open(page);
  await input.press('Home');
  for (let index = 0; index < 6; index++) await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.save-state')).toHaveText('No changes');
  await page.keyboard.type('X');
  await expect(input).toHaveText('Alpha Xbravo charlie delta');
  await expect(input.locator('[data-lexical-text]').filter({ hasText: /^X$/ })).toHaveCSS('font-weight', '700');
  await expect(input.locator('[data-lexical-text]').filter({ hasText: /^X$/ })).toHaveCSS('font-style', 'italic');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await page.keyboard.type('Y');
  await expect(input).toHaveText('Alpha XYbravo charlie delta');
  await page.keyboard.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await expect(page.locator('.property-error')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  await page.reload();
  const reopened = await open(page, bytes);
  await expect(reopened).toHaveText('Alpha XYbravo charlie delta');
  await expect(reopened.locator('[data-lexical-text]').filter({ hasText: /^X$/ })).toHaveCSS('font-weight', '700');
  await page.keyboard.press('Escape');
});

test('Enter in font size consumes the key without replacing the selected word', async ({ page }) => {
  const input = await open(page);
  await input.press('Home');
  for (let index = 0; index < 5; index++) await page.keyboard.press('Shift+ArrowRight');
  const size = page.getByRole('spinbutton', { name: 'Font size', exact: true });
  await size.fill('24'); await size.press('Enter');
  await expect(input).toHaveText(original);
  await expect(input.locator('[data-lexical-text]').filter({ hasText: /^Alpha$/ })).toHaveCSS('font-size', '24px');
  await expect(input.locator('p')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-state')).toHaveText('No changes');
});

test('local bold plus typing preserves the unregistered source font outside the changed range', async ({ page }) => {
  const input = await open(page);
  await input.press('Home');
  for (let index = 0; index < 5; index++) await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.keyboard.press('ArrowRight'); await page.keyboard.type('!');
  await expect(input).toHaveText('Alpha! bravo charlie delta');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(input).toHaveCount(0);
  await expect(page.locator('.property-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await page.locator('[data-object-type="text"]').first().dblclick();
  await expect(input).toHaveText(original);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Redo (Ctrl Shift Z)', exact: true }).click();
  await page.locator('[data-object-type="text"]').first().dblclick();
  await expect(input).toHaveText('Alpha! bravo charlie delta');
  const untouched = input.locator('[data-lexical-text]').filter({ hasText: / bravo charlie delta$/ });
  await expect(untouched).toHaveCSS('font-weight', '400');
  expect(await untouched.evaluate(node => (node as HTMLElement).style.getPropertyValue('--pdf-font-id'))).toContain('pdf:Helvetica');
  await page.keyboard.press('Escape');
});
