import { test, expect, type Page } from '@playwright/test';

async function holdModels(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('komopdf.ui.language', 'en');
    const state = { hold: true, pending: [] as (() => void)[], calls: [] as string[], firstPaintCalls: null as string[] | null };
    Object.assign(window, { readingProbe: state, releaseReadingModels: () => {
      state.hold = false;
      for (const send of state.pending.splice(0)) send();
    } });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: any, ...args: any[]) {
      if (message.method) state.calls.push(message.method);
      if (message.method === 'describePage' && state.hold) {
        state.pending.push(() => post.call(this, message, ...args as [any]));
        return;
      }
      return post.call(this, message, ...args as [any]);
    };
    const paint = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args: any[]) {
      if (this.canvas.classList.contains('pdf-canvas') && !state.firstPaintCalls) state.firstPaintCalls = [...state.calls];
      return paint.apply(this, args as [ImageData, number, number]);
    };
  });
}

async function open(page: Page, pages = 3) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'reading-fast-path.pdf', mimeType: 'application/pdf', buffer: fixture(pages) });
  await expect.poll(() => page.locator('.page-wrap[data-page-number="1"] .pdf-canvas').evaluateAll(nodes => nodes.some(node => (node as HTMLCanvasElement).width > 0))).toBe(true);
}

test('first visible raster does not wait for an editing model or recovery snapshot', async ({ page }) => {
  await holdModels(page); await open(page);
  const calls = await page.evaluate(() => (window as any).readingProbe.firstPaintCalls as string[]);
  expect(calls).toContain('describePageMetrics'); expect(calls).toContain('render');
  expect(calls).not.toContain('describePage'); expect(calls).not.toContain('exportRecovery');
  await expect(page.locator('.page-wrap[data-page-number="1"]')).not.toHaveAttribute('data-model-state', 'ready');
  await page.evaluate(() => (window as any).releaseReadingModels());
  await expect(page.locator('.page-wrap[data-page-number="1"] .pdf-text-layer')).toBeVisible();
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('the first completed click on an unloaded neighboring page selects the real object', async ({ page }) => {
  await holdModels(page); await open(page);
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  const second = page.locator('.page-wrap[data-page-number="2"]');
  await expect(second.locator('.pdf-canvas')).toBeVisible();
  const box = (await second.boundingBox())!;
  await page.mouse.move(box.x + 62, box.y + 56); await page.mouse.down(); await page.mouse.up();
  await page.evaluate(() => (window as any).releaseReadingModels());
  await expect(page.getByLabel('Page', { exact: true })).toHaveValue('2');
  await expect(second.locator('.object-hitbox-selected')).toHaveCount(1);
  await expect(second.locator('.object-hitbox-selected')).toHaveAttribute('aria-pressed', 'true');
  await expect(second.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(1);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('a first box drag completed before model delivery is not discarded', async ({ page }) => {
  await holdModels(page); await open(page);
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  const first = page.locator('.page-wrap[data-page-number="1"]');
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 100, { steps: 4 }); await page.mouse.up();
  await page.evaluate(() => (window as any).releaseReadingModels());
  await expect(first.locator('.object-hitbox-selected')).toHaveCount(1);
  await expect(page.locator('.save-state')).toHaveText('No changes');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('cross-page selection keeps its offscreen anchor while new text layers arrive', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await open(page, 8);
  const first = page.locator('.page-wrap[data-page-number="1"]');
  await expect(first.locator('.pdf-text-layer')).toBeVisible();
  const start = (await first.boundingBox())!;
  await page.mouse.move(start.x + 39, start.y + 56); await page.mouse.down();
  await page.mouse.move(start.x + 140, start.y + 56, { steps: 3 });
  await page.locator('.canvas-stage').evaluate(stage => { stage.scrollTop = 1100; });
  const fifth = page.locator('.page-wrap[data-page-number="5"]');
  const target = (await fifth.boundingBox())!;
  await page.mouse.move(target.x + 240, target.y + 56, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Page 5');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Page 1');
  await expect(first.locator('.pdf-text-layer')).toHaveCount(1);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

function fixture(count = 3) {
  const kids = Array.from({ length: count }, (_, index) => `${4 + index * 2} 0 R`).join(' ');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let index = 0; index < count; index++) {
    const content = `BT /F1 16 Tf 30 250 Td (Page ${index + 1} selectable text) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
