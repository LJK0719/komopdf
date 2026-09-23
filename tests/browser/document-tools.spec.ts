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

  // 4. Add a Note annotation with undo/redo check
  await page.getByLabel('X', { exact: true }).fill('36');
  await page.getByLabel('Y', { exact: true }).fill('120');
  await page.getByLabel('Width', { exact: true }).fill('140');
  await page.getByLabel('Height', { exact: true }).fill('30');
  await page.getByLabel('Annotation text', { exact: true }).fill('审核批注测试 Note');
  await page.getByRole('button', { name: 'Add note', exact: true }).click();

  const annotationList = page.locator('.document-tools-list');
  await expect(annotationList).toContainText('审核批注测试 Note');

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(annotationList.locator('li').filter({ hasText: '审核批注测试 Note' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(annotationList).toContainText('审核批注测试 Note');

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

  await expect(page.locator('.document-tools-list')).toContainText('审核批注测试 Note');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
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
