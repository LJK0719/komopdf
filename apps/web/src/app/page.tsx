'use client';

import Link from 'next/link';
import { ArrowUpRight, ArrowRight, Type, LayoutGrid, Sparkles, Check, FileText, Undo2, Download, MessageSquare } from 'lucide-react';
import { SiteNav, SiteFooter } from '@/components/navigation';
import { useI18n } from '@pdf-editor/editor/i18n';

export default function HomePage() {
  const { t } = useI18n();
  return <main className="site-shell">
    <SiteNav />
    <section className="site-hero">
      <div className="hero-copy"><span className="site-kicker"><span />{t('Your everyday PDF workspace')}</span>
        <h1>{t('Less paperwork.')}<br /><em>{t('More possibility.')}</em></h1>
        <p>{t('Read without interruptions. Edit directly on the page. Keep your everyday PDF work in one place.')}</p>
        <div className="hero-actions"><Link className="site-button site-button-primary site-button-large" href="/editor/">{t('Open a PDF')}<ArrowUpRight size={18} /></Link><Link className="site-button site-button-outline site-button-large" href="/download/"><Download size={17} />{t('Get the desktop app')}</Link></div>
        <div className="hero-notes"><span><Check size={14} />{t('Free to use')}</span><span><Check size={14} />{t('No account needed')}</span><span><Check size={14} />{t('Your files stay yours')}</span></div>
      </div>
      <div className="product-preview" aria-label={t('Editor preview')}>
        <div className="preview-top"><span className="preview-brand">k</span><span>komopdf</span><span className="preview-filename">{t('A fresh perspective.pdf')}</span><span className="preview-save">{t('Save')}</span></div>
        <div className="preview-tools"><span><Type size={13} />{t('Edit')}</span><span><LayoutGrid size={13} />{t('Pages')}</span><span><MessageSquare size={13} />{t('Comment')}</span><Undo2 size={13} /></div>
        <div className="preview-body"><div className="preview-pages"><span className="mini-page is-selected" /><small>1</small><span className="mini-page" /><small>2</small></div>
          <div className="preview-canvas"><div className="preview-paper"><span className="paper-eyebrow">FIELD NOTES / 2026</span><h2>{t('Good things,')}<br /><em>{t('taking shape.')}</em></h2><div className="paper-line" /><div className="paper-line short" /><div className="paper-art"><div /><div /><div /></div><span className="paper-caption">{t('A new way to work with your ideas.')}</span></div></div>
          <div className="preview-ai"><Type size={20} /><strong>{t('Edit right on the page.')}</strong><p>{t('Select text or an image. The tools you need appear above your document.')}</p><div className="preview-prompt">{t('Text editing')}<ArrowRight size={13} /></div><div className="preview-answer"><span /><span /><span /></div></div>
        </div>
        <div className="preview-bottom"><span>{t('All set.')}</span><span>1 / 2 · 100%</span></div>
      </div>
    </section>
    <section className="site-features"><div className="section-intro"><span className="site-kicker">{t('Made for the work in front of you')}</span><h2>{t('Everything in its right place.')}</h2></div>
      <div className="feature-grid">{[
        { icon: Type, title: 'Make the small changes.', text: 'Edit text, replace images and fine-tune the details without starting over.' },
        { icon: LayoutGrid, title: 'Put pages in order.', text: 'Rotate, combine, extract and arrange pages into the document you need.' },
        { icon: FileText, title: 'Read continuously.', text: 'Scroll naturally, compare facing pages and switch to full screen when you want to focus.' },
      ].map(({ icon: Icon, title, text }) => <article key={title}><div className="feature-icon"><Icon size={22} /></div><h3>{t(title)}</h3><p>{t(text)}</p></article>)}</div>
    </section>
    <section className="site-bottom-cta"><FileText size={28} /><div><h2>{t('Your next document starts here.')}</h2><p>{t('Open a file and make it your own.')}</p></div><Link className="site-button site-button-primary" href="/editor/">{t('Start editing')}<ArrowRight size={16} /></Link></section>
    <SiteFooter />
  </main>;
}
