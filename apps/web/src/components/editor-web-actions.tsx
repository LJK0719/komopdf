'use client';

import { useRef } from 'react';
import { Menu } from 'lucide-react';
import { useI18n } from '@pdf-editor/editor/i18n';
import { localizedPath } from '@pdf-editor/editor/i18n-locales';

const links = [['/pricing/', 'Pricing'], ['/download/', 'Download app'], ['/account/', 'Account'], ['/sign-in/', 'Sign in']] as const;

export function EditorWebActions() {
  const { t, locale } = useI18n();
  const menu = useRef<HTMLDetailsElement>(null);
  const items = links.map(([href, label]) => <a key={href} href={localizedPath(href, locale)} target="_blank" rel="noopener noreferrer"
    className={href === '/sign-in/' ? 'editor-sign-in' : undefined}>{t(label)}</a>);
  return <nav className="editor-web-actions ai-owned-focus" aria-label={t('Main navigation')}>
    <div className="editor-web-links">{items}</div>
    <details className="editor-web-menu" ref={menu} onKeyDown={event => {
      if (event.key === 'Escape' && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
        event.preventDefault();
      }
    }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
      <summary aria-label={t('Navigation menu')}><Menu size={18} aria-hidden="true" /></summary>
      <div className="editor-web-menu-links">{items}</div>
    </details>
  </nav>;
}
