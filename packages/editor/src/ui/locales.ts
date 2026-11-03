export const UI_LOCALES = [
  { id: 'en', label: 'English', path: '', nsis: 'English' },
  { id: 'zh-CN', label: '简体中文', path: 'zh-cn', nsis: 'SimpChinese' },
  { id: 'zh-TW', label: '繁體中文', path: 'zh-tw', nsis: 'TradChinese' },
  { id: 'ja', label: '日本語', path: 'ja', nsis: 'Japanese' },
  { id: 'ko', label: '한국어', path: 'ko', nsis: 'Korean' },
  { id: 'de', label: 'Deutsch', path: 'de', nsis: 'German' },
  { id: 'fr', label: 'Français', path: 'fr', nsis: 'French' },
  { id: 'es', label: 'Español', path: 'es', nsis: 'Spanish' },
  { id: 'pt-BR', label: 'Português (Brasil)', path: 'pt-br', nsis: 'PortugueseBR' },
  { id: 'it', label: 'Italiano', path: 'it', nsis: 'Italian' },
  { id: 'ru', label: 'Русский', path: 'ru', nsis: 'Russian' },
] as const;

export type UiLocale = typeof UI_LOCALES[number]['id'];
export const UI_LANGUAGE_STORAGE_KEY = 'komopdf.ui.language';

export function normalizeUiLocale(value: string | null | undefined): UiLocale | undefined {
  if (!value) return undefined;
  const normalized = value.replaceAll('_', '-').toLowerCase();
  const exact = UI_LOCALES.find(item => item.id.toLowerCase() === normalized);
  if (exact) return exact.id;
  if (/^zh-(?:tw|hk|mo|hant)(?:-|$)/.test(normalized)) return 'zh-TW';
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-BR';
  return UI_LOCALES.find(item => item.id === normalized.split('-')[0])?.id;
}

export function localeFromPathname(pathname: string): UiLocale {
  const segment = pathname.split('/')[1]?.toLowerCase();
  return UI_LOCALES.find(item => item.path === segment)?.id ?? 'en';
}

export function localizedPath(href: string, locale: UiLocale): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const split = href.search(/[?#]/);
  const pathname = split < 0 ? href : href.slice(0, split);
  const suffix = split < 0 ? '' : href.slice(split);
  const parts = pathname.split('/').filter(Boolean);
  if (UI_LOCALES.some(item => item.path && item.path === parts[0])) parts.shift();
  const prefix = UI_LOCALES.find(item => item.id === locale)!.path;
  const segments = [...(prefix ? [prefix] : []), ...parts];
  return `/${segments.join('/')}${segments.length ? '/' : ''}${suffix}`;
}
