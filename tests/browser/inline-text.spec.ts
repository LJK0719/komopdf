import { test, expect } from '@playwright/test';

function samplePdf(): Buffer {
  const stream = 'BT /F1 18 Tf 20 240 Td (Hello PDF Editor) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'inline.pdf', mimeType: 'application/pdf', buffer: samplePdf() });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
});

test('page text draft keeps the IME node and commits one undoable edit', async ({ page }) => {
  const hitbox = page.locator('.object-hitbox[data-object-type="text"]');
  await hitbox.dblclick();
  const draft = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(draft).toHaveValue('Hello PDF Editor');
  const objectBox = await hitbox.boundingBox();
  const draftBox = await draft.boundingBox();
  expect(Math.abs(draftBox!.x - objectBox!.x)).toBeLessThan(4);
  expect(Math.abs(draftBox!.y - objectBox!.y)).toBeLessThan(4);
  await draft.fill('Discard me');
  await draft.press('Escape');
  await expect(draft).toHaveCount(0);
  await hitbox.dblclick();
  await expect(draft).toHaveValue('Hello PDF Editor');
  await draft.selectText();
  await draft.evaluate(element => {
    element.setAttribute('data-stable-ime-node', 'yes');
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'Edited' }));
  });
  await page.keyboard.insertText('Edited');
  await expect(draft).toHaveValue('Edited');
  await expect(draft).toHaveAttribute('data-stable-ime-node', 'yes');
  await draft.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'Edited' })));
  await draft.press('Control+Enter');
  await expect(draft).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await hitbox.dblclick();
  await expect(draft).toHaveValue('Hello PDF Editor');
  await draft.press('Escape');
  await page.getByRole('button', { name: 'Redo (Ctrl Shift Z)', exact: true }).click();
  await hitbox.dblclick();
  await expect(draft).toHaveValue('Edited');
});

test('page text preview reports overflow and blocks commit', async ({ page }) => {
  const hitbox = page.locator('.object-hitbox[data-object-type="text"]');
  await hitbox.dblclick();
  const draft = page.getByRole('textbox', { name: 'Page text', exact: true });
  await draft.fill('W'.repeat(400));
  await draft.press('Control+Enter');
  await expect(draft).toBeVisible();
  await expect(page.locator('.save-state')).toHaveText('Saved');
  await draft.press('Escape');
  await expect(draft).toHaveCount(0);
  await hitbox.dblclick();
  await expect(draft).toHaveValue('Hello PDF Editor');
});
