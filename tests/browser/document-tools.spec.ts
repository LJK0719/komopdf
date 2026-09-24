import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('real WASM creates form fields, fills them, adds annotations, and retains them after save and reopen', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const original = syntheticPdf();
  await (await chooser).setFiles({ name: 'doc-tools.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page.getByText('doc-tools.pdf', { exact: true }).or(page.locator('.status-dot-error'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.status-dot-error')).toHaveCount(0);

  // 1. Create a Chinese text form field using an embedded Noto font
  await page.getByLabel('X', { exact: true }).fill('36');
  await page.getByLabel('Y', { exact: true }).fill('36');
  await page.getByLabel('Width', { exact: true }).fill('180');
  await page.getByLabel('Height', { exact: true }).fill('32');
  await page.getByLabel('Field name', { exact: true }).fill('中文姓名');
  await page.getByRole('combobox', { name: 'Field type', exact: true }).selectOption('text');
  await page.getByRole('combobox', { name: 'Field font', exact: true }).selectOption('noto-sans-cjk-sc-regular');
  await page.getByLabel('Font size', { exact: true }).fill('14');
  await page.getByRole('button', { name: 'Create field', exact: true }).click();

  const nameField = page.locator('.document-field').filter({ hasText: '中文姓名' });
  await expect(nameField).toBeVisible({ timeout: 30_000 });

  // 2. Fill the text field with Chinese and ASCII text, then apply value
  await nameField.getByRole('textbox', { name: 'Value', exact: true }).fill('测试张三 ABC 123');
  await nameField.getByRole('button', { name: 'Apply value', exact: true }).click();
  await expect(nameField.getByRole('textbox', { name: 'Value', exact: true })).toHaveValue('测试张三 ABC 123');

  // 3. Create a checkbox field and check it
  await page.getByLabel('X', { exact: true }).fill('36');
  await page.getByLabel('Y', { exact: true }).fill('80');
  await page.getByLabel('Width', { exact: true }).fill('24');
  await page.getByLabel('Height', { exact: true }).fill('24');
  await page.getByLabel('Field name', { exact: true }).fill('同意条款');
  await page.getByRole('combobox', { name: 'Field type', exact: true }).selectOption('checkbox');
  await page.getByRole('button', { name: 'Create field', exact: true }).click();

  const checkboxField = page.locator('.document-field').filter({ hasText: '同意条款' });
  await expect(checkboxField).toBeVisible({ timeout: 30_000 });
  await checkboxField.getByRole('checkbox', { name: 'Checked' }).check();
  await checkboxField.getByRole('button', { name: 'Apply value', exact: true }).click();
  await expect(checkboxField.getByRole('checkbox', { name: 'Checked' })).toBeChecked();

  // 3b. Create and fill a real Unicode Choice field.
  await page.getByLabel('X', { exact: true }).fill('36');
  await page.getByLabel('Y', { exact: true }).fill('160');
  await page.getByLabel('Width', { exact: true }).fill('180');
  await page.getByLabel('Height', { exact: true }).fill('32');
  await page.getByLabel('Field name', { exact: true }).fill('选择城市');
  await page.getByRole('combobox', { name: 'Field type', exact: true }).selectOption('combo');
  await page.getByRole('textbox', { name: 'Options (one per line)' }).fill('北京\n上海');
  await page.getByRole('combobox', { name: 'Field font', exact: true }).selectOption('noto-sans-cjk-sc-regular');
  await page.getByRole('button', { name: 'Create field', exact: true }).click();
  const cityField = page.locator('.document-field').filter({ hasText: '选择城市' });
  await expect(cityField).toBeVisible();
  await cityField.getByRole('combobox', { name: 'Value', exact: true }).selectOption('上海');
  await cityField.getByRole('button', { name: 'Apply value', exact: true }).click();
  await expect(cityField.getByRole('combobox', { name: 'Value', exact: true })).toHaveValue('上海');

  // 3c. A radio group is one real AcroForm field with two independent Widgets.
  await page.getByLabel('X', { exact: true }).fill('36');
  await page.getByLabel('Y', { exact: true }).fill('210');
  await page.getByLabel('Width', { exact: true }).fill('180');
  await page.getByLabel('Height', { exact: true }).fill('28');
  await page.getByLabel('Field name', { exact: true }).fill('选择颜色');
  await page.getByRole('combobox', { name: 'Field type', exact: true }).selectOption('radio');
  await page.getByRole('textbox', { name: 'Options (one per line)' }).fill('红色\n蓝色');
  await page.getByRole('button', { name: 'Create field', exact: true }).click();
  const colorField = page.locator('.document-field').filter({ hasText: '选择颜色' });
  await expect(colorField).toBeVisible();
  await colorField.getByRole('combobox', { name: 'Value', exact: true }).selectOption('蓝色');
  await colorField.getByRole('button', { name: 'Apply value', exact: true }).click();
  await expect(colorField.getByRole('combobox', { name: 'Value', exact: true })).toHaveValue('蓝色');

  // 4. Add a Note annotation with undo/redo check
  await page.getByLabel('X', { exact: true }).fill('36');
  await page.getByLabel('Y', { exact: true }).fill('120');
  await page.getByLabel('Width', { exact: true }).fill('140');
  await page.getByLabel('Height', { exact: true }).fill('30');
  await page.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('审核批注测试 Note');
  await page.getByRole('button', { name: 'Add note', exact: true }).click();

  const annotationList = page.locator('.document-tools-list');
  await expect(annotationList).toContainText('审核批注测试 Note');

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(annotationList.locator('li').filter({ hasText: '审核批注测试 Note' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(annotationList).toContainText('审核批注测试 Note');

  // Edit the same PDF annotation rather than drawing a visual overlay.
  await page.getByRole('button', { name: 'Edit text annotation' }).click();
  await page.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Updated note in the real PDF');
  await page.getByRole('button', { name: 'Update selected annotation' }).click();
  await expect(annotationList).toContainText('Updated note in the real PDF');
  await expect(annotationList).not.toContainText('审核批注测试 Note');

  await page.getByRole('button', { name: 'Add rectangle' }).click();
  await expect(annotationList.locator('li')).toHaveCount(2);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete rectangle annotation' }).click();
  await expect(annotationList.locator('li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(annotationList.locator('li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(annotationList.locator('li')).toHaveCount(1);

  // 5. Save the modified document and verify changes were written
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  expect(saved.equals(original)).toBe(false);

  // 6. Reopen saved document using the existing dirty session confirmation pattern
  page.once('dialog', async dialog => {
    page.once('dialog', discard => discard.accept());
    await dialog.dismiss();
  });
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'saved-doc-tools.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByText('saved-doc-tools.pdf', { exact: true })).toBeVisible({ timeout: 60_000 });

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
  await expect(page.getByText('group-source.pdf', { exact: true })).toBeVisible({ timeout: 60_000 });

  const objects = page.locator('.selection-layer > [data-object-id]');
  await expect(objects).toHaveCount(2);
  await objects.nth(0).click();
  await objects.nth(1).click({ modifiers: ['Control'] });
  await expect(page.getByRole('button', { name: 'Group selected objects', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Group selected objects', exact: true }).click();
  await expect(page.locator('.selection-layer > [data-object-type="group"]')).toHaveCount(1);
  await expect(objects).toHaveCount(1);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  page.once('dialog', async dialog => {
    page.once('dialog', discard => discard.accept());
    await dialog.dismiss();
  });
  const reopen = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await reopen).setFiles({ name: 'group-saved.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.getByText('group-saved.pdf', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.selection-layer > [data-object-type="group"]')).toHaveCount(1);

  await page.locator('.selection-layer > [data-object-type="group"]').click();
  await page.getByRole('button', { name: 'Ungroup selected objects' }).click();
  await expect(objects).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.selection-layer > [data-object-type="group"]')).toHaveCount(1);
  await page.locator('.selection-layer > [data-object-type="group"]').click();
  await page.getByRole('button', { name: 'Duplicate selected objects' }).click();
  await expect(page.locator('.selection-layer > [data-object-type="group"]')).toHaveCount(2);
  const copiedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const copied = await readFile((await (await copiedDownload).path())!);
  page.once('dialog', async dialog => {
    page.once('dialog', discard => discard.accept());
    await dialog.dismiss();
  });
  const copiedChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await copiedChooser).setFiles({ name: 'group-copied.pdf', mimeType: 'application/pdf', buffer: copied });
  await expect(page.locator('.selection-layer > [data-object-type="group"]')).toHaveCount(2);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('real WASM saves a multi-stroke handwritten visual signature as one undoable ink transaction', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'signature-source.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await expect(page.getByText('signature-source.pdf', { exact: true })).toBeVisible({ timeout: 60_000 });
  const panel = page.getByRole('region', { name: 'Handwritten signature' });
  const area = panel.getByRole('img', { name: 'Signature drawing area' });
  await area.scrollIntoViewIfNeeded();
  const rect = await area.boundingBox();
  if (!rect) throw new Error('Signature drawing area is unavailable');
  await page.mouse.move(rect.x + 30, rect.y + 35);
  await page.mouse.down();
  await page.mouse.move(rect.x + 100, rect.y + 80, { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(rect.x + 130, rect.y + 55);
  await page.mouse.down();
  await page.mouse.move(rect.x + 190, rect.y + 85, { steps: 5 });
  await page.mouse.up();
  await expect(area.locator('polyline')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: 'Place signature' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Place signature' }).click();
  const list = page.locator('.document-tools-list');
  await expect(list.locator('li')).toHaveCount(2);
  await expect(list).toContainText('ink');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(list.locator('li')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(list.locator('li')).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  page.once('dialog', async dialog => {
    page.once('dialog', discard => discard.accept());
    await dialog.dismiss();
  });
  const reopen = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await reopen).setFiles({ name: 'signature-saved.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(list.locator('li')).toHaveCount(2);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
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
