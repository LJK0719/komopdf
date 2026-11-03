import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUiLocale, translate } from '../src/ui/i18n.js';
import { createUiTranslator, loadUiMessages, loadPublicUiMessages } from '../src/ui/i18n-resources.js';
import { UI_LOCALES, localizedPath, normalizeUiLocale } from '../src/ui/locales.js';

beforeEach(() => vi.stubGlobal('window', {}));
afterEach(async () => { await setUiLocale('en'); vi.unstubAllGlobals(); });

describe('UI language', () => {
  it('loads languages before switching and interpolates user values unchanged', async () => {
    await setUiLocale('zh-CN');
    expect(translate('Save')).toBe('保存');
    expect(translate('Organize pages')).toBe('整理页面');
    expect(translate('Open page {page}', { page: 12 })).toBe('打开第 12 页');
    expect(translate('My quarterly report.pdf')).toBe('My quarterly report.pdf');
    await setUiLocale('en');
    expect(translate('Save')).toBe('Save');
  });

  it('keeps static-page translation instances isolated', () => {
    const german = createUiTranslator('de', { Save: 'Speichern' });
    const french = createUiTranslator('fr', { Save: 'Enregistrer' });
    expect(german('Save')).toBe('Speichern');
    expect(french('Save')).toBe('Enregistrer');
    expect(german('Save')).toBe('Speichern');
  });

  it('uses numeric count for singular and plural forms', async () => {
    const t = createUiTranslator('en', await loadUiMessages('en'));
    expect(t('{count} pages', { count: 1 })).toBe('1 page');
    expect(t('{count} pages', { count: 2 })).toBe('2 pages');
  });

  it('keeps public resources small and identical to their original translations', async () => {
    for (const { id } of UI_LOCALES) {
      const [publicMessages, full] = await Promise.all([loadPublicUiMessages(id), loadUiMessages(id)]);
      expect(Object.keys(publicMessages).length).toBeLessThan(400);
      for (const [key, value] of Object.entries(publicMessages)) expect(value, `${id}: ${key}`).toBe(full[key]);
      expect(publicMessages).not.toHaveProperty('The original PDF is unavailable. Your conversation and attachments are kept here.');
      if (id !== 'en') expect(publicMessages['Account & pricing']).toBe(full['Account & pricing']);
    }
  });

  it('localizes dynamic account API failures, including expired sessions, in all public locales', async () => {
    const errors = [
      'Your session has expired. Sign in again.',
      'Sign in to continue.',
      'Sign-in expired. Please try again.',
      'Unable to sign in. Please try again.',
      'Account service temporarily unavailable.',
      'Subscriptions are currently unavailable. Please try again later.',
      'Payment is not confirmed yet.',
      'Not enough credits. Start a new conversation or upgrade to Plus.',
    ];
    for (const { id } of UI_LOCALES) {
      const [publicMessages, full] = await Promise.all([loadPublicUiMessages(id), loadUiMessages(id)]);
      const t = createUiTranslator(id, publicMessages);
      const original = createUiTranslator(id, full);
      for (const error of errors) {
        expect(t(error), `${id}: ${error}`).toBe(original(error));
        if (id !== 'en') expect(t(error), `${id}: ${error}`).not.toBe(error);
      }
    }
  });

  it('recognizes script and regional variants without confusing Chinese scripts', () => {
    expect(normalizeUiLocale('zh-Hant-HK')).toBe('zh-TW');
    expect(normalizeUiLocale('zh-Hans')).toBe('zh-CN');
    expect(normalizeUiLocale('de-AT')).toBe('de');
    expect(normalizeUiLocale('pt_BR')).toBe('pt-BR');
    expect(normalizeUiLocale('ar')).toBeUndefined();
    expect(UI_LOCALES).toHaveLength(11);
  });

  it('changes the locale of the same page without dropping return context', () => {
    expect(localizedPath('/help/', 'ja')).toBe('/ja/help/');
    expect(localizedPath('/zh-cn/account/?desktop_callback=keep&lang=zh-CN#return', 'de')).toBe('/de/account/?desktop_callback=keep&lang=zh-CN#return');
    expect(localizedPath('/pt-br/', 'en')).toBe('/');
    expect(localizedPath('https://example.com/app.exe', 'fr')).toBe('https://example.com/app.exe');
  });
});
