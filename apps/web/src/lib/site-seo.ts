import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { UI_LOCALES, localizedPath, type UiLocale } from '@pdf-editor/editor/i18n-locales';
import { loadPublicUiMessages, createUiTranslator } from '@pdf-editor/editor/i18n-resources';
import { getTool, toolsForLocale, TOOL_SHARED_COPY } from './tool-content';
import { PAGE_COPY } from './site-copy';

export const SITE_ORIGIN = 'https://komopdf.com';
export const CONTENT_MODIFIED = '2026-11-03';
const OPEN_GRAPH_LOCALES: Record<UiLocale, string> = { en: 'en_US', 'zh-CN': 'zh_CN', 'zh-TW': 'zh_TW', ja: 'ja_JP', ko: 'ko_KR', de: 'de_DE', fr: 'fr_FR', es: 'es_ES', 'pt-BR': 'pt_BR', it: 'it_IT', ru: 'ru_RU' };
export const PUBLIC_PATHS = ['/', '/download/', '/help/', '/privacy/', '/pricing/', '/tools/'] as const;
export { PAGE_COPY } from './site-copy';

export const getSiteI18n = cache(async (locale: UiLocale) => {
  const messages = await loadPublicUiMessages(locale);
  return { messages, t: createUiTranslator(locale, messages) };
});

export function routeLocale(value: string): UiLocale {
  const match = UI_LOCALES.find(locale => locale.id !== 'en' && locale.path === value);
  if (!match) notFound();
  return match.id;
}
export function publicPaths(locale: UiLocale): string[] {
  return [...PUBLIC_PATHS, ...toolsForLocale(locale).map(tool => `/tools/${tool.slug}/`)];
}
export function localesForPath(path: string) {
  const tool = /^\/tools\/([^/]+)\/$/.exec(path)?.[1];
  return UI_LOCALES.filter(locale => !tool || getTool(tool, locale.id));
}
export function absoluteUrl(path: string, locale: UiLocale): string {
  return new URL(localizedPath(path, locale), SITE_ORIGIN).href;
}
export function languageAlternates(path: string) {
  return Object.fromEntries([
    ...localesForPath(path).map(locale => [locale.id, absoluteUrl(path, locale.id)]),
    ['x-default', absoluteUrl(path, 'en')],
  ]);
}
export async function pageMetadata(locale: UiLocale, path: string, options?: { noindex?: boolean; canonicalPath?: string }): Promise<Metadata> {
  const { t } = await getSiteI18n(locale);
  const canonicalPath = options?.canonicalPath ?? path;
  const tool = /^\/tools\/([^/]+)\/$/.exec(canonicalPath)?.[1];
  const copy = tool ? getTool(tool, locale) : PAGE_COPY[canonicalPath as keyof typeof PAGE_COPY];
  const title = `${t(copy?.title ?? 'Your komopdf account')} · komopdf`;
  const description = t(copy?.description ?? 'Use KOMO and manage your plan across web and desktop.');
  const url = absoluteUrl(canonicalPath, locale);
  return {
    metadataBase: new URL(SITE_ORIGIN), title, description,
    alternates: { canonical: url, ...(options?.noindex ? {} : { languages: languageAlternates(canonicalPath) }) },
    openGraph: { type: 'website', title, description, url, siteName: 'komopdf', locale: OPEN_GRAPH_LOCALES[locale],
      alternateLocale: localesForPath(canonicalPath).filter(item => item.id !== locale).map(item => OPEN_GRAPH_LOCALES[item.id]) },
    twitter: { card: 'summary', title, description },
    ...(options?.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

export async function structuredData(locale: UiLocale, path: string) {
  const { t } = await getSiteI18n(locale);
  const url = absoluteUrl(path, locale);
  const home = absoluteUrl('/', locale);
  const graph: Record<string, unknown>[] = [
    { '@type': 'Organization', '@id': `${SITE_ORIGIN}/#organization`, name: 'komopdf', url: SITE_ORIGIN },
    { '@type': 'WebSite', '@id': `${SITE_ORIGIN}/#website`, name: 'komopdf', url: SITE_ORIGIN, inLanguage: UI_LOCALES.map(item => item.id), publisher: { '@id': `${SITE_ORIGIN}/#organization` } },
  ];
  if (path === '/' || path.startsWith('/tools/')) graph.push({
    '@type': 'SoftwareApplication', '@id': `${home}#application`, name: 'komopdf', applicationCategory: 'ProductivityApplication',
    operatingSystem: 'Web browser', url: home, inLanguage: locale,
    description: t(PAGE_COPY['/'].description), offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@id': `${SITE_ORIGIN}/#organization` },
  });
  if (path !== '/') {
    const tool = /^\/tools\/([^/]+)\/$/.exec(path)?.[1];
    const copy = tool ? getTool(tool, locale) : PAGE_COPY[path as keyof typeof PAGE_COPY];
    const items = [{ '@type': 'ListItem', position: 1, name: 'komopdf', item: home }];
    if (tool) items.push({ '@type': 'ListItem', position: 2, name: t(TOOL_SHARED_COPY.title), item: absoluteUrl('/tools/', locale) });
    items.push({ '@type': 'ListItem', position: items.length + 1, name: t(copy?.title ?? 'Your komopdf account'), item: url });
    graph.push({ '@type': 'BreadcrumbList', itemListElement: items });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}
