import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { localizedPath, type UiLocale } from '@pdf-editor/editor/i18n-locales';
import { SiteNav, SiteFooter } from '@/components/navigation';
import { getSiteI18n } from '@/lib/site-seo';
import '@/app/account/account.css';

export async function PricingPage({ locale }: { locale: UiLocale }) {
  const { t } = await getSiteI18n(locale);
  return <main className="site-shell account-page"><SiteNav />
    <header className="site-page-heading"><span className="site-kicker">{t('Pricing')}</span><h1>{t('Free PDF tools. More with KOMO.')}</h1><p>{t('Edit PDFs for free, without an account. Sign in for KOMO, or choose Plus for unlimited conversations.')}</p></header>
    <section className="account-pricing" aria-labelledby="plans-title"><div className="account-section-heading"><h2 id="plans-title">{t('Choose your KOMO plan')}</h2></div>
      <div className="account-pricing-grid">
        <article className="account-price-card"><span className="site-kicker">{t('Free plan')}</span><h3>{t('For everyday PDF work')}</h3><p className="account-price"><strong>$0</strong><span>{t('/ forever')}</span></p>
          <ul>{['All PDF editing tools', 'No account for PDF editing', '1,000 welcome credits', 'KOMO conversations with credits'].map(label => <li key={label}><Check size={16} aria-hidden="true" />{t(label)}</li>)}</ul>
          <p className="account-fine-print">{t('Welcome credits are added when you create an account.')}</p>
          <Link prefetch={false} className="site-button site-button-outline" href={localizedPath('/', locale)}>{t('Open editor')}<ArrowRight size={16} aria-hidden="true" /></Link>
          <Link prefetch={false} className="site-text-link account-create-link" href={localizedPath('/sign-up/', locale)}>{t('Create your account')}</Link>
        </article>
        <article className="account-price-card account-price-card-plus"><span className="site-kicker">KOMO Plus</span><h3>{t('For more work with KOMO')}</h3><p className="account-price"><strong>$4.99</strong><span>{t('/ month')}</span></p>
          <ul>{['All PDF editing tools', 'Unlimited KOMO conversations', 'Web and desktop access', 'Cancel anytime'].map(label => <li key={label}><Check size={16} aria-hidden="true" />{t(label)}</li>)}</ul>
          <p className="account-fine-print">{t('Billed monthly in USD.')}</p>
          <Link prefetch={false} className="site-button site-button-primary" href={localizedPath('/sign-in/', locale) + '?returnTo=' + encodeURIComponent(localizedPath('/account/', locale))}>{t('Sign in to upgrade')}<ArrowRight size={16} aria-hidden="true" /></Link>
        </article>
      </div>
      <p className="account-plan-note">{t('KolmoPDF services use your connected account balance.')}</p>
    </section><SiteFooter />
  </main>;
}
