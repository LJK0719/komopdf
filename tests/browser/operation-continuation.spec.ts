import { test, expect } from '@playwright/test';
import { openAiPdf } from './ai-integration-helpers';
import { clickRibbonCommand } from './editor-ui-helpers';

test('failed export retains its password settings and a retry completes without re-entry', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/');
  await openAiPdf(page);
  await clickRibbonCommand(page, 'Export');
  const panel = page.getByRole('region', { name: 'Export options', exact: true });
  await panel.locator('summary').filter({ hasText: /^Password protection$/ }).click();
  await panel.getByRole('combobox', { name: 'Password protection', exact: true }).selectOption('set');
  const password = panel.getByLabel('New PDF password', { exact: true });
  const confirmation = panel.getByLabel('Confirm PDF password', { exact: true });
  await password.fill('synthetic-export-password');
  await confirmation.fill('synthetic-export-password');
  await page.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        HTMLAnchorElement.prototype.click = click;
        throw new Error('Synthetic download unavailable');
      }
      return click.call(this);
    };
  });
  await panel.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('Synthetic download unavailable');
  await expect(password).toHaveValue('synthetic-export-password');
  await expect(confirmation).toHaveValue('synthetic-export-password');
  const downloading = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export PDF', exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe('ai-test-protected.pdf');
  await expect(panel.getByText('Download started', { exact: true })).toBeVisible();
  await expect(password).toHaveValue('');
  await expect(confirmation).toHaveValue('');
  await expect(page.locator('.save-state')).toHaveText('No changes');
});
