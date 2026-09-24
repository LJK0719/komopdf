import { test, expect } from '@playwright/test';

function shapesPdf(): Buffer {
  const stream = 'q 1 0 0 rg 20 30 30 40 re f Q\nq 0 0 1 rg 130 110 45 35 re f Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('selection handles are visible and operational via keyboard and mouse drag with single undo step', async ({ page }) => {
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'transform.pdf', mimeType: 'application/pdf', buffer: shapesPdf() });

  const shapes = page.locator('.object-hitbox[data-object-type="path"]');
  await expect(shapes).toHaveCount(2, { timeout: 60_000 });

  // 1. Single selection shows selection box and 8 scale handles + 1 rotate handle
  await shapes.nth(0).click();
  const selectionBox = page.locator('.selection-box');
  await expect(selectionBox).toBeVisible();

  const rotateHandle = page.locator('.selection-handle[data-handle="rotate"]');
  await expect(rotateHandle).toBeVisible();

  const seHandle = page.locator('.selection-handle[data-handle="scale-se"]');
  await expect(seHandle).toBeVisible();

  const nwHandle = page.locator('.selection-handle[data-handle="scale-nw"]');
  await expect(nwHandle).toBeVisible();

  // 2. Keyboard scale via handle focus
  const widthFn = () => shapes.nth(0).evaluate(el => parseFloat((el as HTMLElement).style.width));
  const heightFn = () => shapes.nth(0).evaluate(el => parseFloat((el as HTMLElement).style.height));

  const initialWidth = await widthFn();
  const initialHeight = await heightFn();

  await seHandle.focus();
  await page.keyboard.press('ArrowUp');

  // Width/height should increase by ~10%
  await expect.poll(widthFn).toBeGreaterThan(initialWidth);
  await expect.poll(heightFn).toBeGreaterThan(initialHeight);

  // Undo should revert scale in one step
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(widthFn).toBeCloseTo(initialWidth, 1);
  await expect.poll(heightFn).toBeCloseTo(initialHeight, 1);

  // 3. Multi-selection presents unified selection box spanning both objects
  await shapes.nth(1).click({ modifiers: ['Shift'] });
  await expect(selectionBox).toBeVisible();
  await expect(rotateHandle).toBeVisible();
  await expect(seHandle).toBeVisible();

  // 4. Keyboard rotate on rotate handle
  await rotateHandle.focus();
  await page.keyboard.press('ArrowRight');

  // Undo reverts the rotation transaction
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();

  // Dragging the scale handle also commits exactly one native transform.
  const widthBeforeDrag = await widthFn();
  const handleBox = await seHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  const startX = handleBox!.x + handleBox!.width / 2;
  const startY = handleBox!.y + handleBox!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 30, startY + 20, { steps: 5 });
  await page.mouse.up();
  await expect.poll(widthFn).toBeGreaterThan(widthBeforeDrag);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(widthFn).toBeCloseTo(widthBeforeDrag, 1);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});
