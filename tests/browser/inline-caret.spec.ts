import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function fixture(): { bytes: Buffer; text: string } {
  const text = 'Accurate caret at the very last letters';
  const parts = [...text].map((letter, i) => `(${letter}) ${i % 3 === 0 ? -45 : 25}`).join(' ');
  const stream = `BT /F1 18 Tf 0.9 Tc 0.75 0 0 0.75 35 240 Tm [${parts}] TJ ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 450 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return { bytes: Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`), text };
}

async function open(page: Page, sample = fixture()) {
  const { bytes, text } = sample;
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'caret.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled({ timeout: 60_000 });
  const zoom = page.getByLabel('Zoom', { exact: true });
  await zoom.fill('100%'); await zoom.press('Enter');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.locator('.pdf-character')).toHaveCount(text.length);
  const characters = await page.locator('.pdf-character').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('[data-object-type="text"]').first().dblclick({ position: { x: 12, y: 6 } });
  await expect(page.getByRole('textbox', { name: 'Page text', exact: true })).toHaveText(text);
  return { text, characters };
}

async function offset(page: Page) {
  return page.getByRole('textbox', { name: 'Page text', exact: true }).evaluate(root => {
    const selection = window.getSelection();
    if (!selection?.focusNode || !root.contains(selection.focusNode)) return -1;
    const range = document.createRange(); range.selectNodeContents(root);
    range.setEnd(selection.focusNode, selection.focusOffset);
    return range.toString().length;
  });
}

test('pristine inline input hits the actual source positions including the last two letters and end', async ({ page }) => {
  const { text, characters } = await open(page);
  for (const index of [0, 5, text.length - 2, text.length - 1]) {
    const box = characters[index]!;
    for (const [fraction, expected] of [[0.15, index], [0.85, index + 1]]) {
      await page.mouse.click(box.x + box.width * fraction!, box.y + box.height / 2);
      await expect.poll(() => offset(page)).toBe(expected);
      const caret = page.locator('.inline-source-caret');
      await expect(caret).toHaveAttribute('data-offset', String(expected));
      expect((await caret.boundingBox())!.x).toBeCloseTo(box.x + (fraction! < 0.5 ? 0 : box.width), 0);
    }
  }
  const last = characters.at(-1)!;
  await page.mouse.click(last.x + last.width + 2, last.y + last.height / 2);
  await expect.poll(() => offset(page)).toBe(text.length);
  await expect(page.locator('.direct-text-editor')).toHaveAttribute('data-pristine', 'true');
  await page.getByRole('textbox', { name: 'Page text', exact: true }).press('Control+Enter');
  await expect(page.locator('.save-state')).toHaveText('Saved');
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
});

test('SimSun source caret reaches both final Chinese glyphs without importing or reflowing the font', async ({ page }) => {
  test.skip(!process.env.KOMOPDF_SONG_FIXTURE, 'Requires the local, non-distributed SimSun fixture.');
  const { text, characters } = await open(page, { bytes: await readFile(process.env.KOMOPDF_SONG_FIXTURE!), text: '原文宋体测试' });
  for (const index of [0, text.length - 2, text.length - 1]) {
    const box = characters[index]!;
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
    await expect.poll(() => offset(page)).toBe(index + 1);
    const caret = page.locator('.inline-source-caret');
    await expect(caret).toHaveAttribute('data-offset', String(index + 1));
    expect((await caret.boundingBox())!.x).toBeCloseTo(box.x + box.width, 0);
  }
  await page.getByRole('textbox', { name: 'Page text', exact: true }).press('Escape');
  await expect(page.locator('.save-state')).toHaveText('Saved');
});

test('IME composition uses the native input caret and does not submit an unfinished composition', async ({ page }) => {
  const { text } = await open(page);
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.press('End');
  const session = await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
  await expect(input).toHaveText(text + '中文');
  await expect(input).not.toHaveAttribute('data-source-selection', 'true');
  await expect(page.locator('.inline-source-selection')).toHaveCount(0);
  await input.press('Control+Enter');
  await expect(input).toHaveCount(1);
  await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.locator('.save-state')).toHaveText('Saved');
  await session.detach();
});

test('edited content uses its visible DOM layout and undo restores source caret geometry', async ({ page }) => {
  const { text, characters } = await open(page);
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.press('End');
  await input.pressSequentially('!');
  await expect(input).toHaveText(text + '!');
  await expect(page.locator('.direct-text-editor')).toHaveAttribute('data-pristine', 'false');
  await expect(page.locator('.inline-source-selection')).toHaveCount(0);
  const last = await input.evaluate(root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode()!, next;
    while ((next = walker.nextNode())) node = next;
    const range = document.createRange();
    range.setStart(node, node.textContent!.length - 1); range.setEnd(node, node.textContent!.length);
    const box = range.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  await page.mouse.click(last.x + last.width * 0.85, last.y + last.height / 2);
  await expect.poll(() => offset(page)).toBe(text.length + 1);
  await input.press('Control+Z');
  await expect(input).toHaveText(text);
  await expect(page.locator('.direct-text-editor')).toHaveAttribute('data-pristine', 'true');
  const box = characters.at(-1)!;
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
  await expect.poll(() => offset(page)).toBe(text.length);
  await expect(page.locator('.inline-source-caret')).toHaveAttribute('data-offset', String(text.length));
  await input.press('Escape');
  await expect(page.locator('.save-state')).toHaveText('Saved');
});
