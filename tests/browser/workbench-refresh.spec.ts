import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/');
});

async function openPair(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const selection = await chooser;
  expect(selection.isMultiple()).toBe(true);
  await selection.setFiles(['A', 'B'].map(name => ({ name: `${name}.pdf`, mimeType: 'application/pdf', buffer: samplePdf(name === 'A' ? 'Alpha' : 'Bravo') })));
  await expect(page.getByRole('tab')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
}
async function edit(page: Page, name: string, text?: string) {
  await page.getByRole('tab', { name: new RegExp(`^${name}\\.pdf`) }).click();
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  if (text !== undefined) { await input.fill(text); await input.press('Control+Enter'); await expect(input).toHaveCount(0); }
  return input;
}

test('multi-select keeps document edits, undo and closing independent', async ({ page }) => {
  await openPair(page);
  await edit(page, 'A', 'Alto');
  await edit(page, 'B', 'Beta');
  let input = await edit(page, 'A');
  await expect(input).toHaveText('Alto'); await input.press('Escape');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  input = await edit(page, 'A'); await expect(input).toHaveText('Alpha'); await input.press('Escape');
  input = await edit(page, 'B'); await expect(input).toHaveText('Beta'); await input.press('Escape');
  await page.getByRole('button', { name: 'Close A.pdf', exact: true }).click();
  const closing = page.getByRole('dialog', { name: 'Save your changes?' });
  await expect(closing).toContainText('A.pdf');
  await closing.getByRole('button', { name: 'Close without downloading', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /^B\.pdf/ })).toHaveAttribute('aria-selected', 'true');
  input = await edit(page, 'B'); await expect(input).toHaveText('Beta');
});

test('download then close has an explicit completion without closing another PDF', async ({ page }) => {
  await openPair(page); await edit(page, 'A', 'Alto');
  await page.getByRole('button', { name: 'Close A.pdf', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: 'Save your changes?' });
  const downloading = page.waitForEvent('download');
  await prompt.getByRole('button', { name: 'Download copy', exact: true }).click();
  const download = await downloading;
  expect(await download.failure()).toBeNull();
  const completion = page.getByRole('dialog', { name: 'Ready to close this PDF?' });
  await expect(completion).toBeVisible();
  await completion.getByRole('button', { name: 'Close document', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'B.pdf', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close B.pdf', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recent files' })).toContainText('A.pdf');
});

test('all interrupted documents remain recoverable one after another', async ({ page }) => {
  await openPair(page); await edit(page, 'A', 'Alto'); await edit(page, 'B', 'Beta');
  await expect.poll(() => page.evaluate(() => new Promise<number>(resolve => {
    const request = indexedDB.open('pdf-editor-recovery', 1);
    request.onsuccess = () => {
      const database = request.result;
      const record = database.transaction('sessions', 'readonly').objectStore('sessions').get('recovery-manifest');
      record.onsuccess = () => {
        const data = JSON.parse(new TextDecoder().decode(record.result));
        database.close(); resolve(data.sessions.filter((item: { revision: number; savedRevision: number }) => item.revision !== item.savedRevision).length);
      };
    };
  }))).toBe(2);
  page.on('dialog', dialog => void dialog.accept());
  await page.reload();
  const recovery = page.getByRole('region', { name: 'Recoverable session notice' });
  await expect(recovery.locator('.recovery-row')).toHaveCount(2);
  await recovery.getByRole('button', { name: 'Restore', exact: true }).first().click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: 'Start page', exact: true }).click();
  const start = page.getByRole('dialog', { name: 'Open documents' });
  await expect(start.locator('.recovery-row')).toHaveCount(1);
  await start.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  const a = await edit(page, 'A'); await expect(a).toHaveText('Alto'); await a.press('Escape');
  const b = await edit(page, 'B'); await expect(b).toHaveText('Beta');
});

test('working layouts keep AI input and closing controls inside the viewport', async ({ page }) => {
  await openPair(page);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  for (const [width, height] of [[1440, 900], [1024, 600], [920, 640], [768, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect.poll(async () => (await page.locator('.komo-chat-composer').boundingBox())?.width ?? 0).toBeGreaterThan(200);
    for (const selector of ['.komo-chat-composer', '.inspector-panel .panel-heading .icon-button']) {
      const box = await page.locator(selector).boundingBox();
      expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
    }
  }
});

function samplePdf(text: string) {
  const stream = `BT /F1 18 Tf 36 240 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let output = '%PDF-1.7\n';
  const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(output); output += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
