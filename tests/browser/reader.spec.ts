import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Editing is checked as one complete user flow, not after individual implementation steps.
test('real WASM edits original text, undoes, redoes and reopens the saved PDF', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const original = syntheticPdf();
  await (await chooser).setFiles({ name: 'edit-smoke.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page.getByText('edit-smoke.pdf', { exact: true }).or(page.locator('.status-dot-error'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select Text object', exact: true }).click();
  const originalText = page.getByRole('textbox', { name: 'Original text', exact: true });
  await expect(originalText).toHaveValue('Hello PDF Editor');
  await originalText.focus();
  await originalText.press('ControlOrMeta+Home');
  for (let index = 0; index < 6; index++) await originalText.press('ArrowRight');
  for (let index = 0; index < 3; index++) await originalText.press('Shift+ArrowRight');
  await expect(originalText).toHaveJSProperty('selectionStart', 6);
  await expect(originalText).toHaveJSProperty('selectionEnd', 9);
  await expect(page.getByRole('textbox', { name: 'Replacement', exact: true })).toHaveValue('PDF');
  await page.getByRole('textbox', { name: 'Replacement', exact: true }).fill('AI');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview layout', exact: true }).click();
  await expect(page.getByText('Fits current text bounds', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Commit replacement', exact: true }).click();
  await expect(originalText).toHaveValue('Hello AI Editor');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(originalText).toHaveValue('Hello PDF Editor');
  await page.getByRole('textbox', { name: 'Replacement', exact: true }).fill('Edited');
  await page.getByRole('button', { name: 'Preview layout', exact: true }).click();
  await expect(page.getByText('Fits current text bounds', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Commit replacement', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Edited');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Hello PDF Editor');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Edited');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  expect(saved.equals(original)).toBe(false);
  // A download event cannot confirm a disk write. We read the actual file above,
  // then explicitly discard the still-dirty session to reopen that saved output.
  page.once('dialog', async dialog => {
    page.once('dialog', discard => discard.accept());
    await dialog.dismiss();
  });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'saved-edit.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByText('saved-edit.pdf', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select Text object', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Edited');
  expect(posts).toEqual([]);
});

test('real WASM formats a character range and retains it after save and reopen', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const original = syntheticPdf();
  await (await chooser).setFiles({ name: 'range-format.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page.getByText('range-format.pdf', { exact: true }).or(page.locator('.status-dot-error'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.status-dot-error')).toHaveCount(0);

  const textHitboxes = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(textHitboxes).toHaveCount(1);
  await textHitboxes.first().click();
  const originalText = page.getByRole('textbox', { name: 'Original text', exact: true });
  await expect(originalText).toHaveValue('Hello PDF Editor');

  await originalText.focus();
  await originalText.press('ControlOrMeta+Home');
  for (let index = 0; index < 6; index++) await originalText.press('ArrowRight');
  for (let index = 0; index < 3; index++) await originalText.press('Shift+ArrowRight');
  await expect(originalText).toHaveJSProperty('selectionStart', 6);
  await expect(originalText).toHaveJSProperty('selectionEnd', 9);
  await expect(page.getByRole('textbox', { name: 'Replacement', exact: true })).toHaveValue('PDF');

  await page.getByLabel('Selection color', { exact: true }).fill('#ff0000');
  await page.getByRole('button', { name: 'Apply selection format', exact: true }).click();

  await expect(textHitboxes).toHaveCount(3);
  await textHitboxes.nth(0).click();
  await expect(originalText).toHaveValue('Hello ');
  await textHitboxes.nth(1).click();
  await expect(originalText).toHaveValue('PDF');
  await textHitboxes.nth(2).click();
  await expect(originalText).toHaveValue(' Editor');

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(textHitboxes).toHaveCount(1);
  await textHitboxes.first().click();
  await expect(originalText).toHaveValue('Hello PDF Editor');

  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(textHitboxes).toHaveCount(3);
  await textHitboxes.nth(1).click();
  await expect(originalText).toHaveValue('PDF');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  expect(saved.equals(original)).toBe(false);

  page.once('dialog', async dialog => {
    page.once('dialog', discard => discard.accept());
    await dialog.dismiss();
  });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'saved-styled.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByText('saved-styled.pdf', { exact: true })).toBeVisible();

  const reopenedHitboxes = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(reopenedHitboxes).toHaveCount(3);
  await reopenedHitboxes.nth(1).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('PDF');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  expect(posts).toEqual([]);
});

test('real WASM manages pages, transforms objects and inserts vector PDF content', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'objects.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  const textObject = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(textObject).toHaveCount(1, { timeout: 60_000 });
  const originalId = await textObject.getAttribute('data-object-id');
  const originalLeft = await textObject.evaluate(element => parseFloat((element as HTMLElement).style.left));
  await textObject.click();
  await page.getByRole('button', { name: 'Move selected objects', exact: true }).click();
  await expect.poll(() => textObject.evaluate(element => parseFloat((element as HTMLElement).style.left))).toBeCloseTo(originalLeft + 12.5, 1);
  await expect(textObject).toHaveAttribute('data-object-id', originalId!);
  await page.getByRole('button', { name: 'Add blank page', exact: true }).click();
  await expect(page.locator('.page-chip')).toHaveCount(2);
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await expect(page.locator('.object-hitbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Move page earlier', exact: true }).click();
  await expect(page.locator('.page-chip-active')).toHaveAttribute('aria-label', 'Open page 1');
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await expect(textObject).toHaveAttribute('data-object-id', originalId!);
  await page.getByRole('button', { name: 'Duplicate page', exact: true }).click();
  await expect(page.locator('.page-chip')).toHaveCount(3);
  await page.getByRole('button', { name: 'Open page 3', exact: true }).click();
  await expect(textObject).not.toHaveAttribute('data-object-id', originalId!);
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await expect(textObject).toHaveAttribute('data-object-id', originalId!);
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import PDF pages', exact: true }).click();
  await (await chooser).setFiles({ name: 'import.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.locator('.page-chip')).toHaveCount(4);
  await textObject.click();
  await page.getByRole('button', { name: 'Duplicate selected objects', exact: true }).click();
  await expect(textObject).toHaveCount(2);
  await page.getByText('Insert & format', { exact: true }).click();
  const imageBytes = async (color: string) => Buffer.from(await page.evaluate(color => {
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, color), 'base64');
  const red = await imageBytes('#ff0000'), green = await imageBytes('#00ff00');
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert image', exact: true }).click();
  await (await chooser).setFiles({ name: 'red.png', mimeType: 'image/png', buffer: red });
  const image = page.locator('.object-hitbox[data-object-type="image"]');
  await expect(image).toHaveCount(1);
  const imageId = await image.getAttribute('data-object-id');
  const sample = (x: number, y: number) => page.locator('canvas.pdf-canvas').evaluate((element, point) => {
    const canvas = element as HTMLCanvasElement;
    return [...canvas.getContext('2d')!.getImageData(Math.floor(canvas.width * point.x / 300), Math.floor(canvas.height * point.y / 300), 1, 1).data];
  }, { x, y });
  await expect.poll(() => sample(180, 120)).toEqual([255, 0, 0, 255]);
  await image.click();
  await page.getByRole('region', { name: 'Page and object editing' }).getByRole('spinbutton', { name: 'Width (pt)', exact: true }).fill('60');
  await page.getByRole('region', { name: 'Page and object editing' }).getByRole('spinbutton', { name: 'Height (pt)', exact: true }).fill('60');
  await page.getByRole('button', { name: 'Crop selected image to box', exact: true }).click();
  await expect.poll(() => sample(180, 120)).toEqual([255, 255, 255, 255]);
  await expect.poll(() => sample(65, 65)).toEqual([255, 0, 0, 255]);
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace selected image', exact: true }).click();
  await (await chooser).setFiles({ name: 'green.png', mimeType: 'image/png', buffer: green });
  await expect(image).toHaveAttribute('data-object-id', imageId!);
  await expect.poll(() => sample(65, 65)).toEqual([0, 255, 0, 255]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => sample(65, 65)).toEqual([255, 0, 0, 255]);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => sample(65, 65)).toEqual([0, 255, 0, 255]);
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert PDF content', exact: true }).click();
  await (await chooser).setFiles({ name: 'diagram.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  const form = page.locator('.object-hitbox[data-object-type="form"]');
  await expect(form).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(form).toHaveCount(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'saved-objects.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByText('saved-objects.pdf', { exact: true })).toBeVisible();
  await expect(page.locator('.page-chip')).toHaveCount(4);
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await expect(form).toHaveCount(1);
  await expect(image).toHaveCount(1);
  await expect.poll(() => sample(65, 65)).toEqual([0, 255, 0, 255]);
  await page.getByRole('button', { name: 'Open page 1', exact: true }).click();
  await page.getByRole('region', { name: 'Page and object editing' }).getByRole('combobox', { name: 'Font', exact: true }).selectOption('liberation-sans-bold');
  await page.getByRole('textbox', { name: 'New text', exact: true }).fill('Bold text');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Select Text object', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Bold text');
  const fontDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const withFont = await readFile((await (await fontDownload).path())!);
  await page.getByRole('navigation', { name: 'Open PDFs' }).getByRole('button', { name: /^objects\.pdf/ }).click();
  page.once('dialog', async dialog => { page.once('dialog', discard => discard.accept()); await dialog.dismiss(); });
  await page.getByRole('button', { name: 'Close PDF', exact: true }).click();
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'saved-font.pdf', mimeType: 'application/pdf', buffer: withFont });
  await expect(page.getByText('saved-font.pdf', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select Text object', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Bold text');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('real WASM embeds CJK OpenType faces and preserves searchable text after reopening', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'cff.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(1, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Add blank page', exact: true }).click();
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await page.getByText('Insert & format', { exact: true }).click();
  await page.getByRole('region', { name: 'Page and object editing' }).getByRole('spinbutton', { name: 'Height (pt)', exact: true }).fill('24');
  const faces = ['noto-sans-cjk-sc-regular', 'noto-sans-cjk-sc-bold', 'noto-serif-cjk-sc-regular', 'noto-serif-cjk-sc-bold'];
  for (const [index, font] of faces.entries()) {
    await page.getByRole('region', { name: 'Page and object editing' }).getByRole('combobox', { name: 'Font', exact: true }).selectOption(font);
    await page.getByRole('region', { name: 'Page and object editing' }).getByRole('spinbutton', { name: 'Y (pt)', exact: true }).fill(String(36 + index * 40));
    await page.getByRole('textbox', { name: 'New text', exact: true }).fill(`第一行中文 ABC ${index + 1}`);
    await page.getByRole('button', { name: 'Insert text', exact: true }).click();
    await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(index + 1, { timeout: 30_000 });
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(3);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(4);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  expect(saved.includes(Buffer.from('/FontFile3'))).toBe(true);
  expect(saved.includes(Buffer.from('/CIDFontType0'))).toBe(true);
  page.once('dialog', async dialog => { page.once('dialog', discard => discard.accept()); await dialog.dismiss(); });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'saved-cff.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByText('saved-cff.pdf', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  const objects = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(objects).toHaveCount(4);
  for (let index = 0; index < 4; index++) {
    await objects.nth(index).click();
    await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue(`第一行中文 ABC ${index + 1}`);
  }
  expect(await page.locator('canvas.pdf-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset]! < 128) ink++;
    return ink;
  })).toBeGreaterThan(200);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('real WASM imports a chosen collection face for editing and save/reopen', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'font-import.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(1, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Select Text object', exact: true }).click();
  await page.getByRole('textbox', { name: 'Replacement', exact: true }).fill('Imported draft');
  await page.getByText('Import & system fonts', { exact: true }).click();
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import font file', exact: true }).click();
  await (await chooser).setFiles('tmp/font-runtime/liberation-two-faces.ttc');
  const face = page.getByRole('combobox', { name: 'Font face', exact: true });
  await expect(face.locator('option')).toHaveCount(2);
  await face.selectOption('1');
  await expect(face).toHaveValue('1');
  await page.getByRole('button', { name: 'Add selected font', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Added Liberation Serif' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Replacement', exact: true })).toHaveValue('Imported draft');
  await page.getByRole('region', { name: 'Manual text editing' }).getByRole('button', { name: 'Discard draft', exact: true }).click();
  // Registration alone is not a PDF edit.
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Add blank page', exact: true }).click();
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await page.getByText('Insert & format', { exact: true }).click();
  const font = page.getByRole('region', { name: 'Page and object editing' }).getByRole('combobox', { name: 'Font', exact: true });
  const importedId = await font.locator('option[value^="user-font-"]').getAttribute('value');
  expect(importedId).toBeTruthy();
  await font.selectOption(importedId!);
  await page.getByRole('textbox', { name: 'New text', exact: true }).fill('Imported italic');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Select Text object', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Imported italic');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  expect(saved.includes(Buffer.from('LiberationSerif-Italic'))).toBe(true);
  page.once('dialog', async dialog => { page.once('dialog', discard => discard.accept()); await dialog.dismiss(); });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'saved-import.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByText('saved-import.pdf', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await page.getByRole('button', { name: 'Select Text object', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Imported italic');
});

test('real WASM lays out multiline text boxes and rejects overflow before committing', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'multiline.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(1, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Add blank page', exact: true }).click();
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await page.getByText('Insert & format', { exact: true }).click();
  await page.getByRole('region', { name: 'Page and object editing' }).getByRole('combobox', { name: 'Font', exact: true }).selectOption('noto-sans-cjk-sc-regular');
  await page.getByRole('region', { name: 'Page and object editing' }).getByRole('spinbutton', { name: 'Width (pt)', exact: true }).fill('140');
  await page.getByRole('region', { name: 'Page and object editing' }).getByRole('spinbutton', { name: 'Height (pt)', exact: true }).fill('4');
  await page.getByRole('spinbutton', { name: 'Line height (em)', exact: true }).fill('1.5');
  await page.getByRole('combobox', { name: 'Text alignment', exact: true }).selectOption('center');
  await page.getByRole('textbox', { name: 'New text', exact: true }).fill('第一行中文\nSecond line\n第三行');
  await page.getByRole('button', { name: 'Preview text box', exact: true }).click();
  await expect(page.getByText('Text box overflow · 3 lines', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Insert text', exact: true })).toBeDisabled();
  const objects = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(objects).toHaveCount(0);
  await page.getByRole('region', { name: 'Page and object editing' }).getByRole('spinbutton', { name: 'Height (pt)', exact: true }).fill('100');
  await page.getByRole('button', { name: 'Preview text box', exact: true }).click();
  await expect(page.getByText('Text fits box · 3 lines', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await expect(objects).toHaveCount(3);
  expect(await objects.first().evaluate(element => parseFloat((element as HTMLElement).style.left))).toBeGreaterThan(36 * 1.25);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(objects).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(objects).toHaveCount(3);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  page.once('dialog', async dialog => { page.once('dialog', discard => discard.accept()); await dialog.dismiss(); });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'saved-multiline.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByText('saved-multiline.pdf', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await expect(objects).toHaveCount(3);
  for (const [index, text] of ['第一行中文', 'Second line', '第三行'].entries()) {
    await objects.nth(index).click();
    await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue(text);
  }
  await page.getByRole('region', { name: 'Page and object editing' }).getByRole('spinbutton', { name: 'Y (pt)', exact: true }).fill('140');
  await page.getByRole('region', { name: 'Page and object editing' }).getByRole('spinbutton', { name: 'Width (pt)', exact: true }).fill('80');
  await page.getByRole('textbox', { name: 'New text', exact: true }).fill('Wrap words over multiple lines automatically.');
  await page.getByRole('button', { name: 'Preview text box', exact: true }).click();
  await expect(page.getByText(/Text fits box · [2-9] lines/)).toBeVisible();
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await expect.poll(() => objects.count()).toBeGreaterThan(4);
});

test('real browser authorizes local font access and registers a system face without editing the PDF', async ({ page, context }) => {
  await context.grantPermissions(['local-fonts']);
  await page.goto('/editor/');
  await page.getByText('Import & system fonts', { exact: true }).click();
  await page.getByRole('button', { name: 'Browse system fonts', exact: true }).click();
  const fonts = page.getByRole('combobox', { name: 'System font', exact: true });
  await expect(fonts.locator('option').filter({ hasText: /^Arial$/ })).toHaveCount(1);
  await fonts.selectOption({ label: 'Arial' });
  await page.getByRole('button', { name: 'Inspect system font', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Font face', exact: true }).locator('option')).toContainText(['Arial']);
  await page.getByRole('button', { name: 'Add selected font', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Added Arial' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('real local export protects, opens with a password, and removes protection without resetting history', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'protection.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(1, { timeout: 60_000 });
  await page.getByText('Protection & export', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Copy protection', exact: true }).selectOption('set');
  const password = 'local-密码-2026';
  await page.getByLabel('New PDF password', { exact: true }).fill(password);
  await page.getByLabel('Confirm PDF password', { exact: true }).fill(password);
  await page.getByRole('checkbox', { name: 'Optimize structure without image quality loss' }).check();
  let download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF copy', exact: true }).click();
  const protectedPdf = await readFile((await (await download).path())!);
  expect(protectedPdf.includes(Buffer.from('/Encrypt'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'protected.pdf', mimeType: 'application/pdf', buffer: protectedPdf });
  await page.getByLabel('PDF password', { exact: true }).fill('wrong-synthetic-password');
  await page.getByRole('button', { name: 'Open with password', exact: true }).click();
  await expect(page.getByText('The password was not accepted. Try again or cancel.', { exact: true })).toBeVisible();
  await page.getByLabel('PDF password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Open with password', exact: true }).click();
  await expect(page.getByText('protected.pdf', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select Text object', exact: true }).click();
  await page.getByRole('textbox', { name: 'Replacement', exact: true }).fill('Edited');
  await page.getByRole('button', { name: 'Preview layout', exact: true }).click();
  await page.getByRole('button', { name: 'Commit replacement', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Edited');
  download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const preserved = await readFile((await (await download).path())!);
  expect(preserved.includes(Buffer.from('/Encrypt'))).toBe(true);
  await page.getByRole('combobox', { name: 'Copy protection', exact: true }).selectOption('remove');
  download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF copy', exact: true }).click();
  const decrypted = await readFile((await (await download).path())!);
  expect(decrypted.includes(Buffer.from('/Encrypt'))).toBe(false);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Hello PDF Editor');
  await page.getByRole('navigation', { name: 'Open PDFs' }).getByRole('button', { name: 'protection.pdf' }).click();
  await page.getByRole('button', { name: 'Close PDF', exact: true }).click();
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'decrypted.pdf', mimeType: 'application/pdf', buffer: decrypted });
  await expect(page.getByText('decrypted.pdf', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Open encrypted PDF', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select Text object', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Original text', exact: true })).toHaveValue('Edited');
  expect(posts).toEqual([]);
});

function syntheticPdf(pageAttributes = '/MediaBox [0 0 300 300]'): Buffer {
  const stream = 'q 1 0 0 rg 20 20 50 50 re f Q\nBT /F1 18 Tf 20 240 Td (Hello PDF Editor) Tj ET';
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

for (const fixture of [
  { name: 'plain', pageAttributes: '/MediaBox [0 0 300 300]', width: 300, height: 300, redX: 45, redY: 255 },
  { name: 'rotated-cropped-user-unit', pageAttributes: '/MediaBox [-10 -20 300 500] /CropBox [10 20 210 320] /Rotate 90 /UserUnit 2', width: 600, height: 400, redX: 50, redY: 70 },
]) {
test(`real WASM reads and preserves ${fixture.name} PDF without uploading it`, async ({ page }) => {
  const posts: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto('/editor/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const bytes = syntheticPdf(fixture.pageAttributes);
  await (await chooser).setFiles({ name: 'reader-smoke.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByText('reader-smoke.pdf', { exact: true }).or(page.locator('.status-dot-error'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.status-dot-error'), await page.locator('.editor-statusbar').innerText()).toHaveCount(0);
  await expect(page.getByText('reader-smoke.pdf', { exact: true })).toBeVisible();
  const canvas = page.locator('canvas.pdf-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element, fixture) => {
    const canvas = element as HTMLCanvasElement;
    return [...canvas.getContext('2d')!.getImageData(Math.floor(canvas.width * fixture.redX / fixture.width), Math.floor(canvas.height * fixture.redY / fixture.height), 1, 1).data];
  }, fixture)).toEqual([255, 0, 0, 255]);
  await expect(page.locator('.object-hitbox')).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('reader-smoke.pdf');
  const saved = await readFile((await file.path())!);
  expect(saved.equals(bytes)).toBe(true);
  expect(posts).toEqual([]);
});
}

test('web editor retains two independent PDFs and refuses a third until one closes', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'first.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.getByRole('navigation', { name: 'Open PDFs' }).getByRole('button', { name: 'first.pdf' })).toBeVisible();
  await page.getByRole('button', { name: 'Select Text object' }).click();
  await page.getByRole('textbox', { name: 'Replacement' }).fill('Hello AI Editor');
  await page.getByRole('button', { name: 'Preview layout' }).click();
  await page.getByRole('button', { name: 'Commit replacement' }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Hello AI Editor');

  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const second = Buffer.from(syntheticPdf().toString('latin1').replaceAll('Hello PDF Editor', 'Other PDF Editor'), 'latin1');
  await (await chooser).setFiles({ name: 'second.pdf', mimeType: 'application/pdf', buffer: second });
  const tabs = page.getByRole('navigation', { name: 'Open PDFs' });
  await expect(tabs.getByRole('button')).toHaveCount(2);
  await expect(tabs.getByRole('button', { name: /first\.pdf/ })).toContainText('●');
  await page.getByRole('button', { name: 'Select Text object' }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Other PDF Editor');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await expect(page.getByText(/can keep only 2 PDFs open/)).toBeVisible();

  await tabs.getByRole('button', { name: /first\.pdf/ }).click();
  await page.getByRole('button', { name: 'Select Text object' }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Hello AI Editor');
  page.once('dialog', async dialog => {
    page.once('dialog', discard => discard.accept());
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Close PDF' }).click();
  await expect(tabs.getByRole('button')).toHaveCount(1);
  await expect(tabs.getByRole('button', { name: 'second.pdf' })).toHaveAttribute('aria-current', 'page');
});

test('PDF search locates each occurrence at its UTF-16 text range', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'search.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  const search = page.getByRole('region', { name: 'Search PDF' });
  await search.getByText('Search PDF', { exact: true }).click();
  await search.getByRole('textbox', { name: 'Find text' }).fill('l');
  await search.getByRole('button', { name: 'Find', exact: true }).click();
  const hits = search.getByRole('button', { name: /Page 1, character/ });
  await expect(hits).toHaveCount(2);
  await hits.nth(1).click();
  const original = page.getByRole('textbox', { name: 'Original text' });
  await expect(original).toHaveValue('Hello PDF Editor');
  await expect(original).toHaveJSProperty('selectionStart', 3);
  await expect(original).toHaveJSProperty('selectionEnd', 4);
});
