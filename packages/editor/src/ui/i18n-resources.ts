import type { UiLocale } from './locales.js';
import { createUiInstance, translateWith, type TranslationValues } from './i18n-core.js';

export type UiMessages = Record<string, string>;
const loaders: Record<UiLocale, () => Promise<UiMessages>> = {
  en: async () => (await import('./locales/en.json')).default,
  'zh-CN': async () => (await import('./messages.js')).messages,
  'zh-TW': async () => (await import('./locales/zh-TW.json')).default,
  ja: async () => (await import('./locales/ja.json')).default,
  ko: async () => (await import('./locales/ko.json')).default,
  de: async () => (await import('./locales/de.json')).default,
  fr: async () => (await import('./locales/fr.json')).default,
  es: async () => (await import('./locales/es.json')).default,
  'pt-BR': async () => (await import('./locales/pt-BR.json')).default,
  it: async () => (await import('./locales/it.json')).default,
  ru: async () => (await import('./locales/ru.json')).default,
};
const siteLoaders: Record<UiLocale, () => Promise<UiMessages>> = {
  en: async () => ({}),
  'zh-CN': async () => (await import('./site-locales/zh-CN.json')).default,
  'zh-TW': async () => (await import('./site-locales/zh-TW.json')).default,
  ja: async () => (await import('./site-locales/ja.json')).default,
  ko: async () => (await import('./site-locales/ko.json')).default,
  de: async () => (await import('./site-locales/de.json')).default,
  fr: async () => (await import('./site-locales/fr.json')).default,
  es: async () => (await import('./site-locales/es.json')).default,
  'pt-BR': async () => (await import('./site-locales/pt-BR.json')).default,
  it: async () => (await import('./site-locales/it.json')).default,
  ru: async () => (await import('./site-locales/ru.json')).default,
};

export async function loadUiMessages(locale: UiLocale): Promise<UiMessages> {
  const [ui, site] = await Promise.all([loaders[locale](), siteLoaders[locale]()]);
  return { ...ui, ...site };
}

const publicLoaders: Record<UiLocale, () => Promise<{ default: UiMessages }>> = {
  en: () => import('./public-locales/en.json'),
  'zh-CN': () => import('./public-locales/zh-CN.json'),
  'zh-TW': () => import('./public-locales/zh-TW.json'),
  ja: () => import('./public-locales/ja.json'),
  ko: () => import('./public-locales/ko.json'),
  de: () => import('./public-locales/de.json'),
  fr: () => import('./public-locales/fr.json'),
  es: () => import('./public-locales/es.json'),
  'pt-BR': () => import('./public-locales/pt-BR.json'),
  it: () => import('./public-locales/it.json'),
  ru: () => import('./public-locales/ru.json'),
};

export async function loadPublicUiMessages(locale: UiLocale): Promise<UiMessages> {
  const [ui, site] = await Promise.all([publicLoaders[locale](), siteLoaders[locale]()]);
  return { ...ui.default, ...site };
}

export function createUiTranslator(locale: UiLocale, messages: UiMessages) {
  const instance = createUiInstance(locale, messages);
  return (message: string, values?: TranslationValues): string => translateWith(instance, message, values);
}
