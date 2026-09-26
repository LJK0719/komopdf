import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'interaction.pdf', mimeType: 'application/pdf', buffer: samplePdf() });
  await expect(page.locator('.document-pages .page-wrap')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

test('continuous reading, facing pages, single-page navigation and hand tool', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Ask komo', exact: true })).toHaveCount(0);
  await expect(page.locator('.object-hitbox')).toHaveCount(0);
  await expect(page.locator('.inspector-panel')).toBeHidden();
  await page.locator('.canvas-stage').evaluate(element => { element.scrollTop = 930; });
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'Open page 3', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: 'Facing pages', exact: true }).click();
  await expect(page.locator('.document-pages')).toHaveClass(/document-pages-double/);
  await page.getByRole('button', { name: 'Continuous scrolling', exact: true }).click();
  await expect(page.locator('.document-pages .page-wrap')).toHaveCount(1);
  await page.getByRole('button', { name: 'Single page', exact: true }).click();
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'Hand', exact: true }).click();
  await expect(page.locator('.canvas-stage')).toHaveClass(/hand-tool/);
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
  await expect(page.getByRole('button', { name: '连续阅读', exact: true })).toBeVisible();
  await page.screenshot({ path: 'tmp/browser/ribbon-reading-zh.png' });
});

test('edit text in place, format, context menu, delete, undo, save and reopen', async ({ page }) => {
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  const text = page.locator('.object-hitbox[data-object-type="text"]').first();
  await expect(text).toBeVisible();
  await text.dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toHaveValue('Alpha');
  await page.screenshot({ path: 'tmp/browser/ribbon-inline-text.png' });
  await expect(page.locator('.inspector-panel')).toBeHidden();
  await input.fill('Alto');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await text.dblclick();
  await expect(input).toHaveValue('Alto');
  await input.press('Escape');
  await text.click();
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('16');
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).press('Enter');
  await expect(page.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('16');
  await text.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /^Edit text\b/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await text.click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(text).toBeVisible();
  await page.screenshot({ path: 'tmp/browser/ribbon-text-edit.png' });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'saved.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await text.dblclick();
  await expect(input).toHaveValue('Alto');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('image contextual tools crop and replace real PDF content', async ({ page }) => {
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  const image = page.locator('.object-hitbox[data-object-type="image"]');
  await image.click();
  await expect(page.getByText('Image editing', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'tmp/browser/ribbon-image.png' });
  await image.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Crop image', exact: true }).click();
  const crop = await page.locator('.crop-overlay').boundingBox();
  await page.mouse.move(crop!.x + 10, crop!.y + 10);
  await page.mouse.down();
  await page.mouse.move(crop!.x + crop!.width - 12, crop!.y + crop!.height - 12, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(page.locator('.crop-overlay')).toHaveCount(0);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await image.click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8; const context = canvas.getContext('2d')!; context.fillStyle = '#2255dd'; context.fillRect(0, 0, 8, 8); return canvas.toDataURL('image/png').split(',')[1]!; });
  await (await chooser).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('.status-message')).toHaveText('Changes applied');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('search and replace, insert text, and save edits by clicking outside', async ({ page }) => {
  await page.getByRole('navigation', { name: 'Quick tools' }).getByRole('button', { name: 'Find & replace' }).click();
  await page.getByRole('textbox', { name: 'Find text', exact: true }).fill('Bravo');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await page.getByRole('button', { name: 'Page 2: Bravo', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('2');
  await page.getByRole('textbox', { name: 'Replace with', exact: true }).fill('Brave');
  await page.getByRole('button', { name: 'Replace selected match', exact: true }).click();
  await expect(page.locator('.status-message')).toHaveText('Changes applied');
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toHaveValue('Brave');
  await input.fill('Bravo');
  await page.locator('.page-wrap[data-page-number="2"]').click({ position: { x: 360, y: 250 } });
  await expect(input).toHaveCount(0);
  await page.locator('.object-hitbox[data-object-type="text"]').dblclick();
  await expect(input).toHaveValue('Bravo');
  await input.press('Escape');
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await page.locator('.placement-layer').click({ position: { x: 80, y: 320 } });
  await expect(input).toHaveValue('New text');
  await input.fill('Added');
  await input.press('Control+Enter');
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(2);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('font family and bold italic remain consistent after edits and a fresh reopen', async ({ page }) => {
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').click();
  const font = page.getByRole('combobox', { name: 'Font', exact: true });
  const bold = page.getByRole('button', { name: 'Bold', exact: true });
  const italic = page.getByRole('button', { name: 'Italic', exact: true });
  expect(await font.locator('option').count()).toBeGreaterThanOrEqual(39);
  await expect(font).toHaveValue('Helvetica');
  const started = Date.now();
  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(font).toHaveValue('Arimo');
  console.log('Initial automatic bold:', Date.now() - started, 'ms');
  await italic.click();
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
  await font.selectOption('Inter');
  await expect(font).toHaveValue('Inter');
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  page.once('dialog', dialog => void dialog.accept());
  await page.reload();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'font-roundtrip.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').click();
  await expect(font).toHaveValue('Inter');
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.object-hitbox[data-object-type="text"]').dblclick();
  const editor = page.getByRole('textbox', { name: 'Page text', exact: true });
  await editor.fill('Alto');
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await page.locator('.object-hitbox[data-object-type="text"]').dblclick();
  await expect(editor).toHaveValue('Alto');
  await editor.press('Escape');
  await expect(font).toHaveValue('Inter');
  await expect(page.locator('.property-error')).toHaveCount(0);
  await page.screenshot({ path: 'tmp/browser/font-family-roundtrip.png' });
});

test('Chinese text uses its own bold and oblique faces without asking to choose a font', async ({ page }) => {
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await page.locator('.placement-layer').click({ position: { x: 50, y: 300 } });
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('中文');
  await input.press('Control+Enter');
  const font = page.getByRole('combobox', { name: 'Font', exact: true });
  await expect(font).toHaveValue('Noto Sans CJK SC');
  const start = Date.now();
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 30000 });
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 30000 });
  await expect(font).toHaveValue('Noto Sans CJK SC');
  console.log('Chinese bold + oblique:', Date.now() - start, 'ms');
  const warm = Date.now();
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  console.log('Chinese warm off/on:', Date.now() - warm, 'ms');
  await font.selectOption('Zhuque Fangsong (technical preview)');
  await expect(font).toBeEnabled({ timeout: 30000 });
  await expect(font).toHaveValue('Zhuque Fangsong (technical preview)');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.property-error')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
  await page.screenshot({ path: 'tmp/browser/font-chinese-bold-oblique.png' });
});

test('local font metadata does not add an embedding-permission gate', async ({ page }) => {
  const fontBytes = Buffer.from(await readFile('resources/downloads/fonts/library/arimo/arimo-regular.ttf'));
  let head = 0;
  for (let index = 0; index < fontBytes.readUInt16BE(4); index++) {
    const entry = 12 + index * 16;
    const tag = fontBytes.toString('ascii', entry, entry + 4);
    const offset = fontBytes.readUInt32BE(entry + 8), length = fontBytes.readUInt32BE(entry + 12);
    if (tag === 'head') head = offset;
    if (tag === 'OS/2') {
      fontBytes.writeUInt16BE(2, offset + 8);
      let checksum = 0;
      for (let pos = offset; pos < offset + length; pos += 4) checksum = (checksum + fontBytes.readUInt32BE(pos)) >>> 0;
      fontBytes.writeUInt32BE(checksum, entry + 4);
    }
  }
  fontBytes.writeUInt32BE(0, head + 8);
  let checksum = 0;
  for (let pos = 0; pos < fontBytes.length; pos += 4) checksum = (checksum + fontBytes.readUInt32BE(pos)) >>> 0;
  fontBytes.writeUInt32BE((0xb1b0afba - checksum) >>> 0, head + 8);
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Fonts', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import font file', exact: true }).click();
  await (await chooser).setFiles({ name: 'font-metadata-fixture.ttf', mimeType: 'font/ttf', buffer: fontBytes });
  const add = page.getByRole('button', { name: 'Add selected font', exact: true });
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByRole('region', { name: 'Fonts', exact: true })).toContainText('Font added:');
  await expect(page.getByText(/embedding restricted|does not permit editable/)).toHaveCount(0);
});

test('mixed page sizes do not resize unvisited pages while scrolling', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: /Open/ }).click();
  await (await chooser).setFiles({ name: 'mixed-sizes.pdf', mimeType: 'application/pdf', buffer: samplePdf(12, true) });
  const lastPage = page.locator('.page-wrap[data-page-number="12"]');
  await expect(lastPage).toHaveCSS('height', '750px');
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('2');
  await expect(page.locator('.page-wrap[data-page-number="2"]')).toHaveCSS('height', '300px');
  await expect(lastPage).toHaveCSS('height', '750px');
});

test('page overview supports standard multiselect, snapshot copy/paste, delete and undo', async ({ page }) => {
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Pages', exact: true }).click();
  const tiles = page.locator('.organizer-page');
  await expect(tiles).toHaveCount(3);
  const boxes = await tiles.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  expect(new Set(boxes).size).toBe(1);
  await tiles.nth(0).click();
  await tiles.nth(2).click({ modifiers: ['Shift'] });
  await expect(page.locator('.organizer-page[aria-selected=true]')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Delete selected pages', exact: true })).toBeDisabled();
  await tiles.nth(1).click({ modifiers: ['Control'] });
  await tiles.nth(2).click({ button: 'right' });
  await expect(page.locator('.organizer-page[aria-selected=true]')).toHaveCount(2);
  await page.getByRole('menuitem', { name: 'Copy pages', exact: false }).click();
  await expect(page.locator('.status-message')).toHaveText('Pages copied. Paste them anywhere in this PDF.');
  await page.getByRole('button', { name: 'Delete selected pages', exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await page.getByRole('button', { name: 'Paste pages', exact: true }).click();
  await expect(tiles).toHaveCount(3);
  await expect(page.locator('.organizer-page[aria-selected=true]')).toHaveCount(2);
  await tiles.nth(1).dblclick();
  await expect(page.locator('.pdf-text-layer').filter({ hasText: 'Alpha' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(page.locator('.page-chip')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(page.locator('.page-chip')).toHaveCount(3);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('page overview zoom, Mac modifiers, drag reorder and saved order', async ({ page }) => {
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Pages', exact: true }).click();
  const tiles = page.locator('.organizer-page');
  await tiles.nth(0).click();
  await tiles.nth(2).click({ modifiers: ['Meta'] });
  await expect(page.locator('.organizer-page[aria-selected=true]')).toHaveCount(2);
  await tiles.nth(0).click();
  const order = await tiles.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.organizerPage));
  await tiles.nth(0).dragTo(tiles.nth(2), { targetPosition: { x: 200, y: 80 } });
  await expect(tiles.nth(2)).toHaveAttribute('data-organizer-page', order[0]!);
  const stage = page.locator('.canvas-stage');
  const thumbnailWidth = (await tiles.first().locator('canvas').boundingBox())!.width;
  await stage.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -600);
  await page.keyboard.up('Control');
  await expect(page.getByRole('combobox', { name: 'Page columns' })).toHaveValue('0');
  await expect.poll(async () => (await tiles.first().locator('canvas').boundingBox())!.width).toBeGreaterThan(thumbnailWidth);
  await expect.poll(() => tiles.evaluateAll(nodes => new Set(nodes.map(node => node.getBoundingClientRect().top)).size)).toBeGreaterThan(1);
  await page.getByRole('combobox', { name: 'Page columns' }).selectOption('3');
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
  await page.screenshot({ path: 'tmp/browser/page-overview-zh.png' });
  await page.getByRole('combobox', { name: '语言' }).selectOption('en');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'reordered.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.pdf-text-layer').first()).toContainText('Bravo');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('reading selection shows a caret and enters in-place editing at the selected range', async ({ page }) => {
  const span = page.locator('.page-wrap[data-page-number="1"] [data-text-object]').first();
  await span.click({ position: { x: 2, y: 5 } });
  await expect(page.locator('.reading-caret')).toBeVisible();
  await span.evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, 2);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await span.click({ button: 'right', position: { x: 5, y: 5 } });
  await expect(page.getByRole('menuitem', { name: 'Highlight selection' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Edit selected text' }).click();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toHaveValue('Alpha');
  expect(await input.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([0, 2]);
  await input.press('Backspace'); await input.press('A');
  await input.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await page.locator('.object-hitbox[data-object-type="text"]').dblclick();
  await expect(input).toHaveValue('Apha');
  await input.press('Escape');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.locator('.page-wrap[data-page-number="1"] .pdf-text-layer').click({ button: 'right', position: { x: 260, y: 300 } });
  await page.getByRole('menuitem', { name: 'Add text here' }).click();
  await expect(input).toHaveValue('New text');
  await input.fill('Inserted'); await input.press('Control+Enter');
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(2);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('reading text context applies actual highlight and underline commands', async ({ page }) => {
  const span = page.locator('.page-wrap[data-page-number="1"] [data-text-object]').first();
  const selectText = async () => {
    await span.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
    await span.click({ button: 'right' });
  };
  await selectText();
  await page.getByRole('menuitem', { name: 'Highlight selection' }).click();
  await expect(page.locator('.status-message')).toHaveText('Changes applied');
  await selectText();
  await page.getByRole('menuitem', { name: 'Underline text' }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await selectText();
  await page.getByRole('menuitem', { name: 'Edit selected text' }).click();
  await expect(page.getByRole('button', { name: 'Underline', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'tmp/browser/reading-context-edit.png' });
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('crop current page with a rectangle and open page decoration tools directly', async ({ page }) => {
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Crop current page', exact: true }).click();
  const crop = await page.locator('.page-crop-overlay').boundingBox();
  await page.mouse.move(crop!.x + 40, crop!.y + 90); await page.mouse.down();
  await page.mouse.move(crop!.x + 400, crop!.y + 420, { steps: 4 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(page.locator('.page-crop-overlay')).toHaveCount(0);
  await expect(page.locator('.page-wrap[data-page-number="1"]')).toHaveCSS('width', '360px');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(page.locator('.page-wrap[data-page-number="1"]')).toHaveCSS('width', '525px');
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('button', { name: 'Watermark', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Decoration', exact: true })).toHaveValue('watermark');
  await page.getByRole('button', { name: 'Header & footer', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Decoration', exact: true })).toHaveValue('header');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

function samplePdf(count = 3, mixed = false) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`,
  ];
  for (let i = 0; i < count; i++) {
    const text = ['Alpha', 'Bravo', 'Charlie'][i] ?? `Page ${i + 1}`;
    const width = mixed && i === 1 ? 800 : 420, height = mixed && i === 1 ? 240 : 600;
    const content = `BT /F1 20 Tf 45 ${height - 90} Td (${text}) Tj ET q 100 0 0 80 45 ${height - 220} cm /Im1 Do Q`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${3 + count * 2} 0 R >> /XObject << /Im1 ${4 + count * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n228855>\nendstream');
  let output = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(output); output += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
