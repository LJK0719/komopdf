'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Languages, ArrowUpRight } from 'lucide-react';
import { useI18n, type UiLocale } from '@pdf-editor/editor/i18n';

export function SiteNav() {
  const { t, locale, setLocale } = useI18n();
  const pathname = usePathname();
  return <nav className="site-nav" aria-label={t('Main navigation')}>
    <Link href="/" className="site-brand"><span aria-hidden="true">k</span>komopdf</Link>
    <div className="site-nav-links">
      {[['/download/', 'Download'], ['/help/', 'Help']].map(([href, label]) => <Link key={href} href={href!} aria-current={pathname === href ? 'page' : undefined}>{t(label!)}</Link>)}
      <label className="site-language"><Languages size={16} /><select aria-label={t('Language')} value={locale} onChange={event => setLocale(event.target.value as UiLocale)}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      <Link href="/editor/" className="site-button site-button-primary">{t('Open editor')}<ArrowUpRight size={16} /></Link>
    </div>
  </nav>;
}

export function SiteFooter() {
  const { t } = useI18n();
  return <footer className="site-footer"><span>© 2026 komopdf · {t('A little less paperwork.')}</span><div>
    <Link href="/help/">{t('Help')}</Link><Link href="/download/">{t('Download')}</Link><Link href="/privacy/">{t('Privacy')}</Link>
    <a href="https://github.com/LJK0719/komopdf" target="_blank" rel="noreferrer">GitHub ↗</a>
  </div></footer>;
}
