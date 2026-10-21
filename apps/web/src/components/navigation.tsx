'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Languages, ArrowUpRight, Menu, X } from 'lucide-react';
import { useI18n, type UiLocale } from '@pdf-editor/editor/i18n';

const links = [['/download/', 'Download'], ['/help/', 'Help'], ['/account/', 'Account & pricing']] as const;

export function SiteNav() {
  const { t, locale, setLocale } = useI18n();
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  const closeMenu = () => { if (menu.current) menu.current.open = false; };
  const isCurrent = (href: string) => pathname.replace(/\/$/, '') === href.replace(/\/$/, '');
  return <nav className="site-nav" aria-label={t('Main navigation')}>
    <Link href="/" className="site-brand" aria-label="komopdf" onClick={closeMenu}><span aria-hidden="true">k</span>komopdf</Link>
    <div className="site-nav-links">
      {links.map(([href, label]) => <Link key={href} href={href} aria-current={isCurrent(href) ? 'page' : undefined}>{t(label)}</Link>)}
    </div>
    <div className="site-nav-actions">
      <label className="site-language"><Languages size={16} aria-hidden="true" /><select aria-label={t('Language')} value={locale} onChange={event => setLocale(event.target.value as UiLocale)}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      <Link href="/editor/" className="site-button site-button-primary site-nav-editor">{t('Open editor')}<ArrowUpRight size={16} aria-hidden="true" /></Link>
      <details className="site-mobile-menu" ref={menu} onKeyDown={event => {
        if (event.key === 'Escape' && menu.current?.open) {
          closeMenu(); menu.current?.querySelector('summary')?.focus(); event.preventDefault();
        }
      }}>
        <summary aria-label={t('Navigation menu')}><Menu className="menu-open-icon" size={21} aria-hidden="true" /><X className="menu-close-icon" size={21} aria-hidden="true" /></summary>
        <div className="site-mobile-links">
          {links.map(([href, label]) => <Link key={href} href={href} aria-current={isCurrent(href) ? 'page' : undefined} onClick={closeMenu}>{t(label)}</Link>)}
          <Link href="/editor/" className="site-button site-button-primary" onClick={closeMenu}>{t('Open editor')}<ArrowUpRight size={16} aria-hidden="true" /></Link>
        </div>
      </details>
    </div>
  </nav>;
}

export function SiteFooter() {
  const { t } = useI18n();
  return <footer className="site-footer"><span>© 2026 komopdf</span><nav aria-label={t('Footer navigation')}>
    <Link href="/download/">{t('Download')}</Link><Link href="/account/">{t('Account & pricing')}</Link><Link href="/help/">{t('Help')}</Link><Link href="/privacy/">{t('Privacy')}</Link>
    <a href="https://github.com/LJK0719/komopdf" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={13} aria-hidden="true" /></a>
  </nav></footer>;
}
