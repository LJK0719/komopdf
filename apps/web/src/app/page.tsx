'use client';

import Link from 'next/link';
import { ArrowUpRight, ArrowRight, Type, LayoutGrid, Check, FileText, Undo2, Redo2, Download, MessageSquare, Plus, X, ChevronDown } from 'lucide-react';
import { SiteNav, SiteFooter } from '@/components/navigation';
import { useI18n } from '@pdf-editor/editor/i18n';

const features = [
  { icon: Type, title: 'Edit the details.', text: 'Change text and images directly on the page. Add comments, fill forms and sign your documents.' },
  { icon: LayoutGrid, title: 'Keep documents in order.', text: 'Arrange, rotate and extract pages. Keep multiple PDFs open and move between them with document tabs.' },
  { icon: MessageSquare, title: 'Get help from KOMO.', text: 'Ask questions about your PDF on the web. Use the desktop assistant for document editing tasks.' },
];

export default function HomePage() {
  const { t } = useI18n();
  return <main className="site-shell">
    <SiteNav />
    <section className="site-hero">
      <div className="hero-copy"><span className="site-kicker">{t('Your everyday PDF workspace')}</span>
        <h1>{t('Your documents.')}<br /><em>{t('Ready for work.')}</em></h1>
        <p>{t('Read, edit and organize PDFs in a workspace built around your documents. Start in your browser, or work on your desktop.')}</p>
        <div className="hero-actions"><Link className="site-button site-button-primary site-button-large" href="/editor/">{t('Open editor')}<ArrowUpRight size={18} aria-hidden="true" /></Link><Link className="site-button site-button-outline site-button-large" href="/download/"><Download size={17} aria-hidden="true" />{t('Get the desktop app')}</Link></div>
        <div className="hero-notes"><span><Check size={15} aria-hidden="true" />{t('Free PDF tools')}</span><span><Check size={15} aria-hidden="true" />{t('No account for PDF editing')}</span><span><Check size={15} aria-hidden="true" />{t('Files stay on your device')}</span></div>
      </div>
      <figure className="product-figure">
        <div className="product-preview" role="img" aria-label={t('PDF workspace preview with document tabs, page navigation and editing tools')}>
          <div className="preview-top"><span className="preview-brand">k</span><strong>komopdf</strong><span className="preview-file">{t('File')}<ChevronDown size={12} /></span><Undo2 size={14} /><Redo2 size={14} /><span className="preview-top-spacer" /><span className="preview-save"><Download size={13} />{t('Download copy')}</span><span className="preview-komo">komo</span></div>
          <div className="preview-tabs"><span className="preview-tab is-active"><FileText size={13} />{t('Field notes.pdf')}<X size={12} /></span><span className="preview-tab"><FileText size={13} />{t('Reference.pdf')}<X size={12} /></span><Plus size={14} /></div>
          <div className="preview-tools"><span>{t('Home')}</span><span className="is-active">{t('Edit')}</span><span>{t('Comment')}</span><span>{t('Pages')}</span><span>{t('View')}</span></div>
          <div className="preview-context"><Type size={15} /><span>{t('Text editing')}</span><span className="preview-context-rule" /><span>Georgia</span><span>24</span><span className="preview-color" /></div>
          <div className="preview-body"><div className="preview-pages"><span className="preview-panel-label">{t('Pages')}</span><span className="mini-page is-selected" /><small>1</small><span className="mini-page" /><small>2</small></div>
            <div className="preview-canvas"><div className="preview-paper"><span className="paper-eyebrow">{t('FIELD NOTES / 2026')}</span><h2>{t('Good things,')}<br /><em>{t('taking shape.')}</em></h2><div className="paper-line" /><div className="paper-line short" /><div className="paper-art"><div /><div /><div /></div><span className="paper-caption">{t('A new way to work with your ideas.')}</span></div></div>
            <div className="preview-properties"><span className="preview-panel-label">{t('Text properties')}</span><Type size={22} /><strong>{t('Edit right on the page.')}</strong><p>{t('Select text to adjust its font, size and color. Your document stays in view.')}</p><div className="preview-property"><span>{t('Font')}</span><span>Georgia</span></div><div className="preview-property"><span>{t('Size')}</span><span>24</span></div></div>
          </div>
          <div className="preview-bottom"><span>{t('Field notes.pdf')}</span><span>1 / 2 · 100%</span></div>
        </div>
        <figcaption>{t('Your files, tools and pages. One focused workspace.')}</figcaption>
      </figure>
    </section>
    <section className="site-features" aria-labelledby="features-title"><div className="section-intro"><span className="site-kicker">{t('Built for everyday documents')}</span><h2 id="features-title">{t('From the first page to the final copy.')}</h2></div>
      <div className="feature-grid">{features.map(({ icon: Icon, title, text }) => <article key={title}><div className="feature-icon"><Icon size={22} strokeWidth={1.7} aria-hidden="true" /></div><h3>{t(title)}</h3><p>{t(text)}</p></article>)}</div>
    </section>
    <section className="site-bottom-cta"><FileText size={28} aria-hidden="true" /><div><h2>{t('PDF tools are free. Keep it that simple.')}</h2><p>{t('No account needed to edit. Sign in when you want to use KOMO.')} <Link className="site-text-link" href="/account/">{t('View plans')}<ArrowRight size={14} aria-hidden="true" /></Link></p></div><Link className="site-button site-button-primary" href="/editor/">{t('Open editor')}<ArrowRight size={16} aria-hidden="true" /></Link></section>
    <SiteFooter />
  </main>;
}
