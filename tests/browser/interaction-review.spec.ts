import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pdfObjects, imageAiPdf, selectAiText } from './ai-integration-helpers';
import { clickRibbonCommand } from './editor-ui-helpers';

function textPdf(stream: string, annotations = '') {
  return pdfObjects(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 360] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R ${annotations} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]);
}
async function open(page: Page, buffer: Buffer, name = 'review.pdf') {
  const chooser = page.waitForEvent('filechooser');
  const another = page.getByRole('button', { name: 'Open another PDF', exact: true });
  await (await another.count() ? another : page.getByRole('button', { name: 'Open PDF', exact: true })).click();
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
});

test('three selected paragraphs translate once, show one result, and replace as one undoable edit', async ({ page }) => {
  const lines = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'];
  await open(page, textPdf(lines.map((text, i) => `BT /F1 16 Tf 30 ${300 - i * 60} Td (${text}) Tj ET`).join('\n')));
  const requests: { segments: { text: string }[] }[] = [];
  await page.route('**/api/v1/ai/text-actions', route => {
    const request = route.request().postDataJSON(); requests.push(request);
    return route.fulfill({ json: { requestId: request.requestId, action: request.action, detectedLanguage: 'en',
      segments: [{ id: request.segments[0].id, text: '\n\nOne complete translation.\n\n\n' }] } });
  });
  await expect(page.locator('.pdf-character')).toHaveCount(lines.join('').length);
  await selectAiText(page, lines.join('').length);
  await page.getByRole('menuitem', { name: 'AI translate', exact: true }).click();
  await page.getByRole('dialog', { name: 'Translate selected text', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
  const result = page.getByRole('dialog', { name: 'Translation', exact: true });
  await expect(result.getByRole('textbox')).toHaveCount(1);
  await expect(result.getByRole('textbox')).toHaveValue('One complete translation.');
  expect(requests).toHaveLength(1); expect(requests[0]!.segments).toHaveLength(1);
  expect(requests[0]!.segments[0]!.text).toBe(lines.join('\n'));
  await result.getByRole('button', { name: 'View original', exact: true }).click();
  await expect(result.getByRole('textbox', { name: 'Original text on page 1' })).toHaveValue(lines.join('\n'));
  await expect(page.locator('.save-state')).toHaveText('No changes');
  await result.locator('.ai-replace-choice > summary').click();
  await result.getByRole('button', { name: 'Review layout', exact: true }).click();
  await result.getByRole('button', { name: 'Confirm and apply', exact: true }).click();
  await expect(page.locator('.pdf-text-layer')).toHaveText('One complete translation.');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(page.locator('.pdf-text-layer')).toHaveText(lines.join('\n\n'));
  await expect(result.getByRole('button', { name: 'Review layout', exact: true })).toBeEnabled();
  await expect(result.getByText('Applied. You can undo this change.', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'tmp/browser/review-continuous-translation.png' });
});

test('finds a word across font objects, highlights the word, replaces and saves it', async ({ page }) => {
  await open(page, textPdf('BT /F1 16 Tf 30 300 Td (A Trans) Tj /F2 16 Tf (lation) Tj /F1 16 Tf ( is searchable.) Tj ET'));
  await clickRibbonCommand(page, 'Find & replace');
  const query = page.getByRole('textbox', { name: 'Find text', exact: true });
  await query.fill('translation'); await query.press('Enter');
  await expect(page.locator('.pdf-search-panel')).toContainText('1 of 1');
  await expect(page.locator('.search-match-highlight')).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Replace with', exact: true }).fill('Word');
  await page.getByRole('button', { name: 'Replace selected match', exact: true }).click();
  await expect(page.locator('.pdf-text-layer')).toHaveText('A Word is searchable.');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(page.locator('.pdf-text-layer')).toHaveText('A Translation is searchable.');
  await query.press('Enter');
  await page.getByRole('button', { name: 'Replace selected match', exact: true }).click();
  await expect(page.locator('.pdf-text-layer')).toHaveText('A Word is searchable.');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  await open(page, await readFile((await (await download).path())!), 'reopened.pdf');
  await expect(page.locator('.pdf-text-layer')).toHaveText('A Word is searchable.');
  await page.screenshot({ path: 'tmp/browser/review-rich-text-search.png' });
});

test('scanned pages prompt for OCR instead of pretending there is no matching text', async ({ page }) => {
  await open(page, imageAiPdf(), 'scan.pdf');
  await clickRibbonCommand(page, 'Find & replace');
  const prompt = page.getByRole('dialog', { name: 'Recognize text for search?', exact: true });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('desktop app');
  await prompt.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(page.locator('.pdf-search-panel')).toContainText('Text in images on 1 pages has not been recognized.');
});

test('links and notes coexist without canvas errors, and forms are placed by dragging', async ({ page }) => {
  await open(page, textPdf('BT /F1 16 Tf 30 300 Td (Link and note) Tj ET',
    '/Annots [<< /Type /Annot /Subtype /Link /Rect [30 275 100 300] /A << /S /URI /URI (https://example.test) >> >> << /Type /Annot /Subtype /Text /Rect [180 275 204 299] /Contents (Readable comment) /C [1 1 0] >>]'));
  await expect(page.locator('.annotation-load-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open comment 1 on page 1', exact: true }).click();
  const note = page.getByRole('dialog', { name: 'Comment', exact: true });
  await expect(note.locator('.comment-body')).toHaveText('Readable comment');
  await note.getByRole('button', { name: 'Close comment', exact: true }).click();
  await clickRibbonCommand(page, 'Fill & forms');
  await expect(page.getByText('Placement coordinates', { exact: true })).toHaveCount(0);
  await page.locator('summary').filter({ hasText: 'Create a field' }).click();
  await page.getByRole('textbox', { name: 'Field name', exact: true }).fill('Name');
  await page.getByRole('button', { name: 'Draw field on page', exact: true }).click();
  const surface = (await page.getByLabel('Placement area', { exact: true }).boundingBox())!;
  await page.mouse.move(surface.x + 60, surface.y + 160); await page.mouse.down();
  await page.mouse.move(surface.x + 260, surface.y + 205, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('.document-field-heading')).toContainText('Name');
  await page.screenshot({ path: 'tmp/browser/review-canvas-form.png' });
});
