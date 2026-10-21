import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function fixture(face = 'Helvetica-Bold', secondLine = false) {
  const first = 'Original bold italic text';
  const text = first + (secondLine ? '\nSecond italic line' : '');
  const stream = `BT /F1 18 Tf 0.8 Tc 0.75 0 0 0.75 35 240 Tm (${first}) Tj ${secondLine ? '/F2 18 Tf 0 -24 Td (Second italic line) Tj' : ''} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 450 300] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, `<< /Type /Font /Subtype /Type1 /BaseFont /${face} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>'];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return { text, bytes: Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`) };
}

async function enter(page: Page, face = 'Helvetica-Bold', zoom = '100%', index = 5, secondLine = false, fraction = 0.15) {
  const sample = fixture(face, secondLine);
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'first-input.pdf', mimeType: 'application/pdf', buffer: sample.bytes });
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled({ timeout: 60_000 });
  await page.getByLabel('Zoom', { exact: true }).fill(zoom);
  await page.getByLabel('Zoom', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.locator('.pdf-character')).toHaveCount(sample.text.replaceAll('\n', '').length);
  const box = (await page.locator('.pdf-character').nth(index).boundingBox())!;
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.mouse.dblclick(box.x + box.width * fraction, box.y + box.height / 2);
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(input).toHaveText(sample.text);
  return { input, text: sample.text, box };
}

for (const zoom of ['100%', '150%']) {
  test(`first double-click places a visible blinking caret at the clicked character (${zoom})`, async ({ page }) => {
    const { input, text, box } = await enter(page, 'Helvetica-Bold', zoom);
    await expect(input).toBeFocused();
    const caret = page.locator('.inline-source-caret');
    await expect(caret).toHaveAttribute('data-offset', '5');
    expect((await caret.boundingBox())!.x).toBeCloseTo(box.x, 0);
    expect(await caret.evaluate(node => {
      const animation = node.getAnimations()[0]!;
      animation.pause(); animation.currentTime = 0;
      const visible = getComputedStyle(node).opacity;
      animation.currentTime = 700;
      return [visible, getComputedStyle(node).opacity];
    })).toEqual(['1', '0']);
    await page.keyboard.type('X');
    await expect(input).toHaveText(text.slice(0, 5) + 'X' + text.slice(5));
    await page.keyboard.press('Escape');
    await expect(page.locator('.save-state')).toHaveText('No changes');
  });
}

for (const [index, fraction, expected] of [[24, 0.85, 25], [29, 0.15, 30]]) {
  test(`first double-click keeps source line and mixed style at offset ${expected}`, async ({ page }) => {
    const { input, text, box } = await enter(page, 'Helvetica-Bold', '100%', index, true, fraction);
    const caret = page.locator('.inline-source-caret');
    await expect(caret).toHaveAttribute('data-offset', String(expected));
    const rect = (await caret.boundingBox())!;
    expect(rect.y).toBeCloseTo(box.y, 0);
    expect(rect.x).toBeCloseTo(box.x + (fraction! > 0.5 ? box.width : 0), 0);
    await page.keyboard.type('X');
    await expect(input).toHaveText(text.slice(0, expected) + 'X' + text.slice(expected));
    const inserted = input.locator('[data-lexical-text]').filter({ hasText: /X/ });
    await expect(inserted).toHaveCSS('font-weight', expected === 25 ? '700' : '400');
    await expect(inserted).toHaveCSS('font-style', expected === 25 ? 'normal' : 'italic');
    await page.keyboard.press('Escape');
    await expect(page.locator('.save-state')).toHaveText('No changes');
  });
}

for (const releaseBeforeInput of [true, false]) {
  test(`cold font preview keeps insertion style (release before typing: ${releaseBeforeInput})`, async ({ page }) => {
    await page.addInitScript(() => {
      const load = FontFace.prototype.load;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      Object.assign(window, { releasePreview: release });
      FontFace.prototype.load = function () { return ready.then(() => load.call(this)); };
    });
    const { input } = await enter(page, 'LiberationSans-BoldItalic');
    const release = () => page.evaluate(() => (window as any).releasePreview());
    if (releaseBeforeInput) {
      await release();
      await expect.poll(() => input.locator('[data-lexical-text]').first().evaluate(node => getComputedStyle(node).fontFamily))
        .toContain('komopdf-liberation-sans-bold-italic');
      await expect(page.locator('.direct-text-editor')).toHaveAttribute('data-pristine', 'true');
    }
    await page.keyboard.type('X');
    if (!releaseBeforeInput) await release();
    await expect.poll(() => input.locator('[data-lexical-text]').evaluateAll(nodes => nodes.every(node =>
      getComputedStyle(node).fontFamily.includes('komopdf-liberation-sans-bold-italic') &&
      getComputedStyle(node).fontWeight === '700' && getComputedStyle(node).fontStyle === 'italic'))).toBe(true);
    await page.keyboard.type('Y');
    await expect(input).toHaveText('OrigiXYnal bold italic text');
    await page.keyboard.press('Escape');
    await expect(page.locator('.save-state')).toHaveText('No changes');
  });
}

test('late preview does not undo explicit bold and italic changes', async ({ page }) => {
  await page.addInitScript(() => {
    const load = FontFace.prototype.load;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    Object.assign(window, { releasePreview: release });
    FontFace.prototype.load = function () { return ready.then(() => load.call(this)); };
  });
  const { input } = await enter(page, 'LiberationSans-BoldItalic');
  await input.press('Control+A'); // This scenario explicitly changes the whole paragraph.
  const bold = page.getByRole('button', { name: 'Bold', exact: true });
  const italic = page.getByRole('button', { name: 'Italic', exact: true });
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await italic.click();
  await expect(italic).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => (window as any).releasePreview());
  await expect.poll(() => input.locator('[data-lexical-text]').first().evaluate(node => getComputedStyle(node).fontFamily))
    .toContain('komopdf-liberation-sans-regular');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('X');
  for (const node of await input.locator('[data-lexical-text]').all()) {
    await expect(node).toHaveCSS('font-weight', '400');
    await expect(node).toHaveCSS('font-style', 'normal');
  }
  await input.press('Control+A');
  await bold.click();
  await italic.click();
  await page.keyboard.press('Control+Enter');
  await expect(input).toHaveCount(0);
  await page.locator('[data-object-type="text"]').first().dblclick();
  await page.keyboard.type('Y');
  for (const node of await input.locator('[data-lexical-text]').all()) {
    await expect(node).toHaveCSS('font-weight', '700');
    await expect(node).toHaveCSS('font-style', 'italic');
  }
  await page.keyboard.press('Escape');
});

for (const [face, weight, italic] of [
  ['Helvetica-Bold', 700, false], ['Helvetica-Oblique', 400, true], ['Helvetica-BoldOblique', 700, true],
] as const) {
  test(`typing immediately after double-click preserves ${face}`, async ({ page }) => {
    const { input, text } = await enter(page, face);
    const styles = () => input.locator('[data-lexical-text]').evaluateAll(nodes => nodes.map(node => ({
      weight: Number(getComputedStyle(node).fontWeight), italic: getComputedStyle(node).fontStyle,
    })));
    const checkStyle = async () => {
      const values = await styles();
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) expect(value).toEqual({ weight, italic: italic ? 'italic' : 'normal' });
    };
    await checkStyle();
    await page.keyboard.type('XY');
    const edited = text.slice(0, 5) + 'XY' + text.slice(5);
    await expect(input).toHaveText(edited);
    await checkStyle();
    await page.keyboard.press('Control+Enter');
    await expect(input).toHaveCount(0);
    await expect(page.locator('.property-error')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
    await page.locator('[data-object-type="text"]').first().dblclick();
    await expect(input).toHaveText(text);
    await checkStyle();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Redo (Ctrl Shift Z)', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
    const saved = await readFile((await (await download).path())!);
    expect(saved.toString('latin1')).toContain(`/${face}`);
    await page.reload();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
    await (await chooser).setFiles({ name: 'saved-face.pdf', mimeType: 'application/pdf', buffer: saved });
    await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
    await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('[data-object-type="text"]').first().dblclick();
    await expect(input).toHaveText(edited);
    await checkStyle();
    await page.keyboard.type('Z');
    await checkStyle();
    await page.keyboard.press('Escape');
  });
}
