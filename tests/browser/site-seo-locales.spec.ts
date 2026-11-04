import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { UI_LOCALES, localizedPath } from '../../packages/editor/src/ui/locales';
import { aiPdf, openAiPdf } from './ai-integration-helpers';
import { clickRibbonCommand } from './editor-ui-helpers';
import { messages as zhMessages } from '../../packages/editor/src/ui/messages';

const origin = 'https://komopdf.com';
const publicPaths = ['/', '/download/', '/help/', '/privacy/', '/pricing/', '/tools/', '/tools/edit-pdf-text/', '/tools/delete-pdf-pages/', '/tools/pdf-to-image/'];
const canonical = (path: string, locale: typeof UI_LOCALES[number]['id']) => origin + localizedPath(path, locale);

function tinyPdf(): Buffer {
  const stream = 'BT /F1 18 Tf 30 240 Td (Website tool test) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('all completed locales ship localized server HTML and reciprocal intent-specific SEO', async ({ request }) => {
  for (const locale of UI_LOCALES) {
    for (const path of publicPaths) {
      const response = await request.get(localizedPath(path, locale.id));
      expect(response.status(), `${locale.id} ${path}`).toBe(200);
      const html = await response.text();
      expect(html).toContain(`<html lang="${locale.id}"`);
      expect(html).toContain(`rel="canonical" href="${canonical(path, locale.id)}"`);
      expect(html).toContain(`property="og:url" content="${canonical(path, locale.id)}"`);
      for (const other of UI_LOCALES) expect(html).toContain(`hrefLang="${other.id}" href="${canonical(path, other.id)}"`);
      expect(html).toContain(`hrefLang="x-default" href="${canonical(path, 'en')}"`);
      expect(html).not.toContain('content="noindex');
      if (locale.id !== 'en' && path === '/help/') expect(html).not.toContain('<h1>Get started with your PDF.</h1>');
      if (locale.id !== 'en' && path === '/tools/edit-pdf-text/') expect(html).not.toContain('<h1>Edit PDF text online</h1>');
    }
    const alias = await request.get(localizedPath('/editor/', locale.id));
    expect(await alias.text()).toContain(`rel="canonical" href="${canonical('/', locale.id)}"`);
    for (const path of ['/account/', '/billing/', '/sign-in/', '/sign-up/']) {
      const response = await request.get(localizedPath(path, locale.id));
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain('content="noindex, follow"');
    }
  }
});

test('annotation exists only for researched locales and never substitutes another intent', async ({ request }) => {
  for (const locale of UI_LOCALES) {
    const response = await request.get(localizedPath('/tools/annotate-pdf/', locale.id));
    const available = ['en', 'de', 'fr'].includes(locale.id);
    expect(response.status()).toBe(available ? 200 : 404);
    if (!available) continue;
    const html = await response.text();
    for (const id of ['en', 'de', 'fr'] as const) expect(html).toContain(`hrefLang="${id}" href="${canonical('/tools/annotate-pdf/', id)}"`);
    expect(html).not.toContain('hrefLang="ja"');
    expect(html).not.toContain('FAQPage');
  }
  for (const path of ['/ar/', '/en/', '/ja/not-a-page/', '/not-a-locale/help/', '/tools/not-a-tool/', '/editor/not-a-page/']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});

test('sitemap contains only finished canonical pages and real publication dates', async ({ request }) => {
  const response = await request.get('/sitemap.xml');
  const xml = await response.text();
  expect(response.status()).toBe(200);
  expect(xml.match(/<url>/g)).toHaveLength(102);
  expect(xml).toContain('<lastmod>2026-11-03</lastmod>');
  expect(xml).not.toMatch(/<loc>[^<]*(?:account|billing|sign-in|sign-up|editor)\//);
  expect(xml).toContain('hreflang="x-default"');
  expect(await (await request.get('/robots.txt')).text()).toContain('Sitemap: https://komopdf.com/sitemap.xml');
});

test('URL locale wins over saved language and language links preserve the page and context', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'ru'));
  await page.goto('/ja/help/?context=keep#guide');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('h1')).not.toHaveText('Get started with your PDF.');
  const languages = page.locator('.site-language-menu');
  await expect(languages.locator('a')).toHaveCount(11);
  await expect(languages.locator('a[hreflang="de"]')).toHaveAttribute('href', '/de/help/');
  await page.getByRole('combobox').selectOption('fr');
  await expect(page).toHaveURL(/\/fr\/help\/\?context=keep#guide$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('h1')).not.toHaveText('Get started with your PDF.');
});

test('localized client navigation keeps current-build route payloads available', async ({ page }) => {
  const payloads: { url: string; status: number }[] = [];
  page.on('response', response => { if (/\.txt(?:\?|$)/.test(response.url())) payloads.push({ url: response.url(), status: response.status() }); });
  await page.goto('/de/help/');
  await page.locator('.site-footer a[href="/de/download/"]').click();
  await expect(page).toHaveURL(/\/de\/download\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.waitForLoadState('networkidle');
  expect(payloads.length).toBeGreaterThan(0);
  expect(payloads.filter(payload => payload.status >= 400)).toEqual([]);
});

test('public pricing and tool guides do not start PDF or account services', async ({ page }) => {
  const unwanted: string[] = [];
  page.on('request', request => { if (/\/api\/account\/|\/engines\/|\.wasm(?:\?|$)|clerk\.accounts/.test(request.url())) unwanted.push(request.url()); });
  for (const path of ['/pricing/', '/de/tools/edit-pdf-text/', '/zh-tw/download/', '/ru/privacy/']) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    await page.waitForLoadState('networkidle');
  }
  expect(unwanted).toEqual([]);
});

test('public HTML and route payloads omit unused editor dictionaries', async ({ request }) => {
  for (const path of ['/de/pricing/', '/ja/download/', '/fr/tools/edit-pdf-text/']) {
    for (const suffix of ['', 'index.txt']) {
      const response = await request.get(path + suffix);
      expect(response.status()).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('The original PDF is unavailable. Your conversation and attachments are kept here.');
      expect(body).not.toContain('The saved agent session is unavailable. Task history and generated files are retained. Start a new conversation to continue.');
    }
  }
});

for (const path of ['/sign-in/', '/account/']) test(`explicit English on ${path} overrides old lang without losing return context`, async ({ page }) => {
  await page.route('**/api/account/config', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto(`${path}?lang=ja&state=keep&desktop_callback=komopdf%3A%2F%2Freturn&returnTo=%2Faccount%2F%3Fprofile%3D1#callback`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.locator('.site-language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.site-language-select')).toHaveValue('en');
  const url = new URL(page.url());
  expect(url.pathname).toBe(path);
  expect(url.searchParams.has('lang')).toBe(false);
  expect(url.searchParams.get('state')).toBe('keep');
  expect(url.searchParams.get('desktop_callback')).toBe('komopdf://return');
  expect(url.searchParams.get('returnTo')).toBe('/account/?profile=1');
  expect(url.hash).toBe('#callback');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('an edited PDF survives all eleven language switches and downloads in every language', async ({ page }) => {
  await page.route('**/api/account/config', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto('/');
  await openAiPdf(page, 'language-persistence.pdf', ['Keep this page.', 'Delete this page.']);
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'Pages', exact: true }).click();
  await expect(page.locator('.organizer-page')).toHaveCount(2);
  await page.locator('.organizer-page').nth(1).click();
  await clickRibbonCommand(page, 'Delete selected pages');
  await expect(page.locator('.organizer-page')).toHaveCount(1);
  await page.getByRole('button', { name: 'Back to document', exact: true }).click();
  await expect(page.locator('.page-chip')).toHaveCount(1);
  await expect(page.locator('.save-state')).toHaveText('Unsaved changes');

  const shell = await page.locator('.editor-shell').elementHandle();
  expect(shell).not.toBeNull();
  const workers = page.workers();
  let documentNavigations = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentNavigations++; });
  let previous = (source: string) => source;
  for (const locale of UI_LOCALES) {
    const messages: Record<string, string> = locale.id === 'en' ? {} : {
      ...(locale.id === 'zh-CN' ? zhMessages : JSON.parse(await readFile(new URL(`../../packages/editor/src/ui/locales/${locale.id}.json`, import.meta.url), 'utf8'))),
      ...JSON.parse(await readFile(new URL(`../../packages/editor/src/ui/site-locales/${locale.id}.json`, import.meta.url), 'utf8')),
    } as Record<string, string>;
    const t = (source: string) => messages[source] ?? source;
    await page.getByRole('combobox', { name: previous('Language'), exact: true }).selectOption(locale.id);
    await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
    await expect(page.getByRole('combobox', { name: t('Language'), exact: true })).toHaveValue(locale.id);
    expect(new URL(page.url()).pathname).toBe(localizedPath('/', locale.id));
    expect(await page.locator('.editor-topbar').evaluate(element => element.scrollWidth <= element.clientWidth), locale.id).toBe(true);
    expect(await shell!.evaluate(element => element.isConnected)).toBe(true);
    expect(page.workers()).toEqual(workers);
    expect(documentNavigations).toBe(0);
    await expect(page.getByRole('tab', { name: /^language-persistence\.pdf/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.page-chip')).toHaveCount(1);
    await expect(page.locator('.pdf-text-layer')).toHaveText('Keep this page.');
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: t('Download PDF'), exact: true }).click();
    const download = await downloading;
    expect(await download.failure(), locale.id).toBeNull();
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 5).toString(), locale.id).toBe('%PDF-');
    expect(bytes.length, locale.id).toBeGreaterThan(100);
    previous = t;
  }
});

for (const task of [
  { slug: 'edit-pdf-text', cta: 'Open a PDF to edit text', tab: 'Edit' },
  { slug: 'delete-pdf-pages', cta: 'Open a PDF to organize pages', tab: 'Pages' },
  { slug: 'annotate-pdf', cta: 'Open a PDF to annotate', tab: 'Comment' },
  { slug: 'pdf-to-image', cta: 'Open a PDF to export images', tab: null },
]) test(`tool ${task.slug} opens the real local editor for that task`, async ({ page }) => {
  await page.route('**/api/account/config', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto(`/tools/${task.slug}/`);
  await page.getByRole('button', { name: task.cta, exact: true }).click();
  const workspace = page.locator('.tool-workspace');
  await expect(workspace.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await workspace.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'website-tool.pdf', mimeType: 'application/pdf', buffer: tinyPdf() });
  await expect(workspace.getByRole('tab', { name: /website-tool\.pdf/ })).toBeVisible({ timeout: 60_000 });
  if (task.tab) await expect(workspace.locator('.ribbon-tabs').getByRole('button', { name: task.tab, exact: true })).toHaveAttribute('aria-current', 'page');
  else {
    const panel = workspace.getByRole('region', { name: 'Export options' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('combobox').first()).toHaveValue('jpeg');
  }
  await expect(page).toHaveURL(new RegExp(`/tools/${task.slug}/$`));
});

test('tool edit mode protects undownloaded edits when returning to the guide', async ({ page }) => {
  await page.route('**/api/account/config', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto('/tools/delete-pdf-pages/');
  await page.getByRole('button', { name: 'Open a PDF to organize pages', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'protected-tool.pdf', mimeType: 'application/pdf', buffer: aiPdf(['Keep this page.', 'Delete this page.']) });
  await expect(page.locator('.organizer-page')).toHaveCount(2, { timeout: 60_000 });
  await page.locator('.organizer-page').nth(1).click();
  await clickRibbonCommand(page, 'Delete selected pages');
  await expect(page.locator('.organizer-page')).toHaveCount(1);
  const shell = await page.locator('.editor-shell').elementHandle();
  const workers = page.workers();
  for (const selector of ['.site-nav', '.tool-breadcrumb', '.tool-guide', '.site-footer']) await expect(page.locator(selector)).toBeHidden();
  let cancelled = false;
  page.once('dialog', async dialog => { expect(dialog.type()).toBe('beforeunload'); cancelled = true; await dialog.dismiss(); });
  await page.getByRole('link', { name: 'Back to the guide', exact: true }).click();
  await expect.poll(() => cancelled).toBe(true);
  expect(await shell!.evaluate(element => element.isConnected)).toBe(true);
  expect(page.workers()).toEqual(workers);
  await expect(page.locator('.organizer-page')).toHaveCount(1);
  let confirmed = false;
  page.once('dialog', async dialog => { expect(dialog.type()).toBe('beforeunload'); confirmed = true; await dialog.accept(); });
  await page.getByRole('link', { name: 'Back to the guide', exact: true }).click();
  await expect.poll(() => confirmed).toBe(true);
  await expect(page.locator('.site-nav')).toBeVisible();
  await expect(page.locator('.editor-shell')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open a PDF to organize pages', exact: true })).toBeVisible();
});

test('annotation workspace top and editor language controls preserve drafts without relabeling its guide', async ({ page }) => {
  await page.route('**/api/account/config', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto('/tools/annotate-pdf/');
  const heading = await page.locator('h1').textContent();
  await page.getByRole('button', { name: 'Open a PDF to annotate', exact: true }).click();
  await openAiPdf(page, 'workspace-language.pdf');
  await page.getByRole('navigation', { name: 'PDF tools' }).getByRole('button', { name: 'Edit', exact: true }).click();
  const zoom = page.locator('.view-controls input[list]');
  await zoom.fill('135%'); await zoom.press('Enter');
  const hitbox = page.locator('.object-hitbox[data-object-type="text"]').first();
  await hitbox.dblclick();
  const draft = page.getByRole('textbox', { name: 'Page text', exact: true });
  await draft.fill('Keep my unfinished draft');
  const draftNode = await draft.elementHandle();
  const shell = await page.locator('.editor-shell').elementHandle();
  const workers = page.workers();
  let navigations = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  const topLanguage = page.locator('.editor-topbar .language-select select');
  await expect(page.locator('.tool-workspace .language-select')).toHaveCount(1);
  await expect(topLanguage.locator('option')).toHaveCount(11);
  await topLanguage.selectOption('ja');
  await expect(topLanguage).toHaveValue('ja');
  await expect(page.locator('.tool-workspace-content')).toHaveAttribute('lang', 'ja');
  await topLanguage.selectOption('fr');
  await expect(topLanguage).toHaveValue('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveURL(/\/tools\/annotate-pdf\/$/);
  await expect(page.locator('h1')).toHaveText(heading!);
  await expect(page.locator('.site-language-select option')).toHaveCount(3);
  await expect(page.locator('.site-language-select')).toHaveValue('en');
  expect(await shell!.evaluate(element => element.isConnected)).toBe(true);
  expect(await draftNode!.evaluate(element => element.isConnected)).toBe(true);
  expect(await draftNode!.evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.textContent)).toBe('Keep my unfinished draft');
  await expect(zoom).toHaveValue('135%');
  const logoBounds = await page.locator('.brand-lockup').boundingBox();
  const fileBounds = await page.locator('.file-menu-trigger').boundingBox();
  expect(logoBounds!.x + logoBounds!.width).toBeLessThanOrEqual(fileBounds!.x);
  expect(page.workers()).toEqual(workers);
  expect(navigations).toBe(0);
  await page.screenshot({ path: 'tmp/browser/tool-workspace-language.png' });
});
