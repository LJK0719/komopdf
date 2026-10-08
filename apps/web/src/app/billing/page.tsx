'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@pdf-editor/editor/i18n';
import { desktopBilling, DESKTOP_BILLING_KEY } from '../../lib/desktop-billing';
import '../account/account.css';

export default function BillingPage() {
  const { t, setLocale } = useI18n();
  const [error, setError] = useState(false);
  useEffect(() => {
    try {
      const encoded = window.location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
      const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0))));
      window.history.replaceState(null, '', window.location.pathname);
      const data = desktopBilling(value);
      if (!data) throw new Error('Invalid billing destination');
      sessionStorage.setItem(DESKTOP_BILLING_KEY, JSON.stringify(data));
      setLocale(data.lang); window.location.replace(data.url);
    } catch { setError(true); }
  }, [setLocale]);
  return <main className="account-page"><nav><Link href="/" className="account-wordmark">komopdf</Link></nav>
    <header><h1>{t(error ? 'Unable to open billing. Please try again.' : 'Opening…')}</h1></header>
    <p role={error ? 'alert' : 'status'}>{t(error ? 'Return to the app and open billing again.' : 'Opening secure checkout…')}</p>
    <footer><Link href="/privacy/">{t('Privacy')}</Link><Link href="/help/">{t('Help')}</Link></footer>
  </main>;
}
