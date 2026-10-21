import { expect, test, type Page } from '@playwright/test';
import type { AiRequest, TextActionRequest } from '@pdf-editor/contracts';
import { mockAiAccount, openAiPdf, selectAiText } from './ai-integration-helpers';

async function mockTools(page: Page, result = '你好') {
  const requests: TextActionRequest[] = [];
  await page.route('**/api/v1/ai/text-actions', route => {
    const request = route.request().postDataJSON() as TextActionRequest; requests.push(request);
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ json: { requestId: request.requestId, action: request.action, detectedLanguage: 'en', segments: request.segments.map(segment => ({ id: segment.id, text: result })) } });
  });
  return requests;
}
async function runTranslation(page: Page) {
  await selectAiText(page);
  await expect(page.getByRole('menuitem', { name: /^Copy text/ })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: 'Highlight selection', exact: true })).toBeEnabled();
  await page.getByRole('menuitem', { name: 'AI translate', exact: true }).click();
  const panel = page.getByRole('region', { name: 'AI text tools', exact: true });
  await panel.getByRole('combobox', { name: 'Target language', exact: true }).selectOption('zh');
  await panel.getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('你好');
  await expect(panel.getByRole('textbox', { name: 'Original text on page 1' })).toHaveValue('Hello');
  await expect(panel.getByRole('button', { name: 'Review layout', exact: true })).toHaveCount(0);
  await expect(panel.locator('del')).toHaveCount(0);
  return panel;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
});

test('free translation works without sign-in; normal menu actions and PDF state are preserved', async ({ page }) => {
  const requests = await mockTools(page);
  let paid = 0;
  await page.route('**/api/v1/ai/requests', route => { paid++; return route.abort(); });
  await page.goto('/editor/'); await openAiPdf(page);
  const panel = await runTranslation(page);
  expect(requests).toHaveLength(1); expect(requests[0]?.segments[0]?.text).toBe('Hello');
  expect(requests[0]?.sourceLanguage).toBe('auto'); expect(requests[0]?.targetLanguage).toBe('zh');
  await expect(page.locator('.save-state')).toHaveText('No changes');
  await panel.getByRole('button', { name: 'Expand comparison', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: 'Bilingual comparison', exact: true });
  await expect(comparison.getByText('Hello', { exact: true })).toBeVisible();
  await expect(comparison.getByText('你好', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'tmp/browser/ai-bilingual-expanded.png' });
  await page.keyboard.press('Escape');
  await expect(comparison).toHaveCount(0); await expect(panel).toBeVisible();
  await expect(page.locator('.save-state')).toHaveText('No changes');
  await panel.getByRole('button', { name: 'Run again', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await panel.getByRole('button', { name: 'Continue in KOMO', exact: true }).click();
  await expect(page.locator('.komo-material-card')).toHaveCount(1);
  expect(paid).toBe(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEditable();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'tmp/browser/ai-free-translation-handoff.png' });
});

test('zero credits do not block translation or erase an existing KOMO draft', async ({ page }) => {
  await mockAiAccount(page, 0); await mockTools(page);
  await page.goto('/editor/'); await openAiPdf(page);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this unsent question.');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  const panel = await runTranslation(page);
  await panel.getByRole('button', { name: 'Continue in KOMO', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Keep this unsent question.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.locator('.save-state')).toHaveText('No changes');
});

test('a reviewed replacement changes only the selected range and one undo restores it', async ({ page }) => {
  const requests = await mockTools(page, 'Hi');
  await page.goto('/editor/'); await openAiPdf(page);
  await selectAiText(page);
  await page.getByRole('menuitem', { name: 'Rewrite selection', exact: true }).click();
  const panel = page.getByRole('region', { name: 'AI text tools', exact: true });
  await panel.getByRole('button', { name: 'Run tool', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('Hi');
  await expect(page.locator('.save-state')).toHaveText('No changes');
  await panel.getByRole('button', { name: 'Review layout', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Confirm and apply', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Confirm and apply', exact: true }).click();
  await expect(page.locator('.pdf-text-layer')).toHaveText('Hi from this PDF.');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(page.locator('.pdf-text-layer')).toHaveText('Hello from this PDF.');
  expect(requests).toHaveLength(1);
});

test('translation can be saved as a comment without replacing the original text', async ({ page }) => {
  await mockTools(page); await page.goto('/editor/'); await openAiPdf(page);
  const panel = await runTranslation(page);
  await panel.getByRole('button', { name: 'Save as comment', exact: true }).click();
  await expect(panel.getByText('Saved as a comment. You can undo this change.', { exact: true })).toBeVisible();
  await expect(page.locator('.pdf-text-layer')).toHaveText('Hello from this PDF.');
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true })).toBeDisabled();
});

test('editing selection keeps its draft while translating and applying remains locally undoable', async ({ page }) => {
  await mockTools(page, 'Draft result'); await page.goto('/editor/'); await openAiPdf(page);
  const before = await page.locator('.pdf-canvas').evaluate(node => (node as HTMLCanvasElement).toDataURL());
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('My unsaved draft'); await input.press('Control+A');
  await input.click({ button: 'right', position: { x: 15, y: 8 } });
  await page.getByRole('menuitem', { name: 'AI translate', exact: true }).click();
  const panel = page.getByRole('region', { name: 'AI text tools', exact: true });
  await expect(input).toHaveText('My unsaved draft');
  await panel.getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('Draft result');
  await expect(input).toHaveText('My unsaved draft');
  expect(await page.locator('.pdf-canvas').evaluate(node => (node as HTMLCanvasElement).toDataURL())).toBe(before);
  await panel.getByRole('button', { name: 'Expand comparison', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Bilingual comparison' }).getByText('My unsaved draft', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toHaveText('My unsaved draft');
  expect(await page.locator('.pdf-canvas').evaluate(node => (node as HTMLCanvasElement).toDataURL())).toBe(before);
  await panel.locator('.ai-replace-choice > summary').click();
  await panel.getByRole('button', { name: 'Apply to draft', exact: true }).click();
  await expect(input).toHaveText('Draft result');
  await input.focus(); await input.press('Control+z');
  await expect(input).toHaveText('My unsaved draft');
  expect(await page.locator('.pdf-canvas').evaluate(node => (node as HTMLCanvasElement).toDataURL())).toBe(before);
});

test('cross-page translation binds every selected block to its actual page', async ({ page }) => {
  const requests = await mockTools(page, 'Translated');
  await page.goto('/editor/'); await openAiPdf(page, 'two-pages.pdf', ['First page.', 'Second page.']);
  await expect(page.locator('.pdf-text-layer')).toHaveCount(2);
  await selectAiText(page, 12, 1);
  await page.getByRole('menuitem', { name: 'AI translate', exact: true }).click();
  const panel = page.getByRole('region', { name: 'AI text tools', exact: true });
  await panel.getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('Translated');
  await expect(panel.getByRole('textbox', { name: 'AI result on page 2' })).toHaveValue('Translated');
  expect(requests.flatMap(request => request.segments.map(segment => segment.text))).toEqual(['First page.', 'Second page.']);
});

test('KOMO sends material only on Send and keeps the conversation when locating another PDF', async ({ page }) => {
  await mockAiAccount(page); await mockTools(page);
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    const ref = request.context.referenceEvidence?.find(item => item.kind === 'source' && item.docId !== request.document.id);
    const response = { protocolVersion: 1, requestId: request.requestId, document: { id: request.document.id, baseRevision: request.document.revision }, feature: request.feature,
      result: { kind: 'answer', text: 'A comparison grounded in both PDFs.', citations: [{ evidenceId: ref?.id ?? request.context.evidence[0]?.id }] } };
    return route.fulfill({ contentType: 'text/event-stream', body: [{ type: 'accepted', requestId: request.requestId }, { type: 'result', response }, { type: 'done', requestId: request.requestId }].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') });
  });
  await page.goto('/editor/'); await openAiPdf(page, 'reference.pdf', ['Reference text.']); await openAiPdf(page, 'working.pdf');
  const panel = await runTranslation(page);
  await panel.getByRole('button', { name: 'Continue in KOMO', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await chat.getByLabel('Add reference PDF', { exact: true }).selectOption({ label: 'reference.pdf' });
  await expect(chat.locator('.komo-material-card')).toHaveCount(2);
  expect(requests).toHaveLength(0);
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('Compare these passages.');
  await chat.locator('.komo-chat-settings > summary').click(); await chat.getByRole('checkbox').check();
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('A comparison grounded in both PDFs.', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.context.referenceEvidence?.some(item => item.kind === 'generated' && item.text.includes('你好'))).toBe(true);
  const source = chat.locator('.komo-chat-citations button').filter({ hasText: 'reference.pdf' });
  await source.click();
  await expect(page.getByRole('tab', { name: 'reference.pdf', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(chat.getByText('A comparison grounded in both PDFs.', { exact: true })).toBeVisible();
});

test('all fixed text actions use the same selected passage without starting a conversation', async ({ page }) => {
  const requests = await mockTools(page, 'Tool result');
  await page.goto('/editor/'); await openAiPdf(page);
  for (const [action, label] of [['explain', 'Explain selection'], ['summarize', 'Summarize selection'], ['proofread', 'Proofread selection'], ['shorten', 'Shorten selection']] as const) {
    await selectAiText(page);
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    const panel = page.getByRole('region', { name: 'AI text tools', exact: true });
    await panel.getByRole('button', { name: 'Run tool', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('Tool result');
    expect(requests.at(-1)?.action).toBe(action); expect(requests.at(-1)?.segments[0]?.text).toBe('Hello');
    await expect(panel.getByRole('button', { name: 'Review layout', exact: true })).toHaveCount(action === 'explain' || action === 'summarize' ? 0 : 1);
  }
  expect(requests).toHaveLength(4);
  await expect(page.locator('.save-state')).toHaveText('No changes');
});

test('keyboard context menu preserves the same reading selection', async ({ page }) => {
  const requests = await mockTools(page);
  await page.goto('/editor/'); await openAiPdf(page); await selectAiText(page);
  await page.keyboard.press('Escape'); await page.locator('.pdf-text-layer').first().focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'AI translate', exact: true }).click();
  const panel = page.getByRole('region', { name: 'AI text tools', exact: true });
  await panel.getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('你好');
  expect(requests[0]?.segments[0]?.text).toBe('Hello');
});

test('narrow-screen translation keeps its controls and result inside the viewport', async ({ page }) => {
  await mockTools(page); await page.goto('/editor/'); await openAiPdf(page);
  const panel = await runTranslation(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await panel.boundingBox(); expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  const action = await panel.getByRole('button', { name: 'Continue in KOMO', exact: true }).boundingBox();
  expect(action!.y + action!.height).toBeLessThan(844);
  const result = (await panel.getByRole('textbox', { name: 'AI result on page 1' }).boundingBox())!;
  const footer = (await panel.locator('.task-panel-footer').boundingBox())!;
  expect(result.y).toBeGreaterThan(bounds!.y); expect(result.y + result.height).toBeLessThanOrEqual(footer.y);
  await expect(page.getByRole('button', { name: 'Close panel', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'tmp/browser/ai-text-tools-mobile.png' });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '在 KOMO 中继续', exact: true })).toBeVisible();
  await page.screenshot({ path: 'tmp/browser/ai-text-tools-mobile-zh.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('textbox', { name: '第 1 页的 AI 结果', exact: true })).toHaveValue('你好');
  await page.screenshot({ path: 'tmp/browser/ai-text-tools-zh.png' });
});

test('a translated Chinese passage can use an explicit embedded font and remain undoable', async ({ page }) => {
  await mockTools(page); await page.goto('/editor/'); await openAiPdf(page);
  const panel = await runTranslation(page);
  await panel.locator('.ai-replace-choice > summary').click();
  await panel.locator('.ai-layout-options > summary').click();
  const fonts = panel.getByRole('combobox', { name: 'Font', exact: true });
  const id = await fonts.locator('option').evaluateAll(options => (options.find(option => /Noto Sans (CJK )?SC/.test(option.textContent ?? '')) as HTMLOptionElement | undefined)?.value);
  expect(id).toBeTruthy(); await fonts.selectOption(id!);
  await panel.getByRole('button', { name: 'Review layout', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Confirm and apply', exact: true })).toBeEnabled({ timeout: 20000 });
  await panel.getByRole('button', { name: 'Confirm and apply', exact: true }).click();
  await expect(page.locator('.pdf-text-layer')).toHaveText('你好 from this PDF.');
  await page.getByRole('button', { name: 'Edit content', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.press('Control+End');
  await expect(page.getByRole('toolbar', { name: 'Text properties', exact: true }).getByRole('combobox', { name: 'Font', exact: true })).toHaveValue('Helvetica');
  await input.press('Escape');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.locator('.pdf-text-layer')).toHaveText('Hello from this PDF.');
});
