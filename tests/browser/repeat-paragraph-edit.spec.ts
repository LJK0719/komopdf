import { test, expect, type Page } from '@playwright/test';

const paragraph = [
  'Computer use agents follow a sequence of screenshots and actions.',
  'Each step contains text, images and a description of the task.',
  'The agent selects useful visual information from the current page.',
  'Earlier screenshots provide context for the next decision.',
  'Some details remain relevant while other details can be removed.',
  'The text should remain editable after changing a single word.',
  'Scrolling must keep the selection aligned with the actual line.',
  'A second edit should use the updated paragraph and source font.',
];
function paper(): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: 18 }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count 18 >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>'];
  for (let index = 0; index < 18; index++) {
    const lines = ['BT /F1 9.9626 Tf', `1 0 0 1 100 720 Tm (Paper page ${index + 1}) Tj`,
      ...paragraph.map((line, lineIndex) => `1 0 0 1 100 ${640 - lineIndex * 12} Tm (${line}) Tj`),
      ...paragraph.map((line, lineIndex) => `1 0 0 1 100 ${350 - lineIndex * 12} Tm (${line.replace('agent', 'reader')}) Tj`), 'ET'].join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(lines)} >>\nstream\n${lines}\nendstream`);
  }
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(pdf);
  return Buffer.from(pdf + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'paper.pdf', mimeType: 'application/pdf', buffer: paper() });
  await expect(page.locator('.page-chip')).toHaveCount(18, { timeout: 60_000 });
  const number = page.getByRole('spinbutton', { name: 'Page', exact: true });
  await number.fill('2'); await number.press('Enter');
  const zoom = page.getByRole('combobox', { name: 'Zoom', exact: true });
  await zoom.fill('125%'); await zoom.press('Enter');
  await expect(zoom).toHaveValue('125%');
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  return page.locator('[data-document-page]').nth(1);
}

test('paper text remains editable and pointer selections stay on its painted lines after repeated edits and scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const surface = await open(page);
  const hit = surface.locator('.object-hitbox[data-object-type="text"]').nth(1);
  const box = (await hit.boundingBox())!, before = (await surface.boundingBox())!;
  const origin = { x: box.x - before.x, y: box.y - before.y };
  await hit.dblclick({ position: { x: 35, y: 8 } });
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toContainText('Computer use agents');
  await input.press('End'); await page.keyboard.insertText(' Updated.'); await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  const undo = page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true });
  await expect(undo).toBeEnabled();
  const after = (await surface.boundingBox())!;
  await page.mouse.dblclick(after.x + origin.x + 35, after.y + origin.y + 8);
  await expect(input).toContainText('Updated.');
  await input.press('End'); await page.keyboard.insertText(' Again.'); await input.press('Control+Enter');
  await expect(input).toHaveCount(0); await expect(undo).toBeEnabled();
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Home', exact: true }).click();
  const layer = surface.locator('.pdf-text-layer');
  const edited = layer.locator('[data-text-object]').filter({ hasText: 'Updated.' });
  const characters = edited.locator('.pdf-character');
  await expect(characters.first()).toBeVisible();
  await page.mouse.move(after.x + origin.x + 100, after.y + origin.y + 40);
  await page.mouse.wheel(0, 100);
  await characters.first().scrollIntoViewIfNeeded();
  const current = (await surface.boundingBox())!, first = (await characters.first().boundingBox())!;
  // Compare with the painted paragraph position, not with another overlay.
  expect(Math.abs(first.x - current.x - origin.x)).toBeLessThan(4);
  expect(Math.abs(first.y - current.y - origin.y)).toBeLessThan(4);
  const start = (await characters.nth(2).boundingBox())!, end = (await characters.nth(20).boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toMatch(/puter use agents/);
  const paint = (await layer.locator('.pdf-selection-paint i').first().boundingBox())!;
  expect(Math.abs(paint.y - start.y)).toBeLessThan(3);
  await expect(page.locator('.property-error')).toHaveCount(0);
  await page.screenshot({ path: 'tmp/browser/repeat-paragraph-edit.png' });
});
