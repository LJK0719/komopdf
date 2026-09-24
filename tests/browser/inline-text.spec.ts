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

test('page text draft keeps IME node, respects graphemes and commits one undoable edit', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'inline.pdf', mimeType: 'application/pdf', buffer: samplePdf() });
  const hitbox = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(hitbox).toHaveCount(1, { timeout: 60_000 });
  await hitbox.dblclick();
  const draft = page.getByRole('textbox', { name: 'Page text draft' });
  await expect(draft).toBeVisible();
  const objectBox = await hitbox.boundingBox();
  const draftBox = await page.getByRole('group', { name: 'Edit text on page' }).boundingBox();
  expect(objectBox && draftBox).toBeTruthy();
  expect(Math.abs(draftBox!.x - objectBox!.x)).toBeLessThan(4);
  expect(Math.abs(draftBox!.y - objectBox!.y)).toBeLessThan(4);
  await expect(draft).toHaveValue('Hello PDF Editor');

  await draft.fill('👩‍💻Z');
  await draft.evaluate(element => { (element as HTMLTextAreaElement).setSelectionRange(3, 3); });
  await draft.press('Backspace');
  await expect(draft).toHaveValue('Z');
  await draft.fill('👩‍💻Z');
  await draft.evaluate(element => { (element as HTMLTextAreaElement).setSelectionRange(0, 0); });
  await draft.press('ArrowRight');
  expect(await draft.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe('👩‍💻'.length);
  await draft.press('Backspace');
  await expect(draft).toHaveValue('Z');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Close PDF', exact: true })).toBeDisabled();
  await draft.press('Escape');
  await expect(draft).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Hello PDF Editor');

  await hitbox.dblclick();
  await draft.evaluate(element => {
    element.setAttribute('data-stable-ime-node', 'yes');
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'Edited' }));
  });
  await page.keyboard.insertText('Edited');
  await expect(draft).toHaveValue('Edited');
  await expect(draft).toHaveAttribute('data-stable-ime-node', 'yes');
  await draft.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'Edited' })));
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Hello PDF Editor');
  await page.getByRole('button', { name: 'Preview page text' }).click();
  await expect(page.getByText('Engine preview: fits current text bounds')).toBeVisible();
  await page.getByRole('button', { name: 'Commit page text' }).click();
  await expect(draft).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Edited');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Hello PDF Editor');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Edited');
});

test('page text preview reports overflow and blocks commit', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'overflow.pdf', mimeType: 'application/pdf', buffer: samplePdf() });
  const hitbox = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(hitbox).toHaveCount(1, { timeout: 60_000 });
  await hitbox.dblclick();
  await page.getByRole('textbox', { name: 'Page text draft' }).fill('W'.repeat(400));
  await page.getByRole('button', { name: 'Preview page text' }).click();
  await expect(page.getByText('Overflow detected — shorten the draft before committing')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit page text' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel page text' }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Hello PDF Editor');
});
