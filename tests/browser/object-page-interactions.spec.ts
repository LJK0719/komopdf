import { test, expect, type Page } from '@playwright/test';

function fixture() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R 11 0 R] /Count 5 >>'];
  for (let i = 0; i < 5; i++) {
    const stream = `BT /F1 22 Tf 50 540 Td (PAGE ${i + 1}) Tj ET\n0.15 0.65 0.35 rg 60 360 70 30 re f\n0.8 0.2 0.15 rg 180 300 50 40 re f\nq 60 0 0 40 260 200 cm /Im1 Do Q\n0 G 1 w 20 20 380 560 re S`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 600] /Resources << /Font << /F1 13 0 R >> /XObject << /Im1 14 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.push('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /ASCIIHexDecode /Length 25 >>\nstream\nff000000ff000000ffffffff>\nendstream');
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset;
  });
  const xref = Buffer.byteLength(pdf);
  return Buffer.from(pdf + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function open(page: Page, zoom = '100%') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'object-pages.pdf', mimeType: 'application/pdf', buffer: fixture() });
  await expect(page.locator('.document-pages .page-wrap')).toHaveCount(5, { timeout: 60_000 });
  await page.getByLabel('Zoom', { exact: true }).fill(zoom);
  await page.getByLabel('Zoom', { exact: true }).press('Enter');
  await expect(page.getByLabel('Zoom', { exact: true })).toHaveValue(zoom);
}
async function tab(page: Page, name: 'Edit' | 'View') {
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name, exact: true }).click();
}
async function ready(page: Page) {
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
}
async function inactiveSecondPage(page: Page) {
  await open(page, '75%'); await tab(page, 'Edit');
  // Keep part of page 1 visible so Edit intentionally retains its active page.
  await page.locator('.canvas-stage').hover(); await page.mouse.wheel(0, 245);
  const second = page.locator('.page-wrap[data-page-number="2"]');
  await expect(second.locator('.pdf-canvas')).toBeVisible();
  await expect.poll(async () => (await second.boundingBox())!.y).toBeLessThan(500);
  await expect(page.getByLabel('Page', { exact: true })).toHaveValue('1');
  const box = (await second.boundingBox())!;
  return { second, at: (x: number, y: number) => ({ x: box.x + x * 0.75, y: box.y + y * 0.75 }) };
}

test('facing-page keyboard navigation reaches an odd final page from a right-hand active page', async ({ page }) => {
  await open(page); await tab(page, 'View');
  await page.getByRole('button', { name: 'Facing pages', exact: true }).click();
  await page.getByRole('button', { name: 'Continuous scrolling', exact: true }).click();
  await page.getByRole('button', { name: 'Open page 2', exact: true }).click();
  const stage = (await page.locator('.canvas-stage').boundingBox())!;
  await page.mouse.click(stage.x + stage.width - 25, stage.y + 25);
  await page.keyboard.press('PageDown');
  await expect(page.locator('.page-wrap')).toHaveCount(2);
  await expect(page.locator('.page-wrap').first()).toHaveAttribute('data-page-number', '3');
  await page.keyboard.press('PageDown');
  await expect(page.getByLabel('Page', { exact: true })).toHaveValue('5');
  await expect(page.locator('.page-wrap')).toHaveCount(1);
  await page.keyboard.press('PageDown');
  await expect(page.getByLabel('Page', { exact: true })).toHaveValue('5');
  await page.keyboard.press('PageUp');
  await expect(page.locator('.page-wrap').first()).toHaveAttribute('data-page-number', '3');
});

for (const handle of ['e', 'w', 'n', 's'] as const) {
  test(`keyboard ${handle} image handle scales only its axis and preserves its opposite anchor`, async ({ page }) => {
    await open(page); await tab(page, 'Edit');
    const image = page.locator('.object-hitbox[data-object-type="image"]');
    await image.click(); const before = (await image.boundingBox())!;
    await page.locator(`[data-handle="scale-${handle}"]`).focus(); await page.keyboard.press('ArrowRight');
    const horizontal = handle === 'e' || handle === 'w';
    await expect.poll(async () => (await image.boundingBox())?.[horizontal ? 'width' : 'height'] ?? 0)
      .toBeCloseTo(before[horizontal ? 'width' : 'height'] * 1.1, 1);
    const after = (await image.boundingBox())!;
    expect(after[horizontal ? 'height' : 'width']).toBeCloseTo(before[horizontal ? 'height' : 'width'], 1);
    expect(after[horizontal ? 'y' : 'x']).toBeCloseTo(before[horizontal ? 'y' : 'x'], 1);
    if (handle === 'w') expect(after.x + after.width).toBeCloseTo(before.x + before.width, 1);
    if (handle === 'n') expect(after.y + after.height).toBeCloseTo(before.y + before.height, 1);
    if (handle === 'e') expect(after.x).toBeCloseTo(before.x, 1);
    if (handle === 's') expect(after.y).toBeCloseTo(before.y, 1);
    await page.keyboard.press('Control+z'); await ready(page);
    expect((await image.boundingBox())!.width).toBeCloseTo(before.width, 1);
    expect((await image.boundingBox())!.height).toBeCloseTo(before.height, 1);
  });
}

test('the first real drag on an inactive visible page moves once and a single undo restores its pixels', async ({ page }) => {
  const { second, at } = await inactiveSecondPage(page);
  const canvas = second.locator('.pdf-canvas');
  const before = await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL());
  const start = at(95, 225);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 15, { steps: 8 }); await page.mouse.up();
  await expect(page.getByLabel('Page', { exact: true })).toHaveValue('2');
  await expect(page.locator('.object-hitbox-selected')).toHaveCount(1);
  const path = page.locator('.object-hitbox-selected');
  await expect(path).toHaveAttribute('data-object-type', 'path'); await ready(page);
  const box = (await path.boundingBox())!, pageBox = (await second.boundingBox())!;
  expect(box.x - pageBox.x).toBeCloseTo(60 * 0.75 + 30, 1);
  expect(box.y - pageBox.y).toBeCloseTo(210 * 0.75 + 15, 1);
  expect(await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL())).not.toBe(before);
  await page.keyboard.press('Control+z'); await ready(page);
  await expect.poll(() => canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL())).toBe(before);
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
});

test('an inactive page accepts its first click, modifier selection and ordinary text double-click', async ({ page }) => {
  const { at } = await inactiveSecondPage(page);
  const first = at(95, 225), next = at(205, 280);
  await page.mouse.click(first.x, first.y);
  await expect(page.locator('.object-hitbox-selected')).toHaveCount(1);
  await page.keyboard.down('Control'); await page.mouse.click(next.x, next.y); await page.keyboard.up('Control');
  await expect(page.locator('.object-hitbox-selected')).toHaveCount(2);
  await expect(page.locator('.save-state')).toHaveText('Saved');
  await page.locator('.object-hitbox[data-object-type="text"]').dblclick();
  await expect(page.getByRole('textbox', { name: 'Page text', exact: true })).toHaveText('PAGE 2');
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-state')).toHaveText('Saved');
});

test('the first inactive-page marquee selects only its enclosed objects without changing content', async ({ page }) => {
  const { at } = await inactiveSecondPage(page);
  const start = at(45, 195), end = at(240, 310);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.object-hitbox-selected')).toHaveCount(2);
  await expect(page.locator('.object-hitbox-selected[data-object-type="path"]')).toHaveCount(2);
  await expect(page.locator('.save-state')).toHaveText('Saved');
});
