'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Languages, ArrowUpRight, Menu, X } from 'lucide-react';
import { useI18n } from '@pdf-editor/editor/i18n';
import { UI_LOCALES, localizedPath, type UiLocale } from '@pdf-editor/editor/i18n-locales';

const links = [['/tools/', 'Tools'], ['/download/', 'Download'], ['/help/', 'Help'], ['/pricing/', 'Pricing'], ['/account/', 'Account & pricing']] as const;

export function languageSwitchHref(path: string, locale: UiLocale, search: string, hash: string): string {
  const params = new URLSearchParams(search);
  // The explicit page locale wins over legacy desktop language hints, including English.
  params.delete('lang');
  const query = params.toString();
  return localizedPath(path, locale) + (query ? `?${query}` : '') + hash;
}

export function SiteNav() {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const path = localizedPath(pathname, 'en');
  const languages = path === '/tools/annotate-pdf/' ? UI_LOCALES.filter(item => ['en', 'de', 'fr'].includes(item.id)) : UI_LOCALES;
  const menu = useRef<HTMLDetailsElement>(null);
  const closeMenu = () => { if (menu.current) menu.current.open = false; };
  const isCurrent = (href: string) => path === href;
  const switchLanguage = (next: UiLocale) => {
    window.location.assign(languageSwitchHref(path, next, window.location.search, window.location.hash));
  };
  return <nav className="site-nav" aria-label={t('Main navigation')}>
    <Link prefetch={false} href={localizedPath('/', locale)} className="site-brand" aria-label="komopdf" onClick={closeMenu}><span aria-hidden="true">k</span>komopdf</Link>
    <div className="site-nav-links">
      {links.map(([href, label]) => <Link prefetch={false} key={href} href={localizedPath(href, locale)} aria-current={isCurrent(href) ? 'page' : undefined}>{t(label)}</Link>)}
    </div>
    <div className="site-nav-actions">
      <details className="site-language-menu"><summary aria-label={t('Language')}><Languages size={16} aria-hidden="true" /><span>{UI_LOCALES.find(item => item.id === locale)?.label}</span></summary>
        <div className="site-language-links">{languages.map(item => <a key={item.id} href={localizedPath(path, item.id)} hrefLang={item.id} lang={item.id} aria-current={item.id === locale ? 'true' : undefined}
          onClick={event => { event.preventDefault(); switchLanguage(item.id); }}>{item.label}</a>)}</div>
      </details>
      <select className="site-language-select" aria-label={t('Language')} value={locale} onChange={event => switchLanguage(event.target.value as UiLocale)}>
        {languages.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <Link prefetch={false} href={localizedPath('/', locale)} className="site-button site-button-primary site-nav-editor">{t('Open editor')}<ArrowUpRight size={16} aria-hidden="true" /></Link>
      <details className="site-mobile-menu" ref={menu} onKeyDown={event => {
        if (event.key === 'Escape' && menu.current?.open) {
          closeMenu(); menu.current?.querySelector('summary')?.focus(); event.preventDefault();
        }
      }}>
        <summary aria-label={t('Navigation menu')}><Menu className="menu-open-icon" size={21} aria-hidden="true" /><X className="menu-close-icon" size={21} aria-hidden="true" /></summary>
        <div className="site-mobile-links">
          {links.map(([href, label]) => <Link prefetch={false} key={href} href={localizedPath(href, locale)} aria-current={isCurrent(href) ? 'page' : undefined} onClick={closeMenu}>{t(label)}</Link>)}
          <Link prefetch={false} href={localizedPath('/', locale)} className="site-button site-button-primary" onClick={closeMenu}>{t('Open editor')}<ArrowUpRight size={16} aria-hidden="true" /></Link>
        </div>
      </details>
    </div>
  </nav>;
}

export function SiteFooter() {
  const { t, locale } = useI18n();
  return <footer className="site-footer"><span>© 2026 komopdf</span><nav aria-label={t('Footer navigation')}>
    {links.map(([href, label]) => <Link prefetch={false} key={href} href={localizedPath(href, locale)}>{t(label)}</Link>)}
    <Link prefetch={false} href={localizedPath('/privacy/', locale)}>{t('Privacy')}</Link>
    <a href="https://github.com/LJK0719/komopdf" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={13} aria-hidden="true" /></a>
  </nav></footer>;
}
