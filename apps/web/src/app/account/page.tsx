'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@pdf-editor/editor/i18n';
import { AccountProvider, useKomoAccount } from '../../components/account-provider';
import { DesktopBillingReturn } from '../../components/desktop-billing-return';
import './account.css';

export default function AccountPage() { return <DesktopBillingReturn><AccountProvider><AccountContent /></AccountProvider></DesktopBillingReturn>; }
function AccountContent() {
  const { t, locale, setLocale } = useI18n();
  const { account, ready, signedIn, profile, logout, request, refresh, error } = useKomoAccount();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const profileOpened = useRef(false);
  const checkoutConfirmed = useRef(false);
  const [expectedUserId, setExpectedUserId] = useState<string | null>(null);
  const [paramsReady, setParamsReady] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setExpectedUserId(params.get('expectedUserId')); setParamsReady(true);
    const lang = params.get('lang'); if (lang === 'en' || lang === 'zh-CN') setLocale(lang);
  }, [setLocale]);
  const identityMatches = !expectedUserId || account?.userId === expectedUserId;
  const switchAccount = async () => {
    setBusy(true); setMessage('');
    try { await logout(); window.location.replace(`/sign-in/?returnTo=${encodeURIComponent('/account/' + window.location.search)}`); }
    catch { setMessage('Unable to sign out. Please try again.'); }
    finally { setBusy(false); }
  };
  const billing = useCallback(async (kind: 'checkout' | 'portal') => {
    setBusy(true); setMessage('');
    try { const result = await request(`/api/account/${kind}`, {}); window.location.assign(result.url); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to open billing. Please try again.'); }
    finally { setBusy(false); }
  }, [request]);
  useEffect(() => {
    if (ready && !signedIn && !error) window.location.replace(`/sign-in/?returnTo=${encodeURIComponent('/account/' + window.location.search)}`);
    if (!signedIn || !paramsReady || !account || !identityMatches) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('profile') === '1' && !profileOpened.current) { profileOpened.current = true; profile(); }
    const sessionId = params.get('session_id');
    if (!sessionId || params.get('checkout') !== 'success' || checkoutConfirmed.current) return;
    checkoutConfirmed.current = true;
    request('/api/account/checkout/confirm', { sessionId }).then(async confirmed => {
      await refresh(); setMessage(confirmed.plan === 'plus' ? 'KOMO Plus is now active.' : 'Payment is not confirmed yet.');
    }).catch(error => setMessage(error.message));
  }, [ready, signedIn, error, request, refresh, profile, paramsReady, account, identityMatches]);
  const plus = account?.plan === 'plus';
  const manage = plus || Boolean(account && ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'].includes(account.subscriptionStatus ?? ''));
  return <main className="account-page">
    <nav><Link href="/" className="account-wordmark">komopdf</Link>
      <label className="account-language"><span className="sr-only">{t('Language')}</span><select aria-label={t('Language')} value={locale}
        onChange={event => setLocale(event.target.value as 'en' | 'zh-CN')}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      <Link href="/editor/">{t('Open editor')} ↗</Link></nav>
    <header><h1>{t('Your account')}</h1></header>
    {account && paramsReady && !identityMatches ? <section className="account-plan-summary"><div>
      <h2>{t('Switch to your desktop account')}</h2><p>{t('This browser is signed in to a different account.')}</p>
      <p>{account.profile.email}</p></div><button disabled={busy} onClick={() => void switchAccount()}>{t('Switch account')}</button></section>
      : account && paramsReady ? <>
      <section className="account-summary"><div><strong>{account.profile.name || account.profile.email}</strong><p>{account.profile.email}</p></div>
        <button className="account-signout" onClick={profile}>{t('Profile settings')}</button>
        <button className="account-signout" onClick={() => void logout()}>{t('Sign out')}</button></section>
      <section className="account-plan-summary"><div><h2>{plus ? 'KOMO Plus' : t('Free plan')}</h2>
        <p>{plus ? t('Unlimited conversations') : t('{count} credits remaining', { count: account.remainingCredits.toLocaleString(locale, { maximumFractionDigits: 4 }) })}</p>
        <p className="account-fine-print">{t('PDF editing stays free.')}</p></div>
        <button disabled={busy || !account.billingAvailable} onClick={() => void billing(manage ? 'portal' : 'checkout')}>
          {t(busy ? 'Opening…' : account.subscriptionStatus === 'past_due' || account.subscriptionStatus === 'unpaid' ? 'Update payment method' : manage ? 'Manage subscription' : 'Upgrade · $4.99/month')}</button>
      </section>
      {!account.billingAvailable ? <p className="account-fine-print">{t('Subscriptions are currently unavailable. Please try again later.')}</p> : null}
      {account.cancelAtPeriodEnd && account.currentPeriodEnd ? <p>{t('Membership ends on {date}', { date: new Date(account.currentPeriodEnd * 1000).toLocaleDateString(locale) })}</p> : null}
      {account.subscriptionStatus === 'past_due' || account.subscriptionStatus === 'unpaid' ? <p>{t('Update your payment method to continue using Plus.')}</p> : null}
    </> : !error ? <p role="status">{t('Loading…')}</p> : null}
    {message || error ? <p role="status" className="account-message">{t(message || error)}</p> : null}
    <footer><Link href="/privacy/">{t('Privacy')}</Link><Link href="/help/">{t('Help')}</Link></footer>
  </main>;
}
