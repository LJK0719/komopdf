'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@pdf-editor/editor/i18n';
import { localizedPath } from '@pdf-editor/editor/i18n-locales';
import { SiteNav, SiteFooter } from '../navigation';
import { desktopBilling, DESKTOP_BILLING_KEY } from '../../lib/desktop-billing';
import '../../app/account/account.css';

export default function BillingPage() {
  const { t, locale, setLocale } = useI18n();
  const [error, setError] = useState(false);
  useEffect(() => {
    try {
      const encoded = window.location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
      const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0))));
      window.history.replaceState(null, '', window.location.pathname);
      const data = desktopBilling(value);
      if (!data) throw new Error('Invalid billing destination');
      sessionStorage.setItem(DESKTOP_BILLING_KEY, JSON.stringify(data));
      void setLocale(data.lang).then(() => window.location.replace(data.url)).catch(() => setError(true));
    } catch { setError(true); }
  }, [setLocale]);
  return <main className="site-shell account-page"><SiteNav />
    <section className="billing-status"><span className="site-kicker">{t('Account & pricing')}</span><h1>{t(error ? 'Unable to open billing. Please try again.' : 'Opening…')}</h1>
      <p role={error ? 'alert' : 'status'}>{t(error ? 'Return to the app and open billing again.' : 'Opening secure checkout…')}</p>
      {error ? <Link className="site-button site-button-outline" href={localizedPath('/account/', locale)}>{t('View plans')}</Link> : null}
    </section><SiteFooter />
  </main>;
}
