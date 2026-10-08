'use client';
import { useEffect, useRef, useState } from 'react';
import { SignIn, SignUp } from '@clerk/react';
import Link from 'next/link';
import { useI18n } from '@pdf-editor/editor/i18n';
import { AccountProvider, useKomoAccount } from './account-provider';
import './auth-screen.css';

export function AuthScreen({ signup = false }: { signup?: boolean }) {
  return <AccountProvider><AuthContent signup={signup} /></AccountProvider>;
}
function AuthContent({ signup }: { signup: boolean }) {
  const { t, locale, setLocale } = useI18n();
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
  const appearance = { variables: { colorPrimary: '#25382f', colorBackground: '#fffefa', colorText: '#262c29', borderRadius: '8px' },
    elements: { cardBox: { boxShadow: 'none', width: '100%' }, card: { boxShadow: 'none', border: '1px solid #dedfd5' }, footer: { background: 'transparent' } } };
  return <main className="auth-page">
    <nav><Link href="/" className="auth-wordmark">komopdf</Link><select aria-label={t('Language')} value={locale}
      onChange={event => setLocale(event.target.value as 'en' | 'zh-CN')}><option value="en">English</option><option value="zh-CN">简体中文</option></select></nav>
    <section className="auth-card" aria-label={t(signup ? 'Create your account' : 'Sign in to komopdf')}>
      {failure || error ? <><h1>{t('Unable to sign in. Please try again.')}</h1><p role="alert">{t(failure || error)}</p>
        {!params?.get('desktop') ? <a href={complete}>{t('Sign in')}</a> : null}
        {params?.get('desktop') ? <p>{t('Return to the app and start sign-in again.')}</p> : null}</>
        : !ready || !params ? <p role="status">{t('Loading…')}</p>
          : signedIn ? <><h1>{t('Signing you in…')}</h1><p role="status">{t(params.get('desktop') ? 'Returning to komopdf…' : 'Opening your account…')}</p></>
            : signup ? <SignUp routing="hash" appearance={appearance} signInUrl={`/sign-in/${suffix}`} forceRedirectUrl={complete} signInForceRedirectUrl={complete} />
              : <SignIn routing="hash" appearance={appearance} signUpUrl={`/sign-up/${suffix}`} forceRedirectUrl={complete} signUpForceRedirectUrl={complete} />}
    </section>
    <footer><Link href="/privacy/">{t('Privacy')}</Link><Link href="/help/">{t('Help')}</Link></footer>
  </main>;
}
