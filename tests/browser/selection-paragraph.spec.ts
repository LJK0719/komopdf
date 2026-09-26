import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function open(page: Page, bytes = fixture()) {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'selection-paragraph.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByRole('button', { name: 'Edit content', exact: true })).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Merge PDFs', exact: true })).toHaveCount(0);
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.object-hitbox')).toHaveCount(4);
}

test('container interiors start a marquee, borders move, and nearby small objects win', async ({ page }) => {
  await open(page);
  const layer = page.locator('.selection-layer');
  const rect = (await layer.boundingBox())!;
  const scale = rect.width / 420;
  const at = (x: number, y: number) => page.mouse.move(rect.x + x * scale, rect.y + y * scale);
  await at(30, 30); await page.mouse.down();
  await at(300, 180); await page.mouse.up();
  await expect(page.locator('.object-hitbox-selected')).toHaveCount(3);
  const frame = page.locator('.object-hitbox[data-object-type="path"]').last();
  await expect(frame).toHaveAttribute('aria-pressed', 'false');
  const text = page.locator('.object-hitbox[data-object-type="text"]').first();
  const bounds = (await text.boundingBox())!;
  await page.mouse.click(bounds.x - 2, bounds.y + bounds.height / 2);
  await expect(text).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.object-hitbox-selected')).toHaveCount(1);
  await at(20, 210); await page.mouse.down(); await at(25, 215); await page.mouse.up();
  await expect(frame).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await text.dblclick();
  await expect(page.getByRole('textbox', { name: 'Page text', exact: true })).toHaveValue('Alpha text.');
  await page.getByRole('textbox', { name: 'Page text', exact: true }).press('Escape');
  await page.screenshot({ path: 'tmp/browser/nested-selection.png' });
});

test('tracking survives typing and bold; recognized paragraphs keep line spacing across save and reopen', async ({ page }) => {
  await open(page);
  const text = page.locator('.object-hitbox[data-object-type="text"]').first();
  await text.click();
  const spacing = page.getByRole('spinbutton', { name: 'Character spacing', exact: true });
  await expect(spacing).toHaveValue('3');
  await text.dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('Alto text.');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await expect(spacing).toHaveValue('3');
  await page.getByRole('button', { name: 'Edit paragraph', exact: true }).click();
  await expect(input).toHaveValue('Alto text.\nBravo text.');
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(1);
  await expect(spacing).toHaveValue('3');
  const line = page.getByRole('spinbutton', { name: 'Line spacing', exact: true });
  await line.fill('1.6'); await line.press('Enter');
  await expect(line).toHaveValue('1.6');
  await page.getByRole('combobox', { name: 'Paragraph alignment', exact: true }).selectOption('center');
  await input.fill('Alto text.\nBrave text.');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(spacing).toHaveValue('3');
  await expect(line).toHaveValue('1.6');
  await input.press('Control+Enter');
  await expect(page.locator('.property-error')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  await page.reload();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'paragraph-saved.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await text.dblclick();
  await expect(input).toHaveValue('Alto text.\nBrave text.');
  await expect(line).toHaveValue('1.6');
  await expect(spacing).toHaveValue('3');
  await expect(page.getByRole('combobox', { name: 'Paragraph alignment', exact: true })).toHaveValue('center');
  await input.fill('Alto text.\nZebra text.');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await expect(page.locator('.property-error')).toHaveCount(0);
  await text.dblclick();
  await expect(input).toHaveValue('Alto text.\nZebra text.');
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
  await page.screenshot({ path: 'tmp/browser/paragraph-properties-zh.png' });
});

function fixture() {
  const tracked = (text: string) => '[' + [...text].map(char => `(${char})`).join(' -50 ') + '] TJ';
  const content = `BT /F1 20 Tf 2 Tc 1 0 0 1 60 510 Tm ${tracked('Alpha text.')} 0 -28 Td ${tracked('Bravo text.')} ET\n0.2 0.6 0.4 rg 60 440 40 18 re f\n0 G 1 w 20 20 380 560 re S`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 600] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let output = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(output); output += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
