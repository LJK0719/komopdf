import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function open(page: import('@playwright/test').Page, bytes: Buffer) {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'source-font.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
}

function fixture(): Buffer {
  const content = 'BT /F1 18 Tf 0.8 Tc 1 0 0 1 40 240 Tm (Original text) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('text selection has one painted frame and entering edit leaves the PDF untouched', async ({ page }) => {
  await open(page, fixture());
  const hitbox = page.locator('[data-object-type="text"]').first();
  await hitbox.click({ position: { x: 12, y: 6 } });
  const colors = await hitbox.evaluate(node => ({ border: getComputedStyle(node).borderTopColor, background: getComputedStyle(node).backgroundColor }));
  expect(colors).toEqual({ border: 'rgba(0, 0, 0, 0)', background: 'rgba(0, 0, 0, 0)' });
  await expect(page.locator('.selection-box-text')).toHaveCount(1);
  const canvas = page.locator('.page-wrap canvas').first();
  const original = await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL());
  await hitbox.dblclick({ position: { x: 12, y: 6 } });
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toHaveText('Original text');
  await expect(page.locator('.direct-text-editor')).toHaveAttribute('data-pristine', 'true');
  const editor = await page.locator('.direct-text-editor').evaluate(node => ({ outline: getComputedStyle(node).outlineStyle, shadow: getComputedStyle(node).boxShadow, background: getComputedStyle(node).backgroundColor }));
  expect(editor).toEqual({ outline: 'none', shadow: 'none', background: 'rgba(0, 0, 0, 0)' });
  await expect(page.locator('.direct-text-actions')).toHaveCount(0);
  expect(await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL())).toBe(original);
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await expect(page.locator('.save-state')).toHaveText('Saved');
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
  await hitbox.dblclick({ position: { x: 12, y: 6 } });
  await input.press('End');
  await input.pressSequentially(' added');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await expect(page.locator('.property-error')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  expect(saved.toString('latin1')).toContain('/Helvetica');
  expect(saved.toString('latin1')).not.toContain('/LiberationSans');
  await open(page, saved);
  await page.locator('[data-object-type="text"]').first().dblclick({ position: { x: 12, y: 6 } });
  await expect(input).toHaveText('Original text added');
});

async function importSong(page: import('@playwright/test').Page) {
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import font file', exact: true }).click();
  await (await picker).setFiles('C:/Windows/Fonts/simsun.ttc');
  await expect(page.getByRole('button', { name: 'Add selected font', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Add selected font', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /Font added:/ })).toBeVisible();
}

test('SimSun subset uses installed SimSun only for added Chinese glyphs and keeps spacing after reopening', async ({ page }) => {
  test.skip(!process.env.KOMOPDF_SONG_FIXTURE, 'Requires the locally generated, non-distributed SimSun fixture.');
  await open(page, await readFile(process.env.KOMOPDF_SONG_FIXTURE!));
  const hitbox = page.locator('[data-object-type="text"]').first();
  await hitbox.click({ position: { x: 12, y: 6 } });
  await page.getByRole('button', { name: 'More fonts…', exact: true }).click();
  await importSong(page);
  await page.getByRole('button', { name: 'More fonts…', exact: true }).click();
  await hitbox.dblclick({ position: { x: 12, y: 6 } });
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toHaveText('原文宋体测试');
  await expect(page.locator('.direct-text-editor')).toHaveAttribute('data-pristine', 'true');
  const family = await input.locator('span').first().evaluate(node => getComputedStyle(node).fontFamily);
  expect(family).toContain('SimSun');
  expect(family).not.toMatch(/Noto|Liberation/);
  const sourceIdentity = await input.locator('span').first().evaluate(node => (node as HTMLElement).style.getPropertyValue('--pdf-font-id'));
  await input.press('End');
  await input.pressSequentially('新增中文');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await expect(page.locator('.property-error')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  await open(page, saved);
  await page.locator('[data-object-type="text"]').first().click({ position: { x: 12, y: 6 } });
  // A fresh browser session needs explicit local-font authorization; desktop catalogs load these automatically.
  await page.getByRole('button', { name: 'More fonts…', exact: true }).click();
  await importSong(page);
  await page.getByRole('button', { name: 'More fonts…', exact: true }).click();
  await page.locator('[data-object-type="text"]').first().dblclick({ position: { x: 12, y: 6 } });
  await expect(input).toHaveText('原文宋体测试新增中文');
  const identities = await input.locator('span').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).style.getPropertyValue('--pdf-font-id')));
  expect(identities).toContain(sourceIdentity);
  expect(identities.every(id => !/noto|liberation/i.test(id))).toBe(true);
  await input.press('End');
  await input.pressSequentially('字体');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await expect(page.locator('.property-error')).toHaveCount(0);
});
