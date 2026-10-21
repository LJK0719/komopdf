import { test, expect } from '@playwright/test';

test('editing one page preserves other visible page canvases and thumbnails', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('komopdf.ui.language', 'en');
    const stats = { calls: [] as { method: string; args: unknown[] }[], paints: [] as string[] };
    Object.assign(window, { refreshStats: stats });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: any, ...args: any[]) {
      if (message.method) stats.calls.push({ method: message.method, args: message.args });
      return post.call(this, message, ...args as [any]);
    };
    const paint = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args: any[]) {
      const canvas = this.canvas;
      stats.paints.push(`${canvas.closest<HTMLElement>('[data-document-page]')?.dataset.documentPage ?? 'thumbnail'}:${canvas.className}`);
      return paint.apply(this, args as [ImageData, number, number]);
    };
  });
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'refresh.pdf', mimeType: 'application/pdf', buffer: fixture() });
  await expect(page.locator('.document-pages .pdf-canvas')).toHaveCount(3);
  await page.getByRole('button', { name: 'Open page 1', exact: true }).click();
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  const object = page.locator('.object-hitbox[data-object-type="text"]').first();
  await object.click();
  const other = page.locator('.page-wrap[data-page-number="3"] .pdf-canvas');
  const pageId = await other.evaluate(canvas => {
    Object.assign(window, { preservedCanvas: canvas, preservedPixels: (canvas as HTMLCanvasElement).toDataURL() });
    return canvas.closest<HTMLElement>('[data-document-page]')!.dataset.documentPage!;
  });
  await page.evaluate(() => {
    const stats = (window as any).refreshStats;
    stats.calls = []; stats.paints = [];
  });
  const start = performance.now();
  await page.keyboard.press('Delete');
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  // Let optional thumbnail and recovery work settle before collecting request counts.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const stats = await page.evaluate(() => (window as any).refreshStats);
  console.log(JSON.stringify({ elapsedMs: performance.now() - start, ...stats }));
  if (!process.env.PERF_BASELINE) {
    expect(stats.calls.filter((call: any) => call.method === 'previewTransaction')).toHaveLength(0);
    expect(stats.calls.filter((call: any) => call.method === 'render' && call.args[0].pageId === pageId)).toHaveLength(0);
    expect(stats.calls.filter((call: any) => call.method === 'describePage' && call.args[1] === pageId)).toHaveLength(0);
    expect(stats.paints.filter((id: string) => id.startsWith(`${pageId}:`))).toHaveLength(0);
    expect(await other.evaluate(canvas => canvas === (window as any).preservedCanvas && (canvas as HTMLCanvasElement).toDataURL() === (window as any).preservedPixels)).toBe(true);
  }
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(object).toBeVisible();
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('an unchanged tiled page keeps canvases and can render new tiles after another page commits', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'tiles.pdf', mimeType: 'application/pdf', buffer: fixture(true) });
  await expect(page.locator('.document-pages .page-wrap')).toHaveCount(3);
  const zoom = page.getByLabel('Zoom', { exact: true });
  await zoom.fill('400'); await zoom.press('Enter');
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Open page 1', exact: true }).click();
  const target = page.locator('.object-hitbox[data-object-type="text"]').first();
  await expect(target).toBeVisible();
  const tiles = page.locator('.page-wrap[data-page-number="2"] .pdf-tile');
  await expect.poll(() => tiles.count()).toBeGreaterThan(0);
  await expect.poll(() => tiles.first().evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
  await tiles.first().evaluate(canvas => { Object.assign(window, { preservedTile: canvas }); });
  await target.click(); await page.keyboard.press('Delete');
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).preservedTile.isConnected)).toBe(true);
  await page.locator('.canvas-stage').evaluate(stage => { stage.scrollTop += 1100; });
  await expect.poll(() => tiles.count()).toBeGreaterThan(0);
  await expect.poll(() => tiles.evaluateAll(nodes => nodes.every(node => (node as HTMLCanvasElement).width > 0))).toBe(true);
  await expect(page.getByText('Unable to display this page.', { exact: true })).toHaveCount(0);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('measures preview and apply separately as edit history grows', async ({ page }) => {
  await page.goto('/');
  const timings = await page.evaluate(async pdf => {
    const worker = new Worker('/engines/engine.worker.js', { type: 'module' });
    let sequence = 0;
    const pending = new Map<string, { resolve(value: any): void; reject(error: unknown): void }>();
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.requestId);
      if (!request) return;
      pending.delete(data.requestId);
      if (data.kind === 'engine-error') request.reject(data.error);
      else request.resolve(data.result ?? data.handshake);
    };
    const request = (message: object): Promise<any> => new Promise((resolve, reject) => {
      const requestId = String(++sequence); pending.set(requestId, { resolve, reject });
      worker.postMessage({ ...message, requestId });
    });
    const call = (method: string, ...args: unknown[]) => request({ kind: 'engine-request', method, args });
    try {
      await request({ kind: 'handshake' });
      const info = await call('open', { kind: 'bytes', sourceId: 'synthetic-history', name: 'history.pdf', bytes: new TextEncoder().encode(pdf).buffer });
      const model = await call('describePage', info.id, info.pageOrder[0]);
      const object = model.objects[0];
      const samples = [];
      for (let i = 0; i < 60; i++) {
        const transaction = { id: `edit-${i}`, docId: info.id, baseRevision: i, source: 'manual', commands: [{
          type: 'objects.transform', pageId: model.id, objectIds: [object.id], matrix: [1, 0, 0, 1, i % 2 ? -1 : 1, 0],
        }] };
        const start = performance.now();
        await call('previewTransaction', transaction);
        const afterPreview = performance.now();
        await call('apply', transaction);
        samples.push({ history: i, previewMs: afterPreview - start, applyMs: performance.now() - afterPreview });
      }
      const final = await call('describePage', info.id, model.id);
      await call('close', info.id);
      return { samples, before: object.bounds, after: final.objects[0].bounds };
    } finally { worker.terminate(); }
  }, fixture().toString());
  expect(timings.after).toEqual(timings.before);
  console.log(JSON.stringify({ transactionHistory: timings.samples }));
});

function fixture(largeSecond = false) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'];
  for (let i = 0; i < 3; i++) {
    const content = `BT /F1 16 Tf 30 115 Td (Page ${i + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${largeSecond && i === 1 ? '900 900' : '300 160'}] /Resources << /Font << /F1 9 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let text = '%PDF-1.7\n';
  const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(text); text += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
