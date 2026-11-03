'use client';

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import type { i18n } from 'i18next';
import { createUiInstance, translateWith, type TranslationValues } from './i18n-core.js';
import { loadUiMessages, loadPublicUiMessages, type UiMessages } from './i18n-resources.js';
import { normalizeUiLocale, UI_LANGUAGE_STORAGE_KEY, type UiLocale } from './locales.js';

export type { UiLocale } from './locales.js';
export { UI_LOCALES, localizedPath, normalizeUiLocale } from './locales.js';

type LanguageScope = { documentLanguage: boolean; messageScope: 'public' | 'editor' };
const defaultScope: LanguageScope = { documentLanguage: true, messageScope: 'editor' };
const UiContext = createContext<({ instance: i18n } & LanguageScope) | null>(null);
// The legacy imperative translator is browser-only. Server renders use their own Provider instance.
let browserInstance: i18n | undefined;
const serverFallback = createUiInstance('en', {});
const languageRequests = new WeakMap<i18n, number>();

function currentInstance(): i18n {
  if (typeof window === 'undefined') return serverFallback;
  return browserInstance ??= createUiInstance('en', {});
}

export function getUiLocale(): UiLocale {
  return normalizeUiLocale(currentInstance().language) ?? 'en';
}

function preferredLocale(): UiLocale {
  try {
    const saved = normalizeUiLocale(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY));
    if (saved) return saved;
  } catch { /* Preferences are optional in private browsing. */ }
  for (const language of navigator.languages ?? [navigator.language]) {
    const supported = normalizeUiLocale(language);
    if (supported) return supported;
  }
  return 'en';
}

async function changeLanguage(instance: i18n, next: UiLocale, persist: boolean, scope = defaultScope): Promise<void> {
  const request = (languageRequests.get(instance) ?? 0) + 1;
  languageRequests.set(instance, request);
  const load = scope.messageScope === 'public' ? loadPublicUiMessages : loadUiMessages;
  const messages = instance.hasResourceBundle(next, 'translation') ? undefined : await load(next);
  if (request !== languageRequests.get(instance)) return;
  if (messages) instance.addResourceBundle(next, 'translation', messages, true, true);
  await instance.changeLanguage(next);
  if (typeof document !== 'undefined') {
    browserInstance = instance;
    if (scope.documentLanguage) document.documentElement.lang = next;
    if (persist) {
      try { localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, next); } catch { /* Preferences are optional. */ }
    }
  }
}

export function setUiLocale(next: UiLocale): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  return changeLanguage(currentInstance(), next, true);
}

export function translate(message: string, values?: TranslationValues): string {
  return translateWith(currentInstance(), message, values);
}

export function I18nProvider({ initialLocale, messages, detectLanguage = false, documentLanguage = true, messageScope = 'editor', children }: {
  initialLocale: UiLocale;
  messages: UiMessages;
  detectLanguage?: boolean;
  documentLanguage?: boolean;
  messageScope?: 'public' | 'editor';
  children: ReactNode;
}) {
  const [instance] = useState(() => {
    const created = createUiInstance(initialLocale, messages);
    if (typeof window !== 'undefined') browserInstance = created;
    return created;
  });
  const scope = useMemo(() => ({ instance, documentLanguage, messageScope }), [instance, documentLanguage, messageScope]);
  const initial = useRef(initialLocale);
  useEffect(() => {
    browserInstance = instance;
    if (documentLanguage) document.documentElement.lang = initialLocale;
    if (initial.current !== initialLocale) {
      initial.current = initialLocale;
      instance.addResourceBundle(initialLocale, 'translation', messages, true, true);
      void changeLanguage(instance, initialLocale, false, scope);
    } else if (detectLanguage) {
      void changeLanguage(instance, preferredLocale(), false, scope);
    }
  }, [instance, initialLocale, messages, detectLanguage, documentLanguage, scope]);
  return createElement(UiContext.Provider, { value: scope },
    createElement(I18nextProvider, { i18n: instance }, children));
}

export function useI18n() {
  const provided = useContext(UiContext);
  const instance = provided?.instance ?? currentInstance();
  const scope = provided ?? defaultScope;
  const { i18n: active } = useTranslation('translation', { i18n: instance, useSuspense: false });
  const locale = normalizeUiLocale(active.language) ?? 'en';
  const initialized = useRef(false);
  useEffect(() => {
    if (provided || initialized.current) return;
    initialized.current = true;
    void changeLanguage(instance, preferredLocale(), false);
  }, [provided, instance]);
  const setLocale = useCallback((next: UiLocale) => changeLanguage(instance, next, true, scope), [instance, scope]);
  const t = useCallback((message: string, values?: TranslationValues) => translateWith(instance, message, values), [instance, locale]);
  return { locale, setLocale, t };
}
