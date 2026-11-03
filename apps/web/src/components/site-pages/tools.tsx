import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { UiLocale } from '@pdf-editor/editor/i18n-locales';
import { localizedPath } from '@pdf-editor/editor/i18n-locales';
import { SiteNav, SiteFooter } from '@/components/navigation';
import { ToolLauncher, ToolPageSession } from '@/components/tool-launcher';
import { getSiteI18n, structuredData } from '@/lib/site-seo';
import { toolsForLocale, ANNOTATION_TOOL, TOOL_SHARED_COPY, type ToolContent } from '@/lib/tool-content';

export async function ToolsIndex({ locale }: { locale: UiLocale }) {
  const { t } = await getSiteI18n(locale);
  return <main className="site-shell"><SiteNav />
    <header className="site-page-heading"><span className="site-kicker">komopdf</span><h1>{t(TOOL_SHARED_COPY.title)}</h1><p>{t(TOOL_SHARED_COPY.description)}</p></header>
    <section className="help-grid tool-grid" aria-label={t(TOOL_SHARED_COPY.title)}>{toolsForLocale(locale).map(tool => <article className="help-card" key={tool.slug}>
      <h2><Link prefetch={false} href={localizedPath(`/tools/${tool.slug}/`, locale)}>{t(tool.title)}</Link></h2><p>{t(tool.description)}</p>
      <Link prefetch={false} className="site-text-link" href={localizedPath(`/tools/${tool.slug}/`, locale)}>{t(tool.cta)}<ArrowRight size={15} aria-hidden="true" /></Link>
    </article>)}</section><SiteFooter />
  </main>;
}

export async function ToolPage({ locale, tool }: { locale: UiLocale; tool: ToolContent }) {
  const { t } = await getSiteI18n(locale);
  const data = await structuredData(locale, `/tools/${tool.slug}/`);
  return <ToolPageSession task={tool.task}><div className="site-shell tool-page"><SiteNav />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />
    <nav className="tool-breadcrumb" aria-label={t(TOOL_SHARED_COPY.related)}><Link prefetch={false} href={localizedPath('/tools/', locale)}>{t(TOOL_SHARED_COPY.title)}</Link><span aria-hidden="true"> / </span><span>{t(tool.title)}</span></nav>
    <header className="site-page-heading"><h1>{t(tool.title)}</h1><p>{t(tool.intro)}</p></header>
    <div className="tool-entry"><ToolLauncher label={tool.cta} /><p>{t(TOOL_SHARED_COPY.local)}</p></div>
    <article className="site-prose tool-guide"><section><h2>{t(TOOL_SHARED_COPY.steps)}</h2><ol className="tool-steps">{tool.steps.map(step => <li key={step.title}><h3>{t(step.title)}</h3><p>{t(step.text)}</p></li>)}</ol>{tool.task === 'edit-text' ? <p>{t(ANNOTATION_TOOL.steps[1]!.text)}</p> : null}</section>
      <section><h2>{t(TOOL_SHARED_COPY.limits)}</h2><ul>{tool.limits.map(limit => <li key={limit}>{t(limit)}</li>)}<li>{t(TOOL_SHARED_COPY.webLimits)}</li></ul></section>
      <section><h2>{t(TOOL_SHARED_COPY.faq)}</h2>{tool.faq.map(item => <details className="tool-faq" key={item.question}><summary>{t(item.question)}</summary><p>{t(item.answer)}</p></details>)}</section>
      <section><h2>{t(TOOL_SHARED_COPY.related)}</h2><ul>{toolsForLocale(locale).filter(item => item.slug !== tool.slug).map(item => <li key={item.slug}><Link prefetch={false} className="site-text-link" href={localizedPath(`/tools/${item.slug}/`, locale)}>{t(item.title)}</Link></li>)}</ul></section>
    </article><SiteFooter />
  </div></ToolPageSession>;
}
