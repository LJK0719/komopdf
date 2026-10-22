import { TEXT_LANGUAGES } from '@pdf-editor/contracts';

const PREFIX = 'komopdf.ai.preferences.v1:';
export function aiPreferenceKey(owner: string | null): string {
  return PREFIX + (owner === null ? 'guest' : `user:${encodeURIComponent(owner)}`);
}
export function preferredAiLanguage(locale: string, owner: string | null | undefined): string {
  const fallback = locale.startsWith('zh') ? 'zh' : 'en';
  if (owner === undefined) return fallback;
  try {
    const stored = localStorage.getItem(aiPreferenceKey(owner));
    const language: unknown = stored ? JSON.parse(stored)?.targetLanguage
      : owner === null ? localStorage.getItem('komopdf.ai.target-language.v1') : null;
    return TEXT_LANGUAGES.some(item => item.code === language) ? language as string : fallback;
  } catch { return fallback; }
}
export function saveAiLanguage(owner: string | null | undefined, targetLanguage: string): void {
  if (owner === undefined || !TEXT_LANGUAGES.some(item => item.code === targetLanguage)) return;
  try { localStorage.setItem(aiPreferenceKey(owner), JSON.stringify({ targetLanguage })); }
  catch { /* Translation remains available when browser storage is blocked. */ }
}
