import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function open(page: Page, bytes = fixture()) {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'source-paragraph.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
}

const original = 'Alpha Beta  Gamma A short line';

test('hover/click share paragraph scope; alignment preserves source fonts and all word gaps through save and reopen', async ({ page }) => {
  await open(page);
  const paragraphs = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(paragraphs).toHaveCount(2);
  const hitbox = paragraphs.first(), box = (await hitbox.boundingBox())!;
  // Hover the second visual line: the same full paragraph is the hit target.
  await page.mouse.move(box.x + 8, box.y + box.height * 0.6);
  await expect(hitbox).toHaveClass(/object-hitbox-hovered/);
  expect(box.height).toBeGreaterThan(35);
  await hitbox.click();
  await expect(page.getByRole('combobox', { name: 'Font', exact: true })).toHaveValue('Helvetica');
  const alignment = page.getByRole('combobox', { name: 'Paragraph alignment', exact: true });
  await alignment.selectOption('center');
  await expect(alignment).toHaveValue('center');
  await expect(page.getByRole('combobox', { name: 'Font', exact: true })).toHaveValue('Helvetica');
  await expect(page.locator('.property-error')).toHaveCount(0);
  await expect(paragraphs).toHaveCount(2);
  await hitbox.dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect.poll(() => input.textContent()).toBe(original);
  await input.press('Escape');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  expect(bytes.toString('latin1')).toContain('/Helvetica');
  expect(bytes.toString('latin1')).not.toContain('/KomoParagraph');
  await open(page, bytes);
  await paragraphs.first().click();
  await expect(alignment).toHaveValue('center');
  await alignment.selectOption('right');
  await expect(alignment).toHaveValue('right');
  await paragraphs.first().dblclick();
  await expect.poll(() => input.textContent()).toBe(original);
  await input.press('Escape');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await paragraphs.first().click();
  await expect(alignment).toHaveValue('center');
  await alignment.selectOption('left');
  await expect(alignment).toHaveValue('left');
  await paragraphs.first().dblclick();
  await input.fill(original + ' edited');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await expect(page.locator('.property-error')).toHaveCount(0);
  await paragraphs.first().dblclick();
  await expect.poll(() => input.textContent()).toBe(original + ' edited');
  await input.press('Escape');
  await page.screenshot({ path: 'tmp/browser/source-paragraph-alignment.png' });
});

test('detected indent does not submit on blur; clearing it works without rewriting the font', async ({ page }) => {
  await open(page, fixture(24));
  const paragraph = page.locator('.object-hitbox[data-object-type="text"]').first();
  await paragraph.click();
  await page.getByRole('button', { name: 'Paragraph settings', exact: true }).click();
  const indent = page.getByRole('spinbutton', { name: 'First-line indent (pt)', exact: true });
  await expect(indent).toHaveValue('24');
  await indent.focus(); await indent.press('Tab');
  await expect(page.locator('.save-state')).toHaveText('Saved');
  await indent.fill('0'); await indent.press('Enter');
  await expect(indent).toHaveValue('0');
  await expect(page.locator('.save-state')).toHaveText('Unsaved changes');
  await expect(page.getByRole('combobox', { name: 'Font', exact: true })).toHaveValue('Helvetica');
  await page.getByRole('button', { name: 'Paragraph settings', exact: true }).click();
  await paragraph.dblclick();
  await expect.poll(() => page.getByRole('textbox', { name: 'Page text', exact: true }).textContent()).toBe(original);
});

test('reading selection retains inferred spaces and exact paragraph edit offsets', async ({ page }) => {
  await open(page);
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  for (const selection of [
    { startObject: 0, start: 5, endObject: 0, end: 6, expected: ' ' },
    { startObject: 0, start: 6, endObject: 1, end: 1, expected: 'Beta  Gamma A' },
    { startObject: 1, start: 2, endObject: 1, end: 5, expected: 'sho' },
  ]) {
    await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Home', exact: true }).click();
    const layer = page.locator('.pdf-text-layer');
    await layer.focus();
    await layer.evaluate((element, selection) => {
      const objects = element.querySelectorAll('[data-text-object]');
      const point = (object: Element, offset: number) => {
        const walker = document.createTreeWalker(object, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const length = node.textContent?.length ?? 0;
          if (offset <= length) return { node, offset };
          offset -= length;
        }
        throw new Error('Selection offset is outside the reading object');
      };
      const start = point(objects[selection.startObject]!, selection.start);
      const end = point(objects[selection.endObject]!, selection.end);
      window.getSelection()!.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
      document.dispatchEvent(new Event('selectionchange'));
    }, selection);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(selection.expected);
    await layer.press('Enter');
    await expect(input).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(selection.expected);
    await input.press('Escape');
  }
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
});

test('wide source line spacing falls back to durable reflow instead of breaking paragraph selection', async ({ page }) => {
  await open(page);
  const paragraph = page.locator('.object-hitbox[data-object-type="text"]').first();
  await paragraph.click();
  const lineHeight = page.getByRole('spinbutton', { name: 'Line spacing', exact: true });
  await lineHeight.fill('2.4'); await lineHeight.press('Enter');
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toHaveText(original);
  await expect(lineHeight).toHaveValue('2.4');
  await input.press('Escape');
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(2);
  await paragraph.dblclick();
  await expect(input).toHaveText(original);
  await input.press('Escape');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await paragraph.dblclick();
  await expect(input).toHaveText(original);
  await expect(lineHeight).toHaveValue('1.333');
});

function fixture(indent = 0): Buffer {
  const stream = `BT /F1 18 Tf 1 0 0 1 ${30 + indent} 250 Tm [(Alpha) -350 (Beta  Gamma)] TJ 1 0 0 1 30 226 Tm (A short line) Tj 1 0 0 1 30 140 Tm (Separate heading) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
