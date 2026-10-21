import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const stableRelease = JSON.parse(readFileSync(new URL('../../apps/web/public/releases/stable.json', import.meta.url), 'utf8')) as { artifacts: { name: string; url: string }[] };

// Website-only checks. Account configuration is unavailable on purpose: public
// plans and navigation must work without Clerk, a session or a payment service.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/account/config', route => route.fulfill({
    status: 503, contentType: 'application/json', body: '{}',
  }));
});

test('mobile website menu keeps download, help and account reachable with keyboard dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.locator('.site-mobile-menu');
  const toggle = menu.locator('summary');
  await toggle.click();
  for (const label of ['Download', 'Help', 'Account & pricing', 'Open editor']) {
    await expect(menu.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open');
  await expect(toggle).toBeFocused();
  await toggle.press('Enter');
  await menu.getByRole('link', { name: 'Download', exact: true }).click();
  await expect(page).toHaveURL(/\/download\/$/);
  await page.locator('.site-mobile-menu > summary').click();
  await expect(page.locator('.site-mobile-menu').getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('public pricing is readable without sign-in and preserves desktop return context on auth links', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const query = '?expectedUserId=desktop-user&desktop_callback=keep-me&checkout=success&session_id=cs_ui_test&lang=en';
  await page.goto(`/account/${query}`);
  await expect(page.getByRole('heading', { name: 'Free PDF tools. More with KOMO.' })).toBeVisible();
  const pricing = page.locator('.account-pricing');
  await expect(pricing.getByText('$0', { exact: true })).toBeVisible();
  await expect(pricing.getByText('$4.99', { exact: true })).toBeVisible();
  await expect(pricing.getByText('1,000 welcome credits', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp('/account/\\?'));
  for (const label of ['Sign in to upgrade', 'Create your account']) {
    const href = await pricing.getByRole('link', { name: label, exact: true }).getAttribute('href');
    expect(new URL(href!, page.url()).searchParams.get('returnTo')).toBe(`/account/${query}`);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '免费编辑 PDF，用 KOMO 做更多。' })).toBeVisible();
  await expect(pricing.getByRole('link', { name: '登录并升级', exact: true })).toBeVisible();
});

test('homepage opens the editor rather than pretending to upload a PDF', async ({ page }) => {
  await page.goto('/');
  const primary = page.locator('.hero-actions').getByRole('link', { name: 'Open editor', exact: true });
  await expect(primary).toHaveAttribute('href', '/editor/');
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'PDF workspace preview with document tabs, page navigation and editing tools' })).toBeVisible();
  await expect(page.locator('.preview-tab')).toHaveCount(2);
});

test('downloads use released artifacts and explain manual web-to-desktop handoff', async ({ page }) => {
  await page.goto('/download/');
  const downloads = page.locator('.download-grid a[download]');
  await expect(downloads).toHaveCount(stableRelease.artifacts.length);
  for (const artifact of stableRelease.artifacts) {
    await expect(page.locator(`.download-grid a[download="${artifact.name}"]`)).toHaveAttribute('href', artifact.url);
  }
  await expect(page.getByRole('button', { name: 'Coming soon' })).toHaveCount(0);
  await expect(page.getByText('Download a copy of your PDF in the web editor, then open that file in the desktop app. Open documents do not transfer automatically.')).toBeVisible();
});

test('invalid billing handoff offers public plans without opening checkout', async ({ page }) => {
  const paymentRequests: string[] = [];
  await page.route('https://**.stripe.com/**', route => { paymentRequests.push(route.request().url()); return route.abort(); });
  await page.goto('/billing/#invalid');
  await expect(page.getByRole('alert').filter({ hasText: 'Return to the app and open billing again.' })).toHaveText('Return to the app and open billing again.');
  await expect(page.getByRole('link', { name: 'View plans', exact: true })).toHaveAttribute('href', '/account/');
  await expect(page.getByRole('navigation', { name: 'Main navigation', exact: true })).toBeVisible();
  expect(paymentRequests).toEqual([]);
});
