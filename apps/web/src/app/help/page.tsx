'use client';

import Link from 'next/link';
import { Type, LayoutGrid, Sparkles, Download } from 'lucide-react';
import { SiteNav, SiteFooter } from '@/components/navigation';
import { useI18n } from '@pdf-editor/editor/i18n';

export default function HelpPage() {
  const { t } = useI18n();
  return <main className="site-shell"><SiteNav /><header className="site-page-heading"><span className="site-kicker">{t('A good place to start')}</span><h1>{t('A few steps. A better PDF.')}</h1><p>{t('Open your file, choose a tool and make your changes. Here are the essentials.')}</p></header>
    <section className="help-grid">{[
      { icon: Type, title: 'Edit text & images', text: 'Choose Edit and double-click text to type on the page. Font, size and color appear above the document. Click outside the text or press Ctrl / ⌘ Enter to finish. Select an image to replace or crop it. Right-click objects for editing actions.' },
      { icon: LayoutGrid, title: 'Organize pages', text: 'Select a page in the left sidebar, then choose Organize pages. Rotate, duplicate, move or delete it, import another PDF, or extract pages into a new file.' },
      { icon: Sparkles, title: 'Read continuously', text: 'Scroll through the whole document. The page number follows your position. Use Home or View for single pages, facing pages, continuous scrolling and full-screen playback. Hand drags the document; Select lets you copy text.' },
      { icon: Download, title: 'Save & export', text: 'Select Save to keep your changes. Use Export for a separate copy, compression or password protection. Undo and Redo are always in the top bar.' },
    ].map(({ icon: Icon, title, text }) => <article className="help-card" key={title}><Icon size={24} /><h2>{t(title)}</h2><p>{t(text)}</p></article>)}</section>
    <section className="site-prose"><h2>{t('Keyboard shortcuts')}</h2><div className="shortcut-list">{[['Open PDF','Ctrl / ⌘ O'],['Save','Ctrl / ⌘ S'],['Find in document','Ctrl / ⌘ F'],['Print','Ctrl / ⌘ P'],['Undo','Ctrl / ⌘ Z'],['Redo','Ctrl / ⌘ Shift Z']].map(([label, keys]) => <div key={label} style={{display:'contents'}}><span>{t(label!)}</span><kbd>{keys}</kbd></div>)}</div><h2>{t('Ready to try it?')}</h2><Link href="/editor/" className="site-button site-button-primary">{t('Open editor')}</Link></section><SiteFooter /></main>;
}
