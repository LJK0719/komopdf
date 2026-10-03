import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'finishing.pdf', mimeType: 'application/pdf', buffer: samplePdf() });
  await expect(page.locator('.document-pages .page-wrap')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

test('search respects case and moves forward and backward without changing the PDF', async ({ page }) => {
  await page.getByRole('navigation', { name: 'Quick tools' }).getByRole('button', { name: 'Find & replace', exact: true }).click();
  const search = page.getByRole('region', { name: 'Find in document', exact: true });
  const query = search.getByRole('textbox', { name: 'Find text', exact: true });
  const currentPage = page.getByRole('spinbutton', { name: 'Page', exact: true });
  await query.fill('alpha');
  await query.press('Enter');
  await expect(search.getByRole('status')).toHaveText('1 of 3');
  await expect(currentPage).toHaveValue('1');
  await search.getByRole('button', { name: 'Next match', exact: true }).click();
  await expect(search.getByRole('status')).toHaveText('2 of 3');
  await expect(currentPage).toHaveValue('2');
  await query.press('Shift+Enter');
  await expect(search.getByRole('status')).toHaveText('1 of 3');
  await expect(currentPage).toHaveValue('1');
  await search.getByRole('button', { name: 'Previous match', exact: true }).click();
  await expect(search.getByRole('status')).toHaveText('3 of 3');
  await expect(currentPage).toHaveValue('3');

  await search.getByRole('checkbox', { name: 'Match case', exact: true }).check();
  await search.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(search.getByRole('status')).toHaveText('1 of 1');
  await expect(search.getByRole('button', { name: 'Page 2: alpha', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(currentPage).toHaveValue('2');
  await expect(page.locator('.save-state')).toHaveText('Saved');
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'tmp/browser/finishing-search.png' });
});

test('fit width follows the sidebar and window, while 135% keeps the current page and exits fit', async ({ page }) => {
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  const currentPage = page.getByRole('spinbutton', { name: 'Page', exact: true });
  const secondPage = page.locator('.page-wrap[data-page-number="2"]');
  const controls = page.locator('.view-controls');
  const fitWidth = controls.getByRole('button', { name: 'Fit width', exact: true });
  await fitWidth.click();
  await expect(fitWidth).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await secondPage.boundingBox())!.width).toBeGreaterThan(525);
  await expect(fitWidth).toBeEnabled();
  const fullWidth = (await secondPage.boundingBox())!.width;
  await expect(currentPage).toHaveValue('2');

  await page.getByRole('navigation', { name: 'Quick tools' }).getByRole('button', { name: 'Find & replace', exact: true }).click();
  await expect.poll(async () => (await secondPage.boundingBox())!.width).toBeLessThan(fullWidth);
  await expect(fitWidth).toBeEnabled();
  const sidebarWidth = (await secondPage.boundingBox())!.width;
  await page.setViewportSize({ width: 1280, height: 960 });
  await expect.poll(async () => (await secondPage.boundingBox())!.width).toBeLessThan(sidebarWidth);
  await expect(currentPage).toHaveValue('2');
  await expect(fitWidth).toHaveAttribute('aria-pressed', 'true');

  const zoom = controls.getByLabel('Zoom', { exact: true });
  await zoom.fill('135%');
  await zoom.press('Enter');
  await expect(zoom).toHaveValue('135%');
  await expect(secondPage).toHaveCSS('width', '567px');
  await expect(fitWidth).toHaveAttribute('aria-pressed', 'false');
  await expect(currentPage).toHaveValue('2');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(zoom).toHaveValue('135%');
  await expect(currentPage).toHaveValue('2');
  await zoom.fill('185%');
  await zoom.press('Escape');
  await expect(zoom).toHaveValue('135%');
  await expect(page.locator('.save-state')).toHaveText('Saved');
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'tmp/browser/finishing-view-zoom.png' });
});

test('zoom preserves the reading point midway down a page as the sidebar and window resize', async ({ page }) => {
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  const controls = page.locator('.view-controls');
  const fitWidth = controls.getByRole('button', { name: 'Fit width', exact: true });
  const sheet = page.locator('.page-wrap[data-page-number="2"]');
  await fitWidth.click();
  await expect.poll(async () => (await sheet.boundingBox())!.width).toBeGreaterThan(525);
  await expect(fitWidth).toBeEnabled();
  await sheet.evaluate(element => {
    const stage = element.closest('.canvas-stage')!;
    stage.scrollTop += element.getBoundingClientRect().top - stage.getBoundingClientRect().top + element.getBoundingClientRect().height / 2;
  });
  const readingPoint = () => sheet.evaluate(element => {
    const stage = element.closest('.canvas-stage')!;
    const zoom = Number.parseFloat((document.querySelector('.view-controls input[aria-label="Zoom"]') as HTMLInputElement).value) / 100;
    return (stage.getBoundingClientRect().top - element.getBoundingClientRect().top) / zoom;
  });
  await expect.poll(readingPoint).toBeGreaterThan(290);
  const anchor = await readingPoint();
  const fullWidth = (await sheet.boundingBox())!.width;
  await page.getByRole('navigation', { name: 'Quick tools' }).getByRole('button', { name: 'Find & replace', exact: true }).click();
  await expect.poll(async () => (await sheet.boundingBox())!.width).toBeLessThan(fullWidth);
  await expect.poll(async () => Math.abs(await readingPoint() - anchor)).toBeLessThan(1);
  await expect(fitWidth).toBeEnabled();
  const sidebarWidth = (await sheet.boundingBox())!.width;
  await page.setViewportSize({ width: 1280, height: 960 });
  await expect.poll(async () => (await sheet.boundingBox())!.width).toBeLessThan(sidebarWidth);
  await expect.poll(async () => Math.abs(await readingPoint() - anchor)).toBeLessThan(1);
  await expect(fitWidth).toBeEnabled();
  const narrowWidth = (await sheet.boundingBox())!.width;
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect.poll(async () => (await sheet.boundingBox())!.width).toBeGreaterThan(narrowWidth);
  await expect.poll(async () => Math.abs(await readingPoint() - anchor)).toBeLessThan(1);
  const zoom = controls.getByLabel('Zoom', { exact: true });
  await expect(zoom).toBeEnabled();
  await zoom.fill('175%');
  await zoom.press('Enter');
  await expect(zoom).toHaveValue('175%');
  await expect.poll(async () => Math.abs(await readingPoint() - anchor)).toBeLessThan(1);
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('2');
  await expect(page.locator('.save-state')).toHaveText('Saved');
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
});

test('draw a signature once, move and resize its preview, cancel safely, then reuse the confirmed template', async ({ page }) => {
  const tabs = page.getByRole('navigation', { name: 'PDF tools', exact: true });
  await tabs.getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('toolbar', { name: 'Document tools', exact: true }).getByRole('button', { name: 'Sign', exact: true }).click();
  await page.locator('.view-controls').getByRole('button', { name: 'Fit page', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Handwritten signature', exact: true });
  const drawing = panel.getByRole('img', { name: 'Signature drawing area', exact: true });
  await expect(drawing).toHaveAttribute('aria-disabled', 'false');
  await drawStroke(page, drawing, [[0.15, 0.65], [0.25, 0.3], [0.4, 0.7], [0.6, 0.4], [0.8, 0.6]]);
  await expect(drawing.locator('polyline')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Place signature', exact: true }).click();
  const preview = page.getByRole('group', { name: 'Signature placement preview', exact: true });
  const signature = preview.locator('.signature-page-preview');
  await expect(preview).toBeVisible();
  const original = (await signature.boundingBox())!;
  await page.mouse.move(original.x + original.width / 2, original.y + original.height / 2);
  await page.mouse.down();
  await page.mouse.move(original.x + original.width / 2 + 30, original.y + original.height / 2 - 25, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await signature.boundingBox())!.x).toBeGreaterThan(original.x + 20);
  await expect.poll(async () => (await signature.boundingBox())!.y).toBeLessThan(original.y - 15);
  const corner = (await preview.getByRole('button', { name: 'Resize signature', exact: true }).boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 30, corner.y + corner.height / 2 + 10, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await signature.boundingBox())!.width).toBeGreaterThan(original.width + 15);
  await expect(page.locator('.save-state')).toHaveText('Saved');
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator('.save-state')).toHaveText('Saved');

  await panel.getByRole('button', { name: 'Place signature', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm signature', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator('.save-state')).toHaveText('Unsaved changes');
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeEnabled();
  await tabs.getByRole('button', { name: 'Home', exact: true }).click();
  await tabs.getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('toolbar', { name: 'Document tools', exact: true }).getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(drawing.locator('polyline')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Place signature', exact: true }).click();
  await expect(signature.locator('polyline')).toHaveCount(1);
  await page.screenshot({ path: 'tmp/browser/finishing-signature.png' });
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.document-title strong')).toHaveText('signed.pdf');
  await page.getByRole('navigation', { name: 'Document navigation' }).getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Document annotations', exact: true })
    .getByRole('button', { name: 'Go to Freehand on page 1', exact: true })).toHaveCount(1);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('Ribbon note, rectangle and freehand drawing create annotations that the list can locate across pages', async ({ page }) => {
  await page.locator('.view-controls').getByRole('button', { name: 'Fit page', exact: true }).click();
  await page.getByRole('navigation', { name: 'PDF tools', exact: true }).getByRole('button', { name: 'Comment', exact: true }).click();
  const ribbon = page.getByRole('toolbar', { name: 'Document tools', exact: true });
  let surface = page.locator('.page-wrap[data-page-number="1"] .annotation-drawing-surface');
  await ribbon.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await expect(surface).toBeVisible();
  const notePage = (await surface.boundingBox())!;
  await surface.click({ position: { x: notePage.width * 0.3, y: notePage.height * 0.3 } });
  const note = page.getByRole('form', { name: 'New note', exact: true });
  await note.getByRole('textbox', { name: 'New note', exact: true }).fill('Review this paragraph');
  await note.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(note).toHaveCount(0);
  const list = page.getByRole('list', { name: 'Document annotations', exact: true });
  const noteItem = list.getByRole('button', { name: 'Go to Note on page 1', exact: true });
  await expect(noteItem).toContainText('Review this paragraph');

  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Rectangle', exact: true }).click();
  surface = page.locator('.page-wrap[data-page-number="2"] .annotation-drawing-surface');
  await drawStroke(page, surface, [[0.18, 0.25], [0.62, 0.4]]);
  const rectangle = list.getByRole('button', { name: 'Go to Rectangle on page 2', exact: true });
  await expect(rectangle).toBeVisible();
  await ribbon.getByRole('button', { name: 'Freehand', exact: true }).click();
  await drawStroke(page, surface, [[0.2, 0.55], [0.3, 0.45], [0.4, 0.58], [0.55, 0.48]]);
  await expect(list.getByRole('button', { name: 'Go to Freehand on page 2', exact: true })).toBeVisible();
  await expect(list.locator('.annotation-list-item')).toHaveCount(3);
  await noteItem.click();
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('1');
  await expect(noteItem).toHaveAttribute('aria-pressed', 'true');
  await rectangle.click();
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('2');
  await expect(rectangle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.save-state')).toHaveText('Unsaved changes');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  await page.screenshot({ path: 'tmp/browser/finishing-annotations.png' });
});

test('import a source range at the chosen position, then apply and preview a page-number template', async ({ page }) => {
  const tabs = page.getByRole('navigation', { name: 'PDF tools', exact: true });
  await tabs.getByRole('button', { name: 'Insert', exact: true }).click();
  await test.step('Import only source pages 2–3 after the first page', async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import PDF pages', exact: true }).click();
    await (await chooser).setFiles({ name: 'source.pdf', mimeType: 'application/pdf', buffer: samplePdf(['Source one', 'Source two', 'Source three', 'Source four']) });
    const dialog = page.getByRole('dialog', { name: 'Import PDF pages', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Source pages to import', exact: true }).fill('2-3');
    await dialog.getByRole('combobox', { name: 'Insert position', exact: true }).selectOption({ label: 'After page 1' });
    await expect(dialog).toContainText('2 pages selected · Result: 5 pages');
    await page.screenshot({ path: 'tmp/browser/finishing-import-range.png' });
    await dialog.getByRole('button', { name: 'Import 2 pages', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.page-chip')).toHaveCount(5);
    await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
    await expect(page.locator('.page-wrap[data-page-number="2"] .pdf-text-layer')).toContainText('Source two');
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.locator('.page-wrap[data-page-number="3"] .pdf-text-layer')).toContainText('Source three');
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.locator('.page-wrap[data-page-number="4"] .pdf-text-layer')).toContainText('alpha');
  });

  await test.step('Preview footer numbers, skip the cover, and verify the added PDF text', async () => {
    await page.getByRole('button', { name: 'Page number', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Page and object editing', exact: true });
    await panel.getByRole('textbox', { name: 'Pages', exact: true }).fill('all');
    await panel.getByRole('spinbutton', { name: 'Starting number', exact: true }).fill('2');
    await panel.getByRole('checkbox', { name: 'Skip the first PDF page (cover)', exact: true }).check();
    await panel.getByRole('textbox', { name: 'Page number template', exact: true }).fill('{page} / {total}');
    await panel.getByRole('combobox', { name: 'Total means', exact: true }).selectOption({ label: 'All pages in this PDF' });
    await panel.getByRole('combobox', { name: 'Page number position', exact: true }).selectOption({ label: 'Footer right' });
    await expect(panel.locator('.page-number-preview')).toContainText('Preview · 4 pages numbered');
    await expect(panel.locator('.page-number-preview')).toContainText('PDF page 2 · 2 / 5');
    await expect(panel.locator('.page-number-preview')).toContainText('PDF page 5 · 5 / 5');
    await page.screenshot({ path: 'tmp/browser/finishing-page-number-template.png' });
    await panel.getByRole('button', { name: 'Apply to selected pages', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({ timeout: 30_000 });
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
    await expect(page.locator('.page-wrap[data-page-number="2"] .pdf-text-layer')).toContainText('2 / 5');
    await page.getByRole('button', { name: 'Open page 5', exact: true }).click();
    await expect(page.locator('.page-wrap[data-page-number="5"] .pdf-text-layer')).toContainText('5 / 5');
    await page.getByRole('button', { name: 'Open page 1', exact: true }).click();
    await expect(page.locator('.page-wrap[data-page-number="1"] .pdf-text-layer')).toHaveText('Alpha');
    await expect(page.locator('.page-chip')).toHaveCount(5);
    await expect(page.locator('.status-dot-error')).toHaveCount(0);
  });
});

async function drawStroke(page: Page, surface: Locator, points: [number, number][]) {
  await expect(surface).toBeVisible();
  await expect(surface).toHaveCSS('pointer-events', 'auto');
  await surface.scrollIntoViewIfNeeded();
  const box = (await surface.boundingBox())!;
  const [start, ...rest] = points;
  await page.mouse.move(box.x + start![0] * box.width, box.y + start![1] * box.height);
  await page.mouse.down();
  for (const [x, y] of rest) await page.mouse.move(box.x + x * box.width, box.y + y * box.height, { steps: 5 });
  await page.mouse.up();
}

function samplePdf(texts = ['Alpha', 'alpha', 'ALPHA']) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${texts.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${texts.length} >>`,
  ];
  for (const text of texts) {
    const content = `BT /F1 20 Tf 45 510 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 600] /Resources << /Font << /F1 ${3 + texts.length * 2} 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
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
