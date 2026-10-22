import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { aiPdf, mockAiAccount, openAiPdf, selectAiText } from './ai-integration-helpers';
import { clickRibbonCommand } from './editor-ui-helpers';

const longNote = '这是一条需要完整阅读的批注。\n第二行说明与译文。\n' + '详细说明，不能只显示小框或截断三行。\n'.repeat(16) + '批注结尾 END';
async function mockTranslation(page: Page) {
  const requests: { targetLanguage: string }[] = [];
  await page.route('**/api/v1/ai/text-actions', route => {
    const request = route.request().postDataJSON(); requests.push(request);
    return route.fulfill({ json: { requestId: request.requestId, action: request.action, detectedLanguage: 'en',
      segments: request.segments.map((segment: { id: string }) => ({ id: segment.id, text: request.targetLanguage === 'ja' ? '日本語の訳文' : longNote })) } });
  });
  return requests;
}
async function translate(page: Page) {
  await selectAiText(page); await page.getByRole('menuitem', { name: 'AI translate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Translate selected text', exact: true });
  await dialog.getByRole('combobox').selectOption('zh');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  const result = page.getByRole('dialog', { name: 'Translation', exact: true });
  await expect(result.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue(longNote);
  return result;
}
async function note(page: Page, text: string, index = 0) {
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await page.locator('.annotation-drawing-surface').nth(index).click({ position: { x: 100, y: 140 } });
  const form = page.getByRole('form', { name: 'New note', exact: true });
  await form.getByRole('textbox').fill(text);
  await form.getByRole('button', { name: 'Add note', exact: true }).click();
  const card = page.getByRole('dialog', { name: 'Comment', exact: true });
  await expect(card.locator('.comment-body')).toHaveText(text);
  return card;
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
});

test('translation shows only the result; its target selector remains usable and is remembered after reload for the signed-in account', async ({ page }) => {
  await mockAiAccount(page); const requests = await mockTranslation(page);
  await page.goto('/editor/'); await openAiPdf(page);
  const result = await translate(page);
  await expect(result.getByRole('textbox', { name: 'Original text on page 1' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Bilingual comparison' })).toHaveCount(0);
  await page.screenshot({ path: 'tmp/browser/translation-only-result.png' });
  const language = result.getByRole('combobox', { name: 'Target language', exact: true });
  await language.selectOption('ja'); expect(requests).toHaveLength(1);
  await result.getByRole('button', { name: 'Translate again', exact: true }).click();
  await expect(result.getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('日本語の訳文');
  expect(requests).toHaveLength(2); expect(requests[1]?.targetLanguage).toBe('ja');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('komopdf.ai.preferences.v1:user:user_ai_integration') ?? '{}').targetLanguage)).toBe('ja');
  await result.getByRole('button', { name: 'View original', exact: true }).click();
  await expect(result.getByRole('textbox', { name: 'Original text on page 1' })).toHaveValue('Hello');
  await page.screenshot({ path: 'tmp/browser/translation-result-language.png' });
  await page.reload(); await openAiPdf(page);
  await selectAiText(page); await page.getByRole('menuitem', { name: 'AI translate', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Translate selected text', exact: true }).getByRole('combobox')).toHaveValue('ja');
  expect(requests).toHaveLength(2);
});

test('late account initialization does not overwrite a target language the user already selected', async ({ page }) => {
  await mockAiAccount(page); const requests = await mockTranslation(page);
  await page.addInitScript(() => localStorage.setItem('komopdf.ai.preferences.v1:user:user_ai_integration', JSON.stringify({ targetLanguage: 'fr' })));
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/account/config', async route => {
    await ready;
    await route.fulfill({ json: { publishableKey: `pk_test_${Buffer.from('ui-test.clerk.accounts.dev$').toString('base64')}` } });
  });
  await page.goto('/editor/'); await openAiPdf(page);
  await selectAiText(page); await page.getByRole('menuitem', { name: 'AI translate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Translate selected text', exact: true });
  await dialog.getByRole('combobox').selectOption('ja');
  release();
  await expect(page.locator('.komo-account-strip')).toContainText('credits left');
  await expect(dialog.getByRole('combobox')).toHaveValue('ja');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Translation', exact: true }).getByRole('textbox', { name: 'AI result on page 1' })).toHaveValue('日本語の訳文');
  expect(requests).toHaveLength(1); expect(requests[0]?.targetLanguage).toBe('ja');
});

test('AI comment opens immediately, can be reopened from its marker, edited, cancelled, deleted and undone', async ({ page }) => {
  await mockTranslation(page); await page.goto('/editor/'); await openAiPdf(page);
  const result = await translate(page);
  await result.getByRole('button', { name: 'Save as comment', exact: true }).click();
  const card = page.getByRole('dialog', { name: 'Comment', exact: true });
  await expect(card.locator('.comment-body')).toContainText(longNote);
  await expect(result).toBeHidden(); await expect(page.locator('.pdf-text-layer')).toHaveText('Hello from this PDF.');
  await page.screenshot({ path: 'tmp/browser/comment-long-open.png' });
  await card.getByRole('button', { name: 'Close comment', exact: true }).click();
  await page.getByRole('button', { name: 'Open comment 1 on page 1', exact: true }).click();
  await expect(card.locator('.comment-body')).toContainText('批注结尾 END');
  await card.getByRole('button', { name: 'Edit comment', exact: true }).click();
  await card.getByRole('textbox', { name: 'Comment text', exact: true }).fill('Updated comment 正文');
  await card.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(card.locator('.comment-body')).toHaveText('Updated comment 正文');
  await card.getByRole('button', { name: 'Edit comment', exact: true }).click();
  await card.getByRole('textbox').fill('Do not keep this draft');
  await card.getByRole('button', { name: 'Close comment', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Save comment changes?', exact: true });
  await expect(confirm).toBeVisible(); await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card.getByRole('textbox')).toHaveValue('Do not keep this draft');
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card.locator('.comment-body')).toHaveText('Updated comment 正文');
  await card.getByRole('button', { name: 'Delete comment', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete comment?', exact: true }).getByRole('button', { name: 'Delete comment', exact: true }).click();
  await expect(page.locator('.annotation-marker')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)', exact: true }).click();
  await page.getByRole('button', { name: 'Open comment 1 on page 1', exact: true }).click();
  await expect(card.locator('.comment-body')).toHaveText('Updated comment 正文');
});

test('a manual note is immediately readable, list navigation opens its card, and save/reopen preserves the full text', async ({ page }) => {
  await page.goto('/editor/'); await openAiPdf(page);
  const card = await note(page, longNote);
  await card.getByRole('button', { name: 'Close comment', exact: true }).click();
  await clickRibbonCommand(page, 'Comment');
  await page.locator('.annotation-list-item').first().click();
  await expect(card.locator('.comment-body')).toHaveText(longNote);
  await page.screenshot({ path: 'tmp/browser/comment-list-linked.png' });
  await card.getByRole('button', { name: 'Edit comment', exact: true }).click();
  await card.getByRole('textbox').fill('Saved with the document\n完整批注正文');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  await expect(card.locator('.comment-body')).toHaveText('Saved with the document\n完整批注正文');
  await card.getByRole('button', { name: 'Close comment', exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Open another PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'reopened-comments.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByRole('tab', { name: 'reopened-comments.pdf', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Open comment 1 on page 1', exact: true }).click();
  await expect(card.locator('.comment-body')).toHaveText('Saved with the document\n完整批注正文');
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = (await card.boundingBox())!; expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'tmp/browser/comment-mobile.png' });
});

test('advanced controls follow marker selection instead of overwriting a different comment', async ({ page }) => {
  await page.goto('/editor/'); await openAiPdf(page);
  const card = await note(page, 'First comment');
  await card.getByRole('button', { name: 'Close comment', exact: true }).click();
  await note(page, 'Second comment');
  await card.getByRole('button', { name: 'Close comment', exact: true }).click();
  await page.locator('.annotation-list-item').first().click();
  await expect(card.locator('.comment-body')).toHaveText('First comment');
  await card.getByRole('button', { name: 'Close comment', exact: true }).click();
  await page.getByRole('button', { name: 'Open comment 2 on page 1', exact: true }).click();
  await expect(card.locator('.comment-body')).toHaveText('Second comment');
  await page.locator('summary').filter({ hasText: 'Advanced annotation controls' }).click();
  await expect(page.getByRole('textbox', { name: 'Annotation text', exact: true })).toHaveValue('Second comment');
  await page.getByRole('button', { name: 'Update selected annotation', exact: true }).click();
  await expect(card.locator('.comment-body')).toHaveText('Second comment');
});

test('comments on different visible pages keep distinct page identities', async ({ page }) => {
  await page.goto('/editor/'); await openAiPdf(page, 'two.pdf', ['First page.', 'Second page.']);
  let card = await note(page, 'Page one comment', 0);
  await card.getByRole('button', { name: 'Close comment', exact: true }).click();
  card = await note(page, 'Page two comment', 1);
  await expect(card).toContainText('Page 2');
  await card.getByRole('button', { name: 'Close comment', exact: true }).click();
  await page.getByRole('button', { name: 'Open comment 1 on page 1', exact: true }).click();
  await expect(card.locator('.comment-body')).toHaveText('Page one comment');
  await card.getByRole('button', { name: 'Close comment', exact: true }).click();
  await page.getByRole('button', { name: 'Open comment 1 on page 2', exact: true }).click();
  await expect(card.locator('.comment-body')).toHaveText('Page two comment');
});
