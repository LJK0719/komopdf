'use client';
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useI18n } from '@pdf-editor/editor/i18n';
import { billingCallback, desktopBilling, DESKTOP_BILLING_KEY } from '../lib/desktop-billing';

export function DesktopBillingReturn({ children }: { children: ReactNode }) {
  const { t, setLocale } = useI18n();
  const [ready, setReady] = useState(false);
  const [callback, setCallback] = useState('');
  useEffect(() => {
    let target: string | null = null;
    try {
      const saved = sessionStorage.getItem(DESKTOP_BILLING_KEY);
      if (saved) {
        const data = desktopBilling(JSON.parse(saved));
        if (data) { target = billingCallback(data, new URLSearchParams(window.location.search)); if (target) setLocale(data.lang); }
        sessionStorage.removeItem(DESKTOP_BILLING_KEY);
      }
    } catch { /* An unavailable browser store falls back to the normal account page. */ }
    setCallback(target || ''); setReady(true);
    if (target) window.location.replace(target);
  }, [setLocale]);
  if (!ready) return <main className="account-page"><p role="status">{t('Loading…')}</p></main>;
  if (!callback) return children;
  return <main className="account-page"><nav><Link href="/" className="account-wordmark">komopdf</Link></nav>
    <header><h1>{t('Return to komopdf')}</h1></header><p>{t('Your account will update in the app.')}</p>
    <p><a className="account-return-button" href={callback}>{t('Return to komopdf')}</a></p>
    <p className="account-fine-print">{t('If the app is closed, open it and check your account.')}</p>
  </main>;
}
