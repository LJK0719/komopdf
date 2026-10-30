import { test, expect } from '@playwright/test';
import { openAiPdf, selectAiText } from './ai-integration-helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/');
});

test('reading selection edit survives menu focus and enters the selected text', async ({ page }) => {
  await openAiPdf(page);
  await selectAiText(page, 5);
  await expect(page.getByRole('menuitem', { name: 'Add text here', exact: true })).toHaveCount(0);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.getByRole('menuitem', { name: 'Edit selected text', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page text', exact: true })).toHaveText('Hello from this PDF.');
});

test('reading AI menu retains its captured selection after browser focus changes', async ({ page }) => {
  await openAiPdf(page);
  await selectAiText(page, 5);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.getByRole('menuitem', { name: 'AI translate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Translate selected text', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox')).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.save-state')).toHaveText('No changes');
});

test('hand mode shows view actions rather than selected-text commands', async ({ page }) => {
  await openAiPdf(page);
  await page.getByRole('button', { name: 'Hand', exact: true }).click();
  await page.getByLabel('Page view options', { exact: true }).click({ button: 'right', position: { x: 60, y: 90 } });
  await expect(page.getByRole('menuitem', { name: 'Fit width', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Highlight selection', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'AI translate', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Select text', exact: true }).click();
  await expect(page.locator('.pdf-text-layer')).toBeVisible();
});

for (const action of ['Highlight', 'Underline']) {
  test(`Home selection ${action} stays actionable after menu focus clears the browser selection`, async ({ page }) => {
    const calls: unknown[] = [];
    await page.addInitScript(() => {
      const original = Worker.prototype.postMessage;
      (window as unknown as { markupCalls: unknown[] }).markupCalls = [];
      Worker.prototype.postMessage = function(message: unknown, ...args: unknown[]) {
        if ((message as { method?: string })?.method === 'apply') (window as unknown as { markupCalls: unknown[] }).markupCalls.push(message);
        return Reflect.apply(original, this, [message, ...args]);
      };
    });
    await page.reload();
    await openAiPdf(page);
    await selectAiText(page, 5);
    const command = page.getByRole('menuitem', { name: action === 'Highlight' ? 'Highlight selection' : 'Underline text', exact: true });
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await expect(command).toBeEnabled();
    await command.click();
    await expect(page.locator('.save-state')).toHaveText('Unsaved changes');
    calls.push(...await page.evaluate(() => (window as unknown as { markupCalls: unknown[] }).markupCalls));
    expect(calls.length).toBeGreaterThan(0);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
    const file = await download;
    const filePath = await file.path();
    expect(filePath).not.toBeNull();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open another PDF', exact: true }).click();
    await (await chooser).setFiles(filePath!);
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.locator('.pdf-character').first()).toBeVisible();
    await page.screenshot({ path: `tmp/browser/selection-${action.toLowerCase()}.png` });
  });
}
