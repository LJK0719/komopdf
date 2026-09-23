import { test, expect } from '@playwright/test';

test('real WASM recovers interrupted session with full undo/redo and unauthorized AI', async ({ page }) => {
  await page.goto('/editor/');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const original = syntheticPdf();
  await (await chooser).setFiles({ name: 'recovery-smoke.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page.getByText('recovery-smoke.pdf', { exact: true }).or(page.locator('.status-dot-error'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.status-dot-error')).toHaveCount(0);

  const textObject = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(textObject).toHaveCount(1, { timeout: 60_000 });
  await textObject.click();
  const originalText = page.getByRole('textbox', { name: 'Original text', exact: true });
  await expect(originalText).toHaveValue('Hello PDF Editor');

  await page.getByRole('textbox', { name: 'Replacement', exact: true }).fill('Edited');
  await page.getByRole('button', { name: 'Preview layout', exact: true }).click();
  await expect(page.getByText('Fits current text bounds', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Commit replacement', exact: true }).click();
  await expect(originalText).toHaveValue('Edited');

  // Await the recovery snapshot and manifest to be persisted to IndexedDB
  await expect.poll(async () => {
    return await page.evaluate(async () => {
      return await new Promise<number>((resolve) => {
        const req = indexedDB.open('pdf-editor-recovery', 1);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('sessions')) {
            db.close();
            resolve(0);
            return;
          }
          const tx = db.transaction('sessions', 'readonly');
          const countReq = tx.objectStore('sessions').count();
          countReq.onsuccess = () => {
            const count = countReq.result;
            db.close();
            resolve(count);
          };
          countReq.onerror = () => {
            db.close();
            resolve(0);
          };
        };
        req.onerror = () => resolve(0);
      });
    });
  }).toBeGreaterThan(0);

  // Reload page to simulate abrupt browser session interruption
  await page.reload();

  // Verify the recoverable session banner is displayed with exact labels
  const banner = page.getByRole('alert', { name: 'Recoverable session notice' });
  await expect(banner).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Recover Unsaved Document')).toBeVisible();

  // Click Restore to bring back the document and editing history
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(banner).toHaveCount(0);

  // Confirm original text reflects the committed change
  await expect(textObject).toHaveCount(1, { timeout: 60_000 });
  await textObject.click();
  await expect(originalText).toHaveValue('Edited');

  // Verify undo history was restored
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(originalText).toHaveValue('Hello PDF Editor');

  // Verify redo history works as expected
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(originalText).toHaveValue('Edited');

  // Confirm AI authorization remains ungranted after session recovery
  await expect(page.getByRole('button', { name: 'Enable AI for this document', exact: true })).toBeVisible();
  await expect(page.getByText('✓ AI enabled for this document')).toHaveCount(0);

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
