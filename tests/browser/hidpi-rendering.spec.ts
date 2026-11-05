import { expect, test, type Page } from '@playwright/test';
import { pdfObjects } from './ai-integration-helpers.js';

test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 720 } });

function vectorPdf(width = 420, height = 220, paths = 0): Buffer {
  const vectors = Array.from({ length: paths }, (_, index) => {
    const x = 20 + index % 70 * 4, y = 20 + Math.floor(index / 70) * 2;
    return `${x} ${y} m ${x + 2} ${y + 1} l S`;
  }).join('\n');
  const content = `BT /F1 16 Tf 30 ${height - 60} Td (Sharp vector page) Tj ET\n0 0 0 RG 0.3 w 30 ${height - 85} m ${width - 30} ${height - 85} l S\n${vectors}`;
  return pdfObjects(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
}
async function openPdf(page: Page, name = 'density.pdf', bytes = vectorPdf()) {
  const chooser = page.waitForEvent('filechooser');
  const add = page.getByRole('button', { name: 'Open another PDF', exact: true });
  await (await add.count() ? add : page.getByRole('button', { name: 'Open PDF', exact: true })).click();
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('komopdf.ui.language', 'en');
    const state = { requests: [] as any[], hold: false, pending: [] as Array<() => void> };
    Object.assign(window, { densityProbe: state });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: any, ...args: any[]) {
      if (message.method === 'render') {
        const request = message.args[0]; state.requests.push(request);
        if (state.hold && request.scale >= 2) {
          state.pending.push(() => post.call(this, message, ...args as [any]));
          return;
        }
      }
      return post.call(this, message, ...args as [any]);
    };
  });
  await page.goto('/editor/');
});

test('Retina uses real high-resolution pixels and cross-screen repaint preserves the live text draft', async ({ page, context }, testInfo) => {
  await openPdf(page);
  const canvas = page.locator('.document-pages .pdf-canvas');
  await expect(canvas).toHaveJSProperty('width', 1050);
  await expect(canvas).toHaveJSProperty('height', 550);
  expect(await canvas.evaluate(node => node.getBoundingClientRect().width)).toBeCloseTo(525, 1);
  expect(await page.evaluate(() => (window as any).densityProbe.requests.some((request: any) => request.scale === 2.5 && !request.clip))).toBe(true);
  expect(await canvas.evaluate(node => (node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1050, 550).data.some((value, index) => index % 4 !== 3 && value < 100))).toBe(true);
  await page.locator('.page-wrap').screenshot({ path: testInfo.outputPath('retina-page.png') });
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  const object = page.locator('.object-hitbox[data-object-type="text"]').first();
  await object.dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toBeEditable();
  await input.fill('Draft stays sharp.');
  const bounds = await page.locator('.direct-text-editor').boundingBox();
  await canvas.evaluate(node => { Object.assign(window, { densityCanvas: node }); });
  const cdp = await context.newCDPSession(page);
  for (const ratio of [1.25, 3]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: ratio, mobile: false });
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(ratio);
    // CDP changes backing scale without emitting the native window/resolution events.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect(canvas).toHaveJSProperty('width', Math.ceil(525 * ratio));
    await expect(canvas).toHaveJSProperty('height', Math.ceil(275 * ratio));
    expect(await canvas.evaluate(node => node === (window as any).densityCanvas)).toBe(true);
    await expect(input).toBeFocused(); await expect(input).toBeEditable();
    expect(await input.evaluate(node => 'value' in node ? node.value : node.textContent)).toBe('Draft stays sharp.');
    const next = (await page.locator('.direct-text-editor').boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(next[key]).toBeCloseTo(bounds![key], 1);
  }
  await page.evaluate(() => {
    const stage = document.querySelector('.canvas-stage')!;
    const bounds = document.querySelector('.direct-text-editor')!.getBoundingClientRect();
    const point = { clientX: bounds.left + 10, clientY: bounds.top + 10, scale: 1.2 };
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) stage.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), point));
  });
  await expect(page.getByLabel('Zoom', { exact: true })).toHaveValue('150%');
  await expect(input).toBeFocused(); await expect(input).toBeEditable();
  expect(await input.evaluate(node => 'value' in node ? node.value : node.textContent)).toBe('Draft stays sharp.');
  expect((await page.locator('.direct-text-editor').boundingBox())!.width).toBeCloseTo(bounds!.width * 1.2, 1);
  await expect(page.locator('.stage-progress')).toHaveCount(0);
  await expect(canvas).toHaveJSProperty('width', 1890);
  await input.press('Escape');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('rapid zoom changes keep only the newest pending render and never paint an obsolete size', async ({ page }) => {
  await openPdf(page);
  await expect(page.locator('.document-pages .pdf-canvas')).toHaveJSProperty('width', 1050);
  await page.evaluate(() => { (window as any).densityProbe.requests = []; (window as any).densityProbe.hold = true; });
  const zoom = page.getByLabel('Zoom', { exact: true });
  await zoom.fill('300'); await zoom.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).densityProbe.pending.length)).toBe(1);
  expect(await page.locator('.page-wrap').evaluate(node => node.getBoundingClientRect().width)).toBeCloseTo(1260, 1);
  await expect(page.locator('.document-pages .pdf-canvas')).toHaveJSProperty('width', 1050);
  await expect(page.locator('.stage-progress')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  for (const value of ['350', '200']) { await zoom.fill(value); await zoom.press('Enter'); }
  expect(await page.locator('.page-wrap').evaluate(node => node.getBoundingClientRect().width)).toBeCloseTo(840, 1);
  await page.evaluate(() => {
    const state = (window as any).densityProbe; state.hold = false;
    state.pending.splice(0).forEach((send: () => void) => send());
  });
  await expect(page.locator('.document-pages .pdf-canvas')).toHaveJSProperty('width', 1680);
  await expect(zoom).toHaveValue('200%');
  const scales = await page.evaluate(() => (window as any).densityProbe.requests.filter((request: any) => request.scale >= 2 && !request.clip).map((request: any) => request.scale));
  expect(scales).toEqual([6, 4]);
  expect(await page.locator('.page-wrap').evaluate(node => node.getBoundingClientRect().width)).toBeCloseTo(840, 1);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('high-DPI tiles cover the scrolled viewport at physical resolution', async ({ page }) => {
  await openPdf(page, 'large-density.pdf', vectorPdf(2000, 3000));
  const tiles = page.locator('.pdf-tile');
  await expect.poll(() => tiles.count()).toBeGreaterThan(0);
  await page.locator('.canvas-stage').evaluate(stage => { stage.scrollLeft = 700; stage.scrollTop = 1400; });
  await expect.poll(() => page.evaluate(() => {
    const stage = document.querySelector('.canvas-stage')!.getBoundingClientRect();
    const wrapper = document.querySelector('.page-wrap')!.getBoundingClientRect();
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.pdf-tile')];
    if (!canvases.length || canvases.some(canvas => !canvas.width)) return -1;
    const rects = canvases.map(canvas => canvas.getBoundingClientRect());
    let missing = 0;
    for (let y = Math.max(stage.top, wrapper.top) + 8; y < Math.min(stage.bottom, wrapper.bottom) - 20; y += 100) {
      for (let x = Math.max(stage.left, wrapper.left) + 8; x < Math.min(stage.right, wrapper.right) - 20; x += 100) {
        if (!rects.some(rect => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)) missing++;
      }
    }
    return missing;
  })).toBe(0);
  expect(await tiles.evaluateAll(nodes => nodes.every(node => {
    const canvas = node as HTMLCanvasElement;
    return Math.abs(canvas.width / Number.parseFloat(canvas.style.width) - 2) < 0.001;
  }))).toBe(true);
  await expect(page.getByText('Unable to display this page.', { exact: true })).toHaveCount(0);
});

test('raster mode changes retain the last painted generation until all new visible tiles are ready', async ({ page }) => {
  await openPdf(page, 'transition.pdf', vectorPdf(900, 1100));
  const canvas = page.locator('.document-pages .pdf-canvas');
  await expect(canvas).toHaveJSProperty('width', 2250);
  await page.evaluate(() => { (window as any).densityProbe.hold = true; });
  const zoom = page.getByLabel('Zoom', { exact: true });
  await zoom.fill('200'); await zoom.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).densityProbe.pending.length)).toBe(1);
  await expect(canvas).toHaveJSProperty('width', 2250);
  expect(await canvas.evaluate(node => node.getBoundingClientRect().width)).toBeCloseTo(1800, 1);
  await zoom.fill('300'); await zoom.press('Enter');
  await expect(page.locator('.page-wrap')).toHaveJSProperty('clientWidth', 2700);
  await expect(canvas).toHaveJSProperty('width', 2250);
  await expect(page.locator('.stage-progress')).toHaveCount(0);
  await page.evaluate(() => { const state = (window as any).densityProbe; state.hold = false; state.pending.splice(0).forEach((send: () => void) => send()); });
  await expect(canvas).toHaveCount(0);
  await expect.poll(() => page.locator('.pdf-tile').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => (node as HTMLCanvasElement).width > 0))).toBe(true);
  await page.evaluate(() => { (window as any).densityProbe.hold = true; });
  // Use a new scale: the initial 125% raster is deliberately retained by the cache.
  await zoom.fill('130'); await zoom.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).densityProbe.pending.length)).toBe(1);
  expect(await page.locator('.pdf-tile').evaluateAll(nodes => nodes.some(node => (node as HTMLCanvasElement).width > 0))).toBe(true);
  await page.evaluate(() => { const state = (window as any).densityProbe; state.hold = false; state.pending.splice(0).forEach((send: () => void) => send()); });
  await expect(canvas).toHaveJSProperty('width', 2340);
  await expect(page.locator('.pdf-tile')).toHaveCount(0);
  await page.evaluate(() => { const state = (window as any).densityProbe; state.requests = []; state.hold = true; });
  await zoom.fill('125'); await zoom.press('Enter');
  await expect(canvas).toHaveJSProperty('width', 2250);
  expect(await page.evaluate(() => (window as any).densityProbe.pending.length)).toBe(0);
  expect(await page.evaluate(() => (window as any).densityProbe.requests.length)).toBe(0);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('editing-mode zoom transforms a dense hitbox layer without rewriting every object style', async ({ page }) => {
  await openPdf(page, 'dense-vector.pdf', vectorPdf(612, 792, 5000));
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.object-hitbox')).toHaveCount(5002);
  const result = await page.evaluate(async () => {
    const stage = document.querySelector('.canvas-stage')!, layer = document.querySelector('.selection-layer')!;
    const before = layer.querySelector('.object-hitbox')!;
    const bounds = document.querySelector('.page-wrap')!.getBoundingClientRect();
    const point = { clientX: bounds.left + 60, clientY: bounds.top + 60 };
    let changes = 0;
    const observer = new MutationObserver(records => { changes += records.filter(record => (record.target as Element).matches('.object-hitbox')).length; });
    observer.observe(layer, { subtree: true, attributes: true, attributeFilter: ['style'] });
    const send = (type: string, scale: number) => stage.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { ...point, scale }));
    send('gesturestart', 1);
    for (let index = 1; index <= 30; index++) { send('gesturechange', 1 + index / 150); await new Promise(requestAnimationFrame); }
    send('gestureend', 1.2);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    observer.disconnect();
    return { changes, sameNode: before === layer.querySelector('.object-hitbox'), width: document.querySelector('.page-wrap')!.getBoundingClientRect().width };
  });
  expect(result).toEqual({ changes: 0, sameNode: true, width: 918 });
  const object = page.locator('.object-hitbox[data-object-type="text"]').first();
  await object.click(); await expect(object).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.stage-progress')).toHaveCount(0);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('gesture-event pinch previews every frame without rendering, replacing character nodes, or blocking the UI', async ({ page }) => {
  await openPdf(page);
  await expect(page.locator('.document-pages .pdf-canvas')).toHaveJSProperty('width', 1050);
  await expect(page.locator('.pdf-character').first()).toBeVisible();
  const result = await page.evaluate(async () => {
    const state = (window as any).densityProbe; state.requests = []; state.hold = true;
    const stage = document.querySelector('.canvas-stage')!, wrapper = document.querySelector('.page-wrap')!;
    const canvas = wrapper.querySelector('canvas')!, character = wrapper.querySelector('.pdf-character')!;
    const bounds = wrapper.getBoundingClientRect(), start = performance.now();
    const point = { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
    let styleChanges = 0;
    const observer = new MutationObserver(changes => { styleChanges += changes.length; });
    observer.observe(character, { attributes: true, attributeFilter: ['style'] });
    const selection = window.getSelection()!, first = character.firstChild!;
    selection.setBaseAndExtent(first, 0, first, first.textContent!.length);
    const selected = selection.toString();
    const send = (type: string, scale = 1) => stage.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { ...point, scale }));
    send('gesturestart');
    let firstFeedbackMs = 0;
    for (let index = 1; index <= 100; index++) {
      send('gesturechange', 1 + index * 0.006);
      await new Promise(requestAnimationFrame);
      if (!firstFeedbackMs && wrapper.getBoundingClientRect().width !== bounds.width) firstFeedbackMs = performance.now() - start;
    }
    await new Promise(requestAnimationFrame);
    const preview = { width: wrapper.getBoundingClientRect().width, physicalWidth: canvas.width,
      renderCalls: state.requests.filter((request: any) => request.scale >= 2).length, styleChanges,
      canvasRetained: wrapper.querySelector('canvas') === canvas, characterRetained: wrapper.querySelector('.pdf-character') === character,
      selected: selection.toString(), initialSelection: selected, firstFeedbackMs };
    send('gestureend', 1.6); observer.disconnect();
    return preview;
  });
  expect(result.width).toBeCloseTo(840, 1); expect(result.physicalWidth).toBe(1050);
  expect(result.renderCalls).toBe(0); expect(result.styleChanges).toBe(0);
  expect(result.canvasRetained && result.characterRetained).toBe(true);
  expect(result.selected).toBe(result.initialSelection); expect(result.firstFeedbackMs).toBeGreaterThan(0);
  await expect(page.locator('.stage-progress')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).densityProbe.pending.length)).toBe(1);
  await page.evaluate(() => { const state = (window as any).densityProbe; state.hold = false; state.pending.splice(0).forEach((send: () => void) => send()); });
  await expect(page.locator('.document-pages .pdf-canvas')).toHaveJSProperty('width', 1680);
  console.log(JSON.stringify({ pinch: result }));
});

test('Fit follows continuous window changes while the old bitmap stays visible and editable', async ({ page }) => {
  await openPdf(page);
  await page.getByRole('button', { name: 'Fit width', exact: true }).click();
  await expect.poll(() => page.locator('.pdf-canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width /
    canvas.getBoundingClientRect().width)).toBeCloseTo(2, 2);
  await page.evaluate(() => { const state = (window as any).densityProbe; state.requests = []; state.hold = true; });
  for (const width of [1320, 1380, 1450, 1520, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.locator('.pdf-canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
    await expect(page.locator('.stage-progress')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  }
  const width = await page.locator('.page-wrap').evaluate(node => node.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(900);
  await page.evaluate(() => { const state = (window as any).densityProbe; state.hold = false; state.pending.splice(0).forEach((send: () => void) => send()); });
  await expect.poll(() => page.locator('.pdf-canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width /
    canvas.getBoundingClientRect().width)).toBeCloseTo(2, 2);
  const requests = await page.evaluate(() => (window as any).densityProbe.requests.filter((request: any) => request.scale >= 2 && !request.clip));
  expect(requests.length).toBeLessThanOrEqual(2);
});

test('switching documents reconstructs evicted pixels at the current density', async ({ page }) => {
  await openPdf(page, 'first-density.pdf');
  await expect(page.locator('.document-pages .pdf-canvas')).toHaveJSProperty('width', 1050);
  await openPdf(page, 'second-density.pdf');
  await page.evaluate(() => { (window as any).densityProbe.requests = []; });
  await page.getByRole('tab', { name: 'first-density.pdf', exact: true }).click();
  await expect(page.locator('.document-pages .pdf-canvas')).toHaveJSProperty('width', 1050);
  expect(await page.evaluate(() => (window as any).densityProbe.requests.some((request: any) => request.scale === 2.5 && !request.clip))).toBe(true);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});
