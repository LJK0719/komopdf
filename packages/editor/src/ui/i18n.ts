import { useEffect, useSyncExternalStore } from 'react';
import { messages } from './messages.js';

export type UiLocale = 'en' | 'zh-CN';
const storageKey = 'komopdf.ui.language';
let locale: UiLocale = 'en';
let initialized = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setUiLocale(next: UiLocale) {
  locale = next;
  try { localStorage.setItem(storageKey, next); } catch { /* Preferences are optional in private browsing. */ }
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  listeners.forEach(listener => listener());
}

export function translate(message: string, values?: Record<string, string | number>): string {
  const translated = locale === 'zh-CN' ? messages[message] ?? message : message;
  return values ? translated.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match)) : translated;
}

export function useI18n() {
  const language = useSyncExternalStore(subscribe, () => locale, () => 'en' as UiLocale);
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    let saved: string | null = null;
    try { saved = localStorage.getItem(storageKey); } catch { /* Use the browser language. */ }
    setUiLocale(saved === 'zh-CN' || (!saved && navigator.language.startsWith('zh')) ? 'zh-CN' : 'en');
  }, []);
  return { locale: language, setLocale: setUiLocale, t: translate };
}
