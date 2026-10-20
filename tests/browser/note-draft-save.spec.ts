import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function openPdf(page: Page, name: string, buffer = syntheticPdf()) {
  const chooser = page.waitForEvent('filechooser');
  if (await page.getByRole('button', { name: 'Open PDF', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  } else {
    await page.keyboard.press('Control+o');
  }
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
  await expect(page.locator('.document-title strong')).toHaveText(name, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
}

async function startNote(page: Page, text: string) {
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await page.locator('.annotation-drawing-surface').first().click({ position: { x: 100, y: 220 } });
  const input = page.getByRole('textbox', { name: 'New note', exact: true });
  await input.fill(text);
  return input;
}

async function showComments(page: Page) {
  await page.getByRole('navigation', { name: 'Document navigation' })
    .getByRole('button', { name: 'Comment', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).waitFor();
  await openPdf(page, 'note-draft.pdf');
});

for (const action of ['Save', 'Ctrl+S'] as const) {
  test(`${action} finishes a note draft before downloading the PDF`, async ({ page }) => {
    const input = await startNote(page, 'Initial note text');
    // The registered handle must read the latest text, not its initial render.
    await input.fill('Latest note saved directly');
    const download = page.waitForEvent('download');
    if (action === 'Save') await page.getByRole('button', { name: 'Save', exact: true }).click();
    else await input.press('Control+s');
    const saved = await readFile((await (await download).path())!);
    await expect(input).toHaveCount(0);
    await expect(page.locator('.annotation-list-item-text')).toHaveText('Latest note saved directly');

    await openPdf(page, 'note-reopened.pdf', saved);
    await showComments(page);
    await expect(page.locator('.annotation-list-item-text')).toHaveText('Latest note saved directly');
    await expect(page.locator('.status-dot-error')).toHaveCount(0);
  });
}

test('cancelling a note draft does not write it into the PDF', async ({ page }) => {
  const input = await startNote(page, 'Cancelled note must not be saved');
  await page.getByRole('form', { name: 'New note', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(input).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await readFile((await (await download).path())!);
  await openPdf(page, 'cancelled-note-reopened.pdf', saved);
  await showComments(page);
  await expect(page.getByText('No annotations in this document yet.', { exact: true })).toBeVisible();
  await expect(page.locator('.annotation-list-item')).toHaveCount(0);
});

function syntheticPdf() {
  const content = 'BT /F1 20 Tf 45 510 Td (Note workflow) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 600] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(output);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
