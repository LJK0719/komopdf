import { test, expect } from '@playwright/test';
import { pdfObjects } from './ai-integration-helpers';

test('PDF outline expands by level, navigates and preserves its state when the sidebar closes', async ({ page }) => {
  const pdf = pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> >>',
    '<< /Type /Outlines /First 6 0 R /Last 6 0 R /Count 3 >>',
    '<< /Title (Part One) /Parent 5 0 R /First 7 0 R /Last 7 0 R /Count 2 >>',
    '<< /Title (Methods) /Parent 6 0 R /First 8 0 R /Last 8 0 R /Count 1 /Dest [3 0 R /Fit] >>',
    '<< /Title (Experimental setup and evaluation details) /Parent 7 0 R /Dest [4 0 R /Fit] >>',
  ]);
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'outline.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  const outline = page.getByRole('navigation', { name: 'PDF bookmarks', exact: true });
  const root = outline.getByRole('button', { name: 'Part One', exact: true });
  await expect(root).toHaveAttribute('aria-expanded', 'false');
  await root.click();
  await outline.getByRole('button', { name: 'Methods', exact: true }).click();
  const target = outline.getByRole('button', { name: 'Go to bookmark Experimental setup and evaluation details', exact: true });
  await target.click();
  await expect(page.locator('.page-chip-active')).toHaveAttribute('aria-label', 'Open page 2');
  await expect(target).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: 'tmp/browser/document-outline.png' });
  await root.click(); await expect(target).toHaveCount(0);
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await expect(root).toHaveAttribute('aria-expanded', 'false');
  await root.press('Enter'); await expect(target).toBeVisible();
  await expect(page.locator('.save-state')).toHaveText('No changes');
});
