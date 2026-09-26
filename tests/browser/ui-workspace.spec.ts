import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('the first homepage entry works after route prefetch without reloading', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const prefetched = page.waitForResponse(response => response.url().includes('/editor/__next.editor.__PAGE__.txt'));
  await page.goto('/');
  const open = page.getByRole('link', { name: 'Open a PDF', exact: true });
  await open.hover();
  const response = await prefetched;
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe(await readFile('apps/web/dist/editor/__next.editor/__PAGE__.txt', 'utf8'));
  await page.waitForLoadState('networkidle');
  await open.click();
  await expect(page.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible();
  await expect(page.getByText(/This page couldn.t load/)).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles([]);
  expect(errors).toEqual([]);
  expect((await page.request.get('/editor/__next.missing.__PAGE__.txt')).status()).toBe(404);
});

// Tests only local UI behavior; PDF/AI actions are covered by the existing engine flows.
test('language preference is shared across the website and editor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('少一点繁琐');
  await page.screenshot({ path: 'tmp/browser/ui-home-zh.png', fullPage: true });
  await page.getByRole('link', { name: '打开编辑器', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开 PDF', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.screenshot({ path: 'tmp/browser/ui-editor-zh.png' });
  await page.getByRole('combobox', { name: '语言' }).selectOption('en');
  await expect(page.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
  await expect(page.getByText('Execution Boundary', { exact: true })).toHaveCount(0);
});

test('file menu supports keyboard navigation and the compact toolbar remains reachable', async ({ page }) => {
  await page.goto('/editor/');
  const file = page.getByRole('button', { name: 'File', exact: true });
  await file.click();
  await expect(page.getByRole('menuitem', { name: /Open/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(file).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Language' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'tmp/browser/ui-editor-mobile.png' });
});
