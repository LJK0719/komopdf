'use client';
import { useEffect, useRef, useState } from 'react';
import { SignIn, SignUp } from '@clerk/react';
import Link from 'next/link';
import { useI18n } from '@pdf-editor/editor/i18n';
import { AccountProvider, useKomoAccount } from './account-provider';
import { SiteNav, SiteFooter } from './navigation';
import './auth-screen.css';

const appearance = {
  variables: { colorPrimary: '#217b5e', colorBackground: '#ffffff', colorText: '#20362c', borderRadius: '8px' },
  elements: {
    rootBox: { width: '100%' }, cardBox: { boxShadow: 'none', width: '100%' },
    card: { boxShadow: 'none', border: '1px solid var(--komo-line, #dfe5e0)' },
    footer: { background: 'transparent' },
  },
};

export function AuthScreen({ signup = false }: { signup?: boolean }) {
  return <AccountProvider><AuthContent signup={signup} /></AccountProvider>;
}
function AuthContent({ signup }: { signup: boolean }) {
  const { t, setLocale } = useI18n();
  const { ready, signedIn, error, request } = useKomoAccount();
  const [params, setParams] = useState<URLSearchParams | null>(null);
  const [failure, setFailure] = useState('');
  const finishing = useRef(false);
  useEffect(() => {
    const next = new URLSearchParams(window.location.search);
    setParams(next);
    if (next.get('lang') === 'zh-CN' || next.get('lang') === 'en') setLocale(next.get('lang') as 'en' | 'zh-CN');
  }, [setLocale]);
  useEffect(() => {
    if (!signedIn || !params || finishing.current) return;
    finishing.current = true;
    const desktop = params.get('desktop');
    if (desktop) {
      request('/api/account/login/complete', { id: desktop }).then(result => {
        window.location.replace(result.redirectUrl);
      }).catch(error => setFailure(error instanceof Error ? error.message : 'Unable to sign in. Please try again.'));
    } else {
      const destination = new URL(params.get('returnTo') || '/account/', window.location.origin);
      window.location.replace(destination.origin === window.location.origin && !/^\/sign-(in|up)\//.test(destination.pathname) ? destination.href : '/account/');
    }
  }, [signedIn, params, request]);
  const query = params?.toString();
  const suffix = query ? `?${query}` : '';
  const complete = `/sign-in/${suffix}`;
  return <main className="site-shell auth-page">
    <SiteNav />
    <div className="auth-layout">
      <header className="auth-intro"><span className="site-kicker">{t('Your komopdf account')}</span><h1>{t(signup ? 'Create your account' : 'Sign in to komopdf')}</h1><p>{t(params?.get('desktop') ? 'Sign in here to continue in the desktop app.' : 'Use KOMO and manage your plan across web and desktop.')}</p><p className="auth-free-note">{t('PDF editing stays free.')} <Link className="site-text-link" href="/editor/">{t('Open editor')}</Link></p></header>
      <section className="auth-card" aria-label={t(signup ? 'Create your account' : 'Sign in to komopdf')}>
        {failure || error ? <div className="auth-status"><h2>{t('Unable to sign in. Please try again.')}</h2><p role="alert">{t(failure || error)}</p>
          {!params?.get('desktop') ? <a className="site-button site-button-primary" href={complete}>{t('Sign in again')}</a> : null}
          {params?.get('desktop') ? <p>{t('Return to the app and start sign-in again.')}</p> : null}</div>
          : !ready || !params ? <div className="auth-status"><p role="status">{t('Loading…')}</p></div>
            : signedIn ? <div className="auth-status"><h2>{t('Signing you in…')}</h2><p role="status">{t(params.get('desktop') ? 'Returning to komopdf…' : 'Opening your account…')}</p></div>
              : signup ? <SignUp routing="hash" appearance={appearance} signInUrl={`/sign-in/${suffix}`} forceRedirectUrl={complete} signInForceRedirectUrl={complete} />
                : <SignIn routing="hash" appearance={appearance} signUpUrl={`/sign-up/${suffix}`} forceRedirectUrl={complete} signUpForceRedirectUrl={complete} />}
      </section>
    </div>
    <SiteFooter />
  </main>;
}
