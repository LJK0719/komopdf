'use client';

import Link from 'next/link';
import { Type, LayoutGrid, Files, Download, ArrowRight } from 'lucide-react';
import { SiteNav, SiteFooter } from '@/components/navigation';
import { SupportHelpButton } from '@/components/support-entry';
import { useI18n } from '@pdf-editor/editor/i18n';
import { localizedPath } from '@pdf-editor/editor/i18n-locales';

const guides = [
  { icon: Files, title: 'Open and switch documents', text: 'Choose Open PDF on the start screen, or open another file from the File menu. Use the document tabs to switch PDFs. Each document keeps its own changes.' },
  { icon: Type, title: 'Edit text & images', text: 'Choose Edit, then select text or an image on the page. The tools above the document follow your selection.' },
  { icon: LayoutGrid, title: 'Organize pages', text: 'Choose Pages to see the page overview. Select the pages you want to work with, then rotate, move, delete or extract them. Use Import PDF pages to add pages from another file.' },
  { icon: Download, title: 'Save & export', text: 'Choose Download PDF to save your work in the browser. On desktop, use Save. Choose Export for more file formats.' },
];
const shortcuts = [['Open PDF', 'Ctrl / ⌘ O'], ['Save / download a copy', 'Ctrl / ⌘ S'], ['Find in document', 'Ctrl / ⌘ F'], ['Print', 'Ctrl / ⌘ P'], ['Undo', 'Ctrl / ⌘ Z'], ['Redo', 'Ctrl / ⌘ Shift Z']];

export default function HelpPage() {
  const { t, locale } = useI18n();
  return <main className="site-shell"><SiteNav /><header className="site-page-heading"><span className="site-kicker">{t('Help')}</span><h1>{t('Get started with your PDF.')}</h1><p>{t('Open a document, choose a tool and keep your work moving. Here are the essentials for web and desktop.')}</p></header>
    <SupportHelpButton />
    <section className="help-grid" aria-label={t('Quick guide')}>{guides.map(({ icon: Icon, title, text }) => <article className="help-card" key={title}><Icon size={24} strokeWidth={1.6} aria-hidden="true" /><h2>{t(title)}</h2><p>{t(text)}</p></article>)}</section>
    <section className="site-prose"><section><h2>{t('Working with KOMO')}</h2><p>{t('Select text and choose Use AI to ask a question or describe a change. Open komo to discuss your PDF. Connect KolmoPDF in the editor to read or translate an entire document.')}</p><Link prefetch={false} href={localizedPath('/pricing/', locale)} className="site-text-link">{t('View plans')}<ArrowRight size={15} aria-hidden="true" /></Link></section>
      <section><h2>{t('Moving from web to desktop?')}</h2><p>{t('Download your PDF, then open it in the desktop app.')}</p><Link prefetch={false} href={localizedPath('/download/', locale)} className="site-text-link">{t('Get the desktop app')}<ArrowRight size={15} aria-hidden="true" /></Link></section>
      <section><h2>{t('Keyboard shortcuts')}</h2><div className="shortcut-list">{shortcuts.map(([label, keys]) => <div key={label}><span>{t(label!)}</span><kbd>{keys}</kbd></div>)}</div><Link prefetch={false} href={localizedPath('/', locale)} className="site-button site-button-primary">{t('Open editor')}<ArrowRight size={16} aria-hidden="true" /></Link></section>
    </section><SiteFooter /></main>;
}
