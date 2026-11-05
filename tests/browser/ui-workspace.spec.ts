import { setEditorLanguage } from './editor-ui-helpers';
import { test, expect } from '@playwright/test';

test('the first homepage click from downloads performs an immediate document navigation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/download/');
  const home = page.locator('.site-nav-links').getByRole('link', { name: 'Home page', exact: true });
  const navigation = page.waitForRequest(request => request.isNavigationRequest() && new URL(request.url()).pathname === '/');
  await home.hover(); await home.click(); await navigation;
  await expect(page.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible(); await expect(page).toHaveURL(/\/$/);
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Open PDF', exact: true }).click(); await (await chooser).setFiles([]);
  expect(errors).toEqual([]); expect((await page.request.get('/editor/__next.missing.__PAGE__.txt')).status()).toBe(404);
});

test('language preference is shared across the website and editor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/download/');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(page).toHaveURL(/\/zh-cn\/download\/$/); await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.locator('.download-grid').getByRole('link', { name: '打开编辑器', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开 PDF', exact: true })).toBeVisible(); await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await setEditorLanguage(page, 'en'); await expect(page.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible();
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByText('Execution Boundary', { exact: true })).toHaveCount(0);
});

test('file menus support keyboard navigation and the compact toolbar stays reachable', async ({ page }) => {
  await page.goto('/editor/'); const file = page.getByRole('button', { name: 'File', exact: true }); await file.click();
  await expect(page.getByRole('menuitem', { name: /Open/ })).toBeVisible(); await page.keyboard.press('Escape'); await expect(file).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible();
  await file.click(); await expect(page.getByRole('combobox', { name: 'Language' })).toBeVisible(); await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
