import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clickRibbonCommand } from './editor-ui-helpers';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
});

async function openForms(page: Page) {
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Fill & sign', exact: true }).click();
  await clickRibbonCommand(page, 'Fill & forms');
  return page.getByRole('region', { name: 'Annotations and forms', exact: true });
}

async function dragOnPage(page: Page, surface: Locator, bounds: [number, number, number, number]) {
  await expect(surface).toBeVisible();
  await expect(surface).toHaveCSS('pointer-events', 'auto');
  await surface.hover();
  const rect = (await surface.boundingBox())!;
  await page.mouse.move(rect.x + rect.width * bounds[0], rect.y + rect.height * bounds[1]);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * bounds[2], rect.y + rect.height * bounds[3], { steps: 5 });
  await page.mouse.up();
}

async function drawField(page: Page, bounds: [number, number, number, number] = [0.12, 0.4, 0.72, 0.51]) {
  await page.getByRole('button', { name: 'Draw field on page', exact: true }).click();
  await dragOnPage(page, page.getByLabel('Placement area', { exact: true }), bounds);
}

async function openFieldProperties(page: Page, field: Locator) {
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  await expect(field.getByRole('button', { name: 'Apply value', exact: true })).toBeEnabled();
  const details = field.locator('details');
  if (await details.getAttribute('open') === null) {
    await details.locator('summary').click();
  }
}

test('form value and property drafts survive applying the other category and committed drafts follow undo', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'form-drafts.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled({ timeout: 60_000 });
  const forms = await openForms(page);
  await forms.locator('summary').filter({ hasText: 'Create a field' }).click();
  await forms.getByRole('textbox', { name: 'Field name', exact: true }).fill('DraftField');
  await drawField(page);
  const field = page.locator('.document-field').filter({ hasText: 'DraftField' });
  await openFieldProperties(page, field);
  const value = field.getByRole('textbox', { name: 'Value', exact: true });
  const tooltip = field.getByRole('textbox', { name: 'Tooltip', exact: true });
  const applyProperties = field.getByRole('button', { name: 'Apply field properties', exact: true });
  const undo = page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true });
  const redo = page.getByRole('button', { name: 'Redo (Ctrl Shift Z)', exact: true });
  await expect(value).toBeVisible();

  await value.fill('Pending value');
  await tooltip.fill(' Saved tooltip ');
  await applyProperties.click();
  await openFieldProperties(page, field);
  await expect(tooltip).toHaveValue('Saved tooltip');
  await expect(value).toHaveValue('Pending value');
  await expect(applyProperties).toBeDisabled();
  await undo.click();
  await openFieldProperties(page, field);
  await expect(tooltip).toHaveValue('');
  await expect(value).toHaveValue('Pending value');
  await redo.click();
  await openFieldProperties(page, field);
  await expect(tooltip).toHaveValue('Saved tooltip');

  await tooltip.fill('Pending tooltip');
  await field.getByRole('button', { name: 'Apply value', exact: true }).click();
  await openFieldProperties(page, field);
  await expect(value).toHaveValue('Pending value');
  await expect(tooltip).toHaveValue('Pending tooltip');
  await expect(applyProperties).toBeEnabled();
  await undo.click();
  await openFieldProperties(page, field);
  await expect(value).toHaveValue('');
  await expect(tooltip).toHaveValue('Pending tooltip');
  await redo.click();
  await openFieldProperties(page, field);
  await expect(value).toHaveValue('Pending value');
  await expect(tooltip).toHaveValue('Pending tooltip');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('real WASM creates form fields, fills them, adds annotations, and retains them after save and reopen', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const original = syntheticPdf();
  await (await chooser).setFiles({ name: 'doc-tools.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page.getByRole('tab', { name: /^doc-tools\.pdf/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  const forms = await openForms(page);
  await forms.locator('summary').filter({ hasText: 'Create a field' }).click();

  // 1. Create a Chinese text form field using an embedded Noto font
  await page.getByLabel('Field name', { exact: true }).fill('中文姓名');
  await page.getByRole('combobox', { name: 'Field type', exact: true }).selectOption('text');
  await page.getByRole('combobox', { name: 'Field font', exact: true }).selectOption('noto-sans-cjk-sc-regular');
  await page.getByLabel('Font size', { exact: true }).fill('14');
  await drawField(page, [0.12, 0.12, 0.72, 0.23]);

  const nameField = page.locator('.document-field').filter({ hasText: '中文姓名' });
  await expect(nameField).toBeVisible({ timeout: 30_000 });

  // 2. Fill the text field with Chinese and ASCII text, then apply value
  await nameField.getByRole('textbox', { name: 'Value', exact: true }).fill('测试张三 ABC 123');
  await nameField.getByRole('button', { name: 'Apply value', exact: true }).click();
  await expect(nameField.getByRole('textbox', { name: 'Value', exact: true })).toHaveValue('测试张三 ABC 123');

  // 3. Create a checkbox field and check it
  await page.getByLabel('Field name', { exact: true }).fill('同意条款');
  await page.getByRole('combobox', { name: 'Field type', exact: true }).selectOption('checkbox');
  await drawField(page, [0.12, 0.27, 0.2, 0.35]);

  const checkboxField = page.locator('.document-field').filter({ hasText: '同意条款' });
  await expect(checkboxField).toBeVisible({ timeout: 30_000 });
  await checkboxField.getByRole('checkbox', { name: 'Checked' }).check();
  await checkboxField.getByRole('button', { name: 'Apply value', exact: true }).click();
  await expect(checkboxField.getByRole('checkbox', { name: 'Checked' })).toBeChecked();

  // 3b. Create and fill a real Unicode Choice field.
  await page.getByLabel('Field name', { exact: true }).fill('选择城市');
  await page.getByRole('combobox', { name: 'Field type', exact: true }).selectOption('combo');
  await page.getByRole('textbox', { name: 'Options (one per line)' }).fill('北京\n上海');
  await page.getByRole('combobox', { name: 'Field font', exact: true }).selectOption('noto-sans-cjk-sc-regular');
  await drawField(page, [0.12, 0.53, 0.72, 0.64]);
  const cityField = page.locator('.document-field').filter({ hasText: '选择城市' });
  await expect(cityField).toBeVisible();
  await cityField.getByRole('combobox', { name: 'Value', exact: true }).selectOption('上海');
  await cityField.getByRole('button', { name: 'Apply value', exact: true }).click();
  await expect(cityField.getByRole('combobox', { name: 'Value', exact: true })).toHaveValue('上海');

  // 3c. A radio group is one real AcroForm field with two independent Widgets.
  await page.getByLabel('Field name', { exact: true }).fill('选择颜色');
  await page.getByRole('combobox', { name: 'Field type', exact: true }).selectOption('radio');
  await page.getByRole('textbox', { name: 'Options (one per line)' }).fill('红色\n蓝色');
  await drawField(page, [0.12, 0.7, 0.72, 0.79]);
  const colorField = page.locator('.document-field').filter({ hasText: '选择颜色' });
  await expect(colorField).toBeVisible();
  await colorField.getByRole('combobox', { name: 'Value', exact: true }).selectOption('蓝色');
  await colorField.getByRole('button', { name: 'Apply value', exact: true }).click();
  await expect(colorField.getByRole('combobox', { name: 'Value', exact: true })).toHaveValue('蓝色');

  // 4. Add a Note annotation with undo/redo check
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Comment', exact: true }).click();
  await clickRibbonCommand(page, 'Sticky note');
  const annotationSurface = page.locator('.annotation-drawing-surface');
  const notePage = (await annotationSurface.boundingBox())!;
  await annotationSurface.click({ position: { x: notePage.width * 0.35, y: notePage.height * 0.4 } });
  const note = page.getByRole('form', { name: 'New note', exact: true });
  await note.getByRole('textbox', { name: 'New note', exact: true }).fill('审核批注测试 Note');
  await note.getByRole('button', { name: 'Add note', exact: true }).click();
  const comment = page.getByRole('dialog', { name: 'Comment', exact: true });
  await comment.getByRole('button', { name: 'Close comment', exact: true }).click();

  const annotationList = page.getByRole('list', { name: 'Document annotations', exact: true });
  await expect(annotationList).toContainText('审核批注测试 Note');

  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(annotationList.locator('li').filter({ hasText: '审核批注测试 Note' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Redo (Ctrl Shift Z)', exact: true }).click();
  await expect(annotationList).toContainText('审核批注测试 Note');

  // Edit the same PDF annotation rather than drawing a visual overlay.
  await annotationList.getByRole('button', { name: 'Go to Note on page 1', exact: true }).click();
  await comment.getByRole('button', { name: 'Edit comment', exact: true }).click();
  await comment.getByRole('textbox', { name: 'Comment text', exact: true }).fill('Updated note in the real PDF');
  await comment.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(annotationList).toContainText('Updated note in the real PDF');
  await expect(annotationList).not.toContainText('审核批注测试 Note');
  await comment.getByRole('button', { name: 'Close comment', exact: true }).click();

  await clickRibbonCommand(page, 'Rectangle');
  await dragOnPage(page, annotationSurface, [0.12, 0.4, 0.58, 0.5]);
  await expect(annotationList.locator('li')).toHaveCount(2);
  await page.keyboard.press('Escape');
  page.once('dialog', dialog => dialog.accept());
  await annotationList.getByRole('button', { name: 'Delete Rectangle annotation', exact: true }).click();
  await expect(annotationList.locator('li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(annotationList.locator('li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Redo (Ctrl Shift Z)', exact: true }).click();
  await expect(annotationList.locator('li')).toHaveCount(1);

  // 5. Save the modified document and verify changes were written
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  expect(saved.equals(original)).toBe(false);

  // 6. Reopen the saved document in a new tab.
  chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'saved-doc-tools.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByRole('tab', { name: /^saved-doc-tools\.pdf/ })).toBeVisible({ timeout: 60_000 });
  await openForms(page);

  // 7. Verify described form fields and annotation list remain intact in the reopened document
  const reopenedNameField = page.locator('.document-field').filter({ hasText: '中文姓名' });
  await expect(reopenedNameField).toBeVisible({ timeout: 30_000 });
  await expect(reopenedNameField.getByRole('textbox', { name: 'Value', exact: true })).toHaveValue('测试张三 ABC 123');

  const reopenedCheckboxField = page.locator('.document-field').filter({ hasText: '同意条款' });
  await expect(reopenedCheckboxField).toBeVisible({ timeout: 30_000 });
  await expect(reopenedCheckboxField.getByRole('checkbox', { name: 'Checked' })).toBeChecked();
  const reopenedCityField = page.locator('.document-field').filter({ hasText: '选择城市' });
  await expect(reopenedCityField.getByRole('combobox', { name: 'Value', exact: true })).toHaveValue('上海');
  const reopenedColorField = page.locator('.document-field').filter({ hasText: '选择颜色' });
  await expect(reopenedColorField.getByRole('combobox', { name: 'Value', exact: true })).toHaveValue('蓝色');

  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Comment', exact: true }).click();
  await clickRibbonCommand(page, 'Comment');
  await expect(page.locator('.document-tools-list')).toContainText('Updated note in the real PDF');
  await expect(page.locator('.document-tools-list').locator('li')).toHaveCount(1);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  expect(posts).toEqual([]);
});

test('real WASM groups adjacent objects, saves the Form, and ungroups after reopening', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'group-source.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.getByRole('tab', { name: /^group-source\.pdf/ })).toBeVisible({ timeout: 60_000 });
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await clickRibbonCommand(page, 'Edit content');

  const objects = page.locator('.selection-layer > [data-object-id]');
  await expect(objects).toHaveCount(2);
  await objects.nth(0).click();
  await objects.nth(1).click({ modifiers: ['Control'] });
  await clickRibbonCommand(page, 'Arrange objects');
  const arrangement = page.getByRole('region', { name: 'Page and object editing', exact: true });
  await expect(arrangement.getByRole('button', { name: 'Group', exact: true })).toBeEnabled();
  await arrangement.getByRole('button', { name: 'Group', exact: true }).click();
  await expect(page.locator('.selection-layer > [data-object-type="group"]')).toHaveCount(1);
  await expect(objects).toHaveCount(1);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  const reopen = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await reopen).setFiles({ name: 'group-saved.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByRole('tab', { name: /^group-saved\.pdf/ })).toBeVisible({ timeout: 60_000 });
  await clickRibbonCommand(page, 'Edit content');
  await expect(page.locator('.selection-layer > [data-object-type="group"]')).toHaveCount(1);

  await page.locator('.selection-layer > [data-object-type="group"]').click();
  await clickRibbonCommand(page, 'Arrange objects');
  await arrangement.getByRole('button', { name: 'Ungroup', exact: true }).click();
  await expect(objects).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(page.locator('.selection-layer > [data-object-type="group"]')).toHaveCount(1);
  await page.locator('.selection-layer > [data-object-type="group"]').click();
  await arrangement.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.locator('.selection-layer > [data-object-type="group"]')).toHaveCount(2);
  const copiedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const copied = await readFile((await (await copiedDownload).path())!);
  await page.getByRole('navigation', { name: 'Open PDFs' }).getByRole('tab', { name: /^group-source\.pdf/ }).click();
  await page.getByRole('navigation', { name: 'Open PDFs' }).getByRole('button', { name: 'Close group-source.pdf', exact: true }).click();
  await page.getByRole('dialog', { name: 'Ready to close this PDF?', exact: true })
    .getByRole('button', { name: 'Close document', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const copiedChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open another PDF', exact: true }).click();
  await (await copiedChooser).setFiles({ name: 'group-copied.pdf', mimeType: 'application/pdf', buffer: copied });
  await expect(page.getByRole('tab', { name: /^group-copied\.pdf/ })).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
  await clickRibbonCommand(page, 'Edit content');
  await expect(page.locator('.selection-layer > [data-object-type="group"]')).toHaveCount(2);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('real WASM saves a multi-stroke handwritten visual signature as one undoable ink transaction', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'signature-source.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.getByRole('tab', { name: /^signature-source\.pdf/ })).toBeVisible({ timeout: 60_000 });
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Fill & sign', exact: true }).click();
  await clickRibbonCommand(page, 'Sign');
  const panel = page.getByRole('region', { name: 'Handwritten signature' });
  const area = panel.getByRole('img', { name: 'Signature drawing area' });
  await expect(area).toHaveAttribute('aria-disabled', 'false');
  await dragOnPage(page, area, [0.12, 0.25, 0.45, 0.75]);
  await expect(area.locator('polyline')).toHaveCount(1);
  await dragOnPage(page, area, [0.55, 0.35, 0.85, 0.75]);
  await expect(area.locator('polyline')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: 'Place signature' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Place signature' }).click();
  const preview = page.getByRole('group', { name: 'Signature placement preview', exact: true });
  await expect(preview).toBeVisible();
  const signature = (await preview.locator('.signature-page-preview').boundingBox())!;
  await page.mouse.move(signature.x + signature.width / 2, signature.y + signature.height / 2);
  await page.mouse.down();
  await page.mouse.move(signature.x + signature.width / 2 + 20, signature.y + signature.height / 2 - 15, { steps: 5 });
  await page.mouse.up();
  await preview.getByRole('button', { name: 'Confirm signature', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Comment', exact: true }).click();
  await clickRibbonCommand(page, 'Comment');
  const list = page.getByRole('list', { name: 'Document annotations', exact: true });
  await expect(list.locator('li')).toHaveCount(2);
  await expect(list.getByRole('button', { name: 'Go to Freehand on page 1', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(list.locator('li')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo (Ctrl Shift Z)', exact: true }).click();
  await expect(list.locator('li')).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  const reopen = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await reopen).setFiles({ name: 'signature-saved.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByRole('tab', { name: /^signature-saved\.pdf/ })).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Comment', exact: true }).click();
  await clickRibbonCommand(page, 'Comment');
  await expect(list.locator('li')).toHaveCount(2);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('real WASM persists a required multi-select List and atomic read-only changes', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'form-flags.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled({ timeout: 60_000 });
  const forms = await openForms(page);
  await forms.locator('summary').filter({ hasText: 'Create a field' }).click();
  await forms.getByRole('textbox', { name: 'Field name' }).fill('ManyChoices');
  await forms.getByRole('combobox', { name: 'Field type' }).selectOption('list');
  await forms.getByRole('textbox', { name: 'Options (one per line)' }).fill('Alpha\nBeta\nGamma');
  await forms.getByRole('combobox', { name: 'Field font' }).selectOption('noto-sans-cjk-sc-regular');
  await forms.getByRole('checkbox', { name: 'Required field' }).check();
  await forms.getByRole('checkbox', { name: 'Allow multiple selections' }).check();
  await drawField(page);
  const field = page.locator('.document-field').filter({ hasText: 'ManyChoices' });
  await expect(field).toContainText('multi-select');
  const value = field.getByRole('listbox', { name: 'Value' });
  await value.selectOption(['Alpha', 'Gamma']);
  await field.getByRole('button', { name: 'Apply value' }).click();
  await expect.poll(() => value.evaluate(element => Array.from((element as HTMLSelectElement).selectedOptions, option => option.value)))
    .toEqual(['Alpha', 'Gamma']);
  await openFieldProperties(page, field);
  const properties = field.getByRole('group', { name: 'Properties for ManyChoices' });
  await properties.getByRole('checkbox', { name: 'Read-only', exact: true }).check();
  await properties.getByRole('button', { name: 'Apply field properties' }).click();
  await expect(value).toBeDisabled();
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(value).toBeEnabled();
  await page.getByRole('button', { name: 'Redo (Ctrl Shift Z)', exact: true }).click();
  await expect(value).toBeDisabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  const reopen = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await reopen).setFiles({ name: 'form-flags-saved.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByRole('tab', { name: /^form-flags-saved\.pdf/ })).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
  await openForms(page);
  const reopened = page.locator('.document-field').filter({ hasText: 'ManyChoices' });
  await expect(reopened).toContainText('required');
  await expect(reopened).toContainText('multi-select');
  await expect(reopened.getByRole('listbox', { name: 'Value' })).toBeDisabled();
  await expect.poll(() => reopened.getByRole('listbox', { name: 'Value' }).evaluate(element =>
    Array.from((element as HTMLSelectElement).selectedOptions, option => option.value)))
    .toEqual(['Alpha', 'Gamma']);
});

test('text field tooltip and maximum length survive native save and reject conflicting edits', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'form-properties.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled({ timeout: 60_000 });
  const forms = await openForms(page);
  await forms.locator('summary').filter({ hasText: 'Create a field' }).click();
  await forms.getByRole('textbox', { name: 'Field name' }).fill('AccountCode');
  await forms.getByRole('combobox', { name: 'Field type' }).selectOption('text');
  await forms.getByRole('combobox', { name: 'Field font' }).selectOption('noto-sans-cjk-sc-regular');
  await drawField(page);
  const field = page.locator('.document-field').filter({ hasText: 'AccountCode' });
  const value = field.getByRole('textbox', { name: 'Value' });
  await value.fill('Hello');
  await field.getByRole('button', { name: 'Apply value' }).click();
  await openFieldProperties(page, field);
  const properties = field.getByRole('group', { name: 'Properties for AccountCode' });
  await properties.getByRole('textbox', { name: 'Tooltip' }).fill('Account code');
  await properties.getByRole('spinbutton', { name: 'Max length' }).fill('4');
  await properties.getByRole('button', { name: 'Apply field properties' }).click();
  await expect(forms.getByRole('alert')).toContainText('current value exceeds requested maximum length');
  await properties.getByRole('spinbutton', { name: 'Max length' }).fill('6');
  await properties.getByRole('button', { name: 'Apply field properties' }).click();
  await expect(field).toContainText('max: 6');
  await value.fill('ABCDEFG');
  await field.getByRole('button', { name: 'Apply value' }).click();
  await expect(forms.getByRole('alert')).toContainText('Text value exceeds field maximum length');
  await forms.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(value).toHaveValue('Hello');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  expect(saved.toString('latin1')).toContain('/MaxLen 6');
  const reopen = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await reopen).setFiles({ name: 'form-properties-saved.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByRole('tab', { name: /^form-properties-saved\.pdf/ })).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
  await openForms(page);
  const reopened = page.locator('.document-field').filter({ hasText: 'AccountCode' });
  await expect(reopened).toContainText('max: 6');
  await reopened.locator('summary').filter({ hasText: 'Field properties' }).click();
  await expect(reopened.getByRole('group', { name: 'Properties for AccountCode' }).getByRole('textbox', { name: 'Tooltip' })).toHaveValue('Account code');
  await expect(reopened.getByRole('textbox', { name: 'Value' })).toHaveValue('Hello');
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
