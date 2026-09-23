import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('real WASM reflows adjacent text lines into a single paragraph, undoes, redoes, replaces full paragraph and reopens saved PDF', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });

  // 1. Synthesize 1-page PDF with 2 independent adjacent text objects ("First line", "Second line") and open it
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const original = syntheticParagraphPdf();
  await (await chooser).setFiles({ name: 'paragraph-flow.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page.getByText('paragraph-flow.pdf', { exact: true }).or(page.locator('.status-dot-error'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.status-dot-error')).toHaveCount(0);

  // 2. Open and use real Ctrl clicks on the two Text hitboxes for multi-selection
  const textHitboxes = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(textHitboxes).toHaveCount(2, { timeout: 60_000 });
  await textHitboxes.nth(0).click({ modifiers: ['Control'] });
  await textHitboxes.nth(1).click({ modifiers: ['Control'] });
  await expect(textHitboxes.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(textHitboxes.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('2 text objects selected')).toBeVisible();

  // 3. In "Paragraph reflow and insertion" region, click "Use selected text"
  const paragraphSection = page.getByRole('region', { name: 'Paragraph reflow and insertion' });
  await paragraphSection.getByRole('button', { name: 'Use selected text', exact: true }).click();
  await expect(paragraphSection.getByRole('textbox', { name: 'Paragraph text' })).toHaveValue('First line\nSecond line');

  // 4. Set Paragraph text to mixed Chinese and English with newlines, choose font noto-sans-cjk-sc-regular, and set adequate Box Width/Height (240/160)
  const reflowText = '第一行中文与English段落\n第二行内容继续Reflow混排测试';
  await paragraphSection.getByRole('textbox', { name: 'Paragraph text' }).fill(reflowText);
  await paragraphSection.getByRole('combobox', { name: 'Font' }).selectOption('noto-sans-cjk-sc-regular');
  await paragraphSection.getByRole('spinbutton', { name: 'Box Width (pt)' }).fill('240');
  await paragraphSection.getByRole('spinbutton', { name: 'Box Height (pt)' }).fill('160');
  await paragraphSection.getByRole('checkbox', { name: 'Underline paragraph' }).check();

  // 5. Preview paragraph, confirm fit, and reflow selected text
  await paragraphSection.getByRole('button', { name: 'Preview paragraph', exact: true }).click();
  await expect(paragraphSection.getByText('Fits paragraph bounds', { exact: true })).toBeVisible();
  await paragraphSection.getByRole('button', { name: 'Reflow selected text', exact: true }).click();

  // 6. Confirm real text hitboxes count becomes 1, Original text is the new paragraph, and original First/Second are not in the new TextBlock
  await expect(textHitboxes).toHaveCount(1);
  await textHitboxes.first().click();

  const textEditSection = page.getByRole('region', { name: 'Manual text editing' });
  const originalText = textEditSection.getByRole('textbox', { name: 'Original text', exact: true });
  await expect(originalText).toHaveValue(reflowText);
  await expect(originalText).not.toHaveValue(/First line/);
  await expect(originalText).not.toHaveValue(/Second line/);
  await expect(textEditSection.getByText('Paragraph Text Edit', { exact: true })).toBeVisible();

  // 7. Undo recovers 2 hitboxes, Redo recovers 1 hitbox
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(textHitboxes).toHaveCount(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(textHitboxes).toHaveCount(1);

  // 8. Click the new paragraph, in TextEditPanel Replacement replace the whole paragraph (including newlines) -> Preview layout -> Commit replacement
  await textHitboxes.first().click();
  await expect(originalText).toHaveValue(reflowText);

  const replacementText = '替换后的段落内容第一行 Updated P1\n第二行换行测试内容 Updated P2';
  await textEditSection.getByRole('textbox', { name: 'Replacement', exact: true }).fill(replacementText);
  await textEditSection.getByRole('button', { name: 'Preview layout', exact: true }).click();
  await expect(textEditSection.getByText('Fits current text bounds', { exact: true })).toBeVisible();
  await textEditSection.getByRole('button', { name: 'Commit replacement', exact: true }).click();
  await expect(originalText).toHaveValue(replacementText);

  // 9. Save and download, then reopen with dirty session confirmation handling
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  expect(saved.equals(original)).toBe(false);
  expect(saved.includes(Buffer.from('/Underline true'))).toBe(true);

  page.once('dialog', async dialog => {
    page.once('dialog', discard => discard.accept());
    await dialog.dismiss();
  });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'saved-paragraph.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByText('saved-paragraph.pdf', { exact: true })).toBeVisible({ timeout: 60_000 });

  // 10. Confirm in reopened document: still 1 logical paragraph, text matches replacement content, and no errors
  const reopenedHitboxes = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(reopenedHitboxes).toHaveCount(1);
  await reopenedHitboxes.first().click();

  const reopenedTextEditSection = page.getByRole('region', { name: 'Manual text editing' });
  await expect(reopenedTextEditSection.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue(replacementText);
  await expect(reopenedTextEditSection.getByText('Paragraph Text Edit', { exact: true })).toBeVisible();
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  expect(posts).toEqual([]);
});

function syntheticParagraphPdf(pageAttributes = '/MediaBox [0 0 400 400]'): Buffer {
  const stream = 'BT /F1 14 Tf 36 340 Td (First line) Tj ET\nBT /F1 14 Tf 36 300 Td (Second line) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R ${pageAttributes} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(output);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  output += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
