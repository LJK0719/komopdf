import { test, expect, type Page } from '@playwright/test';
import type { TextActionRequest } from '@pdf-editor/contracts';
import { imageAiPdf, textareaAiPdf, openAiPdf, selectAiText } from './ai-integration-helpers';

async function tools(page: Page, result = 'Translated passage') {
  const requests: TextActionRequest[] = [];
  await page.route('**/api/v1/ai/text-actions', route => {
    const request = route.request().postDataJSON() as TextActionRequest; requests.push(request);
    return route.fulfill({ json: { requestId: request.requestId, action: request.action, detectedLanguage: 'en', segments: request.segments.map(segment => ({ id: segment.id, text: result })) } });
  });
  return requests;
}
async function translate(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Translate selected text', exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('combobox')).toHaveCount(1);
  await dialog.getByRole('combobox', { name: 'Target language', exact: true }).selectOption('zh');
  await dialog.getByRole('button', { name: 'Translate', exact: true }).click();
  return page.getByRole('dialog', { name: 'Translation', exact: true });
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
});

test('translation only asks for the target language and starts once', async ({ page }) => {
  const requests = await tools(page); await page.goto('/editor/'); await openAiPdf(page);
  await selectAiText(page); await page.getByRole('menuitem', { name: 'Translate', exact: true }).click();
  const language = page.getByRole('dialog', { name: 'Translate selected text', exact: true });
  await expect(language.getByRole('combobox')).toHaveCount(1); expect(requests).toHaveLength(0);
  await language.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(requests).toHaveLength(0);
  await selectAiText(page); await page.getByRole('menuitem', { name: 'Translate', exact: true }).click(); const window = await translate(page);
  await expect(window.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('Translated passage');
  expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ sourceLanguage: 'auto', targetLanguage: 'zh' });
  await expect(page.locator('.inspector-panel')).toBeHidden(); await expect(window).toHaveAttribute('aria-modal', 'false');
  const copy = window.getByRole('button', { name: 'Copy translation', exact: true }); await expect(copy).toBeVisible();
  expect(await copy.evaluate(button => getComputedStyle(button).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.locator('.app-dialog-backdrop')).toHaveCount(0); await page.screenshot({ path: 'tmp/browser/ai-quick-floating.png' });
});

test('individual PDF glyph objects translate as one passage and apply once', async ({ page }) => {
  const requests = await tools(page, 'Hi'); await page.goto('/editor/'); await openAiPdf(page, 'fragmented.pdf', ['Hello world.'], true);
  expect(await page.locator('[data-text-object]').count()).toBeGreaterThan(8);
  await selectAiText(page, 11); await page.getByRole('menuitem', { name: 'Translate', exact: true }).click(); const window = await translate(page);
  await expect(window.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('Hi');
  expect(requests).toHaveLength(1); expect(requests[0]?.segments).toHaveLength(1); expect(requests[0]?.segments[0]?.text).toBe('Hello world');
  await window.getByRole('button', { name: 'View original', exact: true }).click(); await expect(window.getByRole('textbox', { name: 'Original text on page 1' })).toHaveValue('Hello world');
  await window.getByRole('button', { name: 'Apply to PDF', exact: true }).click(); await expect(page.locator('.pdf-text-layer')).toHaveText('Hi.');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click(); await expect(page.locator('.pdf-text-layer')).toHaveText('Hello world.');
  expect(requests).toHaveLength(1);
});

test('the floating result can be dragged and leaves context menus usable', async ({ page }) => {
  await tools(page); await page.goto('/editor/'); await openAiPdf(page); await selectAiText(page);
  await page.getByRole('menuitem', { name: 'Translate', exact: true }).click(); const window = await translate(page);
  await expect(window.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('Translated passage');
  const before = (await window.boundingBox())!, title = (await window.locator('.ai-floating-title').boundingBox())!;
  await page.mouse.move(title.x + 80, title.y + 15); await page.mouse.down(); await page.mouse.move(title.x + 180, title.y + 115, { steps: 6 }); await page.mouse.up();
  const after = (await window.boundingBox())!; expect(after.x - before.x).toBeGreaterThan(50); expect(after.y - before.y).toBeGreaterThan(50);
  await selectAiText(page); await page.getByRole('menuitem', { name: 'Use AI', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Use AI', exact: true })).toBeVisible(); await expect(page.locator('.save-state')).toHaveText('No changes');
});

test('selection and ribbon translation share the same target-language picker', async ({ page }) => {
  const requests = await tools(page); await page.goto('/editor/'); await openAiPdf(page); await selectAiText(page); await page.keyboard.press('Escape');
  await page.getByRole('toolbar', { name: 'Selected text tools', exact: true }).getByRole('button', { name: 'Translate', exact: true }).click();
  const language = page.getByRole('dialog', { name: 'Translate selected text', exact: true }); await expect(language).toBeVisible(); await language.getByRole('button', { name: 'Cancel', exact: true }).click();
  await selectAiText(page); await page.keyboard.press('Escape');
  await page.locator('.ribbon-content').getByRole('button', { name: 'Translate', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Translate selected text', exact: true }).click(); const window = await translate(page);
  await expect(window.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('Translated passage');
  expect(requests).toHaveLength(1); expect(requests[0]?.segments[0]?.text).toBe('Hello');
});

test('object-mode right-click preserves the chosen text through language selection', async ({ page }) => {
  const requests = await tools(page); await page.goto('/editor/'); await openAiPdf(page);
  await page.getByRole('button', { name: 'Edit content', exact: true }).click(); await page.locator('.object-hitbox[data-object-type="text"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Translate', exact: true }).click(); const window = await translate(page);
  await expect(window.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('Translated passage');
  expect(requests[0]?.segments[0]?.text).toBe('Hello from this PDF.'); await expect(page.locator('.save-state')).toHaveText('No changes');
});

test('a scanned-page translation opens the connected-service panel directly', async ({ page }) => {
  const requests = await tools(page); await page.goto('/editor/'); const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click(); await (await chooser).setFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: imageAiPdf() });
  await expect(page.getByRole('tab', { name: 'scan.pdf', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.locator('.pdf-text-layer').click({ button: 'right', position: { x: 80, y: 80 } });
  await page.getByRole('menuitem', { name: 'Translate scanned PDF', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Translate PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Translate scanned PDF', exact: true })).toHaveCount(0); expect(requests).toHaveLength(0);
});

test('textarea drafts keep selection and local undo through translation', async ({ page }) => {
  const requests = await tools(page, 'Draft translation'); await page.goto('/editor/'); const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click(); await (await chooser).setFiles({ name: 'rotated-text.pdf', mimeType: 'application/pdf', buffer: textareaAiPdf() });
  await expect(page.getByRole('tab', { name: 'rotated-text.pdf', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Edit content', exact: true }).click(); await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.locator('.direct-text-editor textarea'); await expect(input).toBeVisible(); await input.fill('An unsaved textarea draft.');
  await input.press('Control+A'); await input.press('Shift+F10'); await page.getByRole('menuitem', { name: 'Translate', exact: true }).click(); const window = await translate(page);
  await expect(window.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('Draft translation');
  expect(requests).toHaveLength(1); expect(requests[0]?.segments[0]?.text).toBe('An unsaved textarea draft.'); await expect(input).toHaveValue('An unsaved textarea draft.');
  await window.getByRole('button', { name: 'Apply to draft', exact: true }).click(); await expect(input).toHaveValue('Draft translation');
  await input.focus(); await input.press('Control+z'); await expect(input).toHaveValue('An unsaved textarea draft.');
});

test('both ribbon rows are centered on a wide viewport', async ({ page }) => {
  await page.goto('/editor/'); await openAiPdf(page);
  for (const selector of ['.ribbon-tabs', '.ribbon-content']) {
    const geometry = await page.locator(selector).evaluate(element => {
      const outer = element.getBoundingClientRect(), boxes = [...element.children].map(child => child.getBoundingClientRect()).filter(box => box.width && box.height);
      return { center: (outer.left + outer.right) / 2, start: Math.min(...boxes.map(box => box.left)), end: Math.max(...boxes.map(box => box.right)) };
    });
    expect(Math.abs((geometry.start + geometry.end) / 2 - geometry.center)).toBeLessThan(3);
  }
});
