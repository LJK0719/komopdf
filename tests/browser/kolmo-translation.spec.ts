import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { aiPdf, openAiPdf } from './ai-integration-helpers';
const { zipSync } = createRequire(new URL('../../packages/editor/package.json', import.meta.url))('fflate') as typeof import('fflate');
const KEY = 'sk-ui-only-not-a-secret';
async function fixture(page: Page, zip = false, pending = false) {
  let created = 0, cancelled = 0;
  let uploaded = Buffer.alloc(0);
  let parameters: Record<string, unknown> = {};
  const resultBytes = () => zip ? Buffer.from(zipSync({ 'translated.pdf': aiPdf(['Translated document.']), 'bilingual.pdf': aiPdf(['Bilingual document.']) })) : uploaded;
  const finished = () => ({ id: 'job_ui_translation', status: pending && !cancelled ? 'processing' : cancelled ? 'cancelled' : 'succeeded', progress: cancelled ? 10 : 100,
    result: { filename: zip ? 'translations.zip' : 'translated.pdf', kind: zip ? 'zip' : 'pdf', content_type: zip ? 'application/zip' : 'application/pdf', bytes: resultBytes().length,
      download_url: '/api/v1/jobs/job_ui_translation/download' } });
  await page.route('**/api/v1/kolmo/balance', route => {
    expect(route.request().headers()['x-kolmo-api-key']).toBe(KEY);
    return route.fulfill({ json: { configured: true, points: 100 } });
  });
  await page.route('**/api/v1/kolmo/jobs/translate-pdf', route => {
    created++; parameters = route.request().postDataJSON();
    uploaded = Buffer.from(parameters.pdfBase64 as string, 'base64');
    expect(route.request().headers()['x-kolmo-api-key']).toBe(KEY);
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    return route.fulfill({ status: 202, json: { id: 'job_ui_translation', status: 'queued', progress: 0, points_deducted: 2, remaining_points: 98 } });
  });
  await page.route('**/api/v1/kolmo/jobs/job_ui_translation', route => route.fulfill({ json: finished() }));
  await page.route('**/api/v1/kolmo/jobs/job_ui_translation/cancel', route => { cancelled++; return route.fulfill({ json: finished() }); });
  await page.route('**/api/v1/kolmo/jobs/job_ui_translation/download', route => route.fulfill({ contentType: zip ? 'application/zip' : 'application/pdf', body: resultBytes() }));
  return { created: () => created, cancelled: () => cancelled, parameters: () => parameters, uploaded: () => uploaded };
}
async function panel(page: Page) {
  await page.getByRole('button', { name: 'AI tools', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Translate entire PDF…', exact: true }).click();
  return page.getByRole('region', { name: 'Translate entire PDF', exact: true });
}
async function connect(page: Page) {
  const area = await panel(page);
  await area.getByLabel('KOLMOPDF API key', { exact: true }).fill(KEY);
  await area.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(area.getByText('KOLMOPDF connected', { exact: true })).toBeVisible();
  await area.getByRole('combobox', { name: 'Target language', exact: true }).selectOption('zh');
  return area;
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
});

test('connected translation uploads the unsaved current version and opens its returned PDF', async ({ page }) => {
  const api = await fixture(page); await page.goto('/editor/'); await openAiPdf(page);
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Page text', exact: true });
  await input.fill('Current unsaved version.');
  const area = await connect(page);
  expect(api.created()).toBe(0);
  await expect(area.getByText('Estimated KOLMOPDF cost: 2 credits (2 per page). No KOMO credits are used.', { exact: true })).toBeVisible();
  await area.getByRole('button', { name: 'Upload and translate', exact: true }).click();
  await expect(area.getByRole('button', { name: 'Get translated files', exact: true })).toBeVisible({ timeout: 20_000 });
  expect(api.created()).toBe(1);
  expect(api.uploaded().subarray(0, 4).toString()).toBe('%PDF');
  expect(api.parameters().options).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'zh', layoutModes: ['translated_only'] });
  await area.getByRole('button', { name: 'Get translated files', exact: true }).click();
  await expect(area.locator('.kolmo-result-file')).toHaveCount(1);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain(KEY);
  await page.screenshot({ path: 'tmp/browser/kolmo-translation-result.png' });
  await area.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'translated.pdf', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.pdf-text-layer')).toHaveText('Current unsaved version.');
});

test('both layouts deliver a ZIP and its PDF files; reconnect resumes without creating another paid task', async ({ page }) => {
  const api = await fixture(page, true); await page.goto('/editor/'); await openAiPdf(page);
  const area = await connect(page);
  await area.getByLabel('Bilingual side-by-side PDF', { exact: true }).check();
  await area.getByRole('button', { name: 'Upload and translate', exact: true }).click();
  await expect(area.getByRole('button', { name: 'Get translated files', exact: true })).toBeVisible({ timeout: 20_000 });
  await area.getByRole('button', { name: 'Get translated files', exact: true }).click();
  await expect(area.locator('.kolmo-result-file')).toHaveCount(3);
  await expect(area.locator('.kolmo-result-file').filter({ hasText: 'translations.zip' })).toBeVisible();
  expect(api.parameters().options).toMatchObject({ layoutModes: ['translated_only', 'side_by_side'] });
  await page.reload(); await openAiPdf(page);
  const restored = await connect(page);
  await restored.locator('.kolmo-task-list > summary').click();
  await restored.locator('.kolmo-task-list > button').first().click();
  await restored.getByRole('button', { name: 'Get translated files', exact: true }).click();
  await expect(restored.locator('.kolmo-result-file')).toHaveCount(3);
  expect(api.created()).toBe(1);
});

test('retry after completing an unsaved draft reuses the same paid submission and PDF snapshot', async ({ page }) => {
  await fixture(page);
  const attempts: { key: string | undefined; pdf: string }[] = [];
  await page.route('**/api/v1/kolmo/jobs/translate-pdf', route => {
    attempts.push({ key: route.request().headers()['idempotency-key'], pdf: route.request().postDataJSON().pdfBase64 as string });
    return attempts.length === 1
      ? route.fulfill({ status: 502, json: { error: { message: 'Connection interrupted. Retry this submission.' } } })
      : route.fulfill({ status: 202, json: { id: 'job_ui_translation', status: 'queued', progress: 0 } });
  });
  await page.goto('/editor/'); await openAiPdf(page);
  await page.getByRole('button', { name: 'Edit content', exact: true }).click();
  await page.locator('.object-hitbox[data-object-type="text"]').first().dblclick();
  await page.getByRole('textbox', { name: 'Page text', exact: true }).fill('An unsaved draft.');
  const area = await connect(page);
  await area.getByRole('button', { name: 'Upload and translate', exact: true }).click();
  await expect(area.getByRole('alert')).toBeVisible();
  await area.getByRole('button', { name: 'Upload and translate', exact: true }).click();
  await expect(area.getByRole('button', { name: 'Get translated files', exact: true })).toBeVisible({ timeout: 20000 });
  expect(attempts).toHaveLength(2); expect(attempts[0]?.key).toBeTruthy();
  expect(attempts[1]?.key).toBe(attempts[0]?.key); expect(attempts[1]?.pdf).toBe(attempts[0]?.pdf);
});

test('closing a translation panel does not cancel the task; explicit Cancel uses the remote cancel endpoint', async ({ page }) => {
  const api = await fixture(page, false, true); await page.goto('/editor/'); await openAiPdf(page);
  const area = await connect(page);
  await area.getByRole('button', { name: 'Upload and translate', exact: true }).click();
  await expect(area.getByRole('button', { name: 'Cancel translation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close AI window', exact: true }).click();
  expect(api.cancelled()).toBe(0);
  await panel(page);
  await area.getByRole('button', { name: 'Cancel translation', exact: true }).click();
  await expect(area.locator('.kolmo-job').getByText('Translation cancelled', { exact: true })).toBeVisible();
  expect(api.cancelled()).toBe(1); expect(api.created()).toBe(1);
});
