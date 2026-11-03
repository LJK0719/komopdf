import { createInstance, type i18n } from 'i18next';
import type { UiLocale } from './locales.js';
import type { UiMessages } from './i18n-resources.js';

export type TranslationValues = Record<string, string | number>;

export function createUiInstance(locale: UiLocale, messages: UiMessages): i18n {
  const instance = createInstance();
  void instance.init({
    lng: locale,
    fallbackLng: 'en',
    resources: { [locale]: { translation: messages } },
    initAsync: false,
    keySeparator: false,
    nsSeparator: false,
    returnNull: false,
    interpolation: { prefix: '{', suffix: '}', escapeValue: false },
  });
  return instance;
}

export function translateWith(instance: i18n, message: string, values?: TranslationValues): string {
  return instance.t(message, { defaultValue: message, ...values });
}
