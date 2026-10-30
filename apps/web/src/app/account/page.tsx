'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { useI18n } from '@pdf-editor/editor/i18n';
import { SiteNav, SiteFooter } from '../../components/navigation';
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
  const [returnTo, setReturnTo] = useState('/account/');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setExpectedUserId(params.get('expectedUserId')); setParamsReady(true);
    setReturnTo('/account/' + window.location.search);
    const lang = params.get('lang'); if (lang === 'en' || lang === 'zh-CN') setLocale(lang);
  }, [setLocale]);
  const identityMatches = !expectedUserId || account?.userId === expectedUserId;
  const signInUrl = `/sign-in/?returnTo=${encodeURIComponent(returnTo)}`;
  const signUpUrl = `/sign-up/?returnTo=${encodeURIComponent(returnTo)}`;
  const switchAccount = async () => {
    setBusy(true); setMessage('');
    try { await logout(); window.location.replace(`/sign-in/?returnTo=${encodeURIComponent('/account/' + window.location.search)}`); }
    catch { setMessage('Unable to sign out. Please try again.'); }
    finally { setBusy(false); }
  };
  const signOut = async () => {
    setBusy(true); setMessage('');
    try { await logout(); }
    catch { setMessage('Unable to sign out. Please try again.'); }
    finally { setBusy(false); }
  };
  const retryAccount = async () => {
    setBusy(true); setMessage('');
    try { await refresh(); }
    finally { setBusy(false); }
  };
  const billing = useCallback(async (kind: 'checkout' | 'portal') => {
    setBusy(true); setMessage('');
    try { const result = await request(`/api/account/${kind}`, {}); window.location.assign(result.url); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to open billing. Please try again.'); }
    finally { setBusy(false); }
  }, [request]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Opening profile settings still requires sign-in. Browsing plans does not.
    if (ready && !signedIn && !error && paramsReady && params.get('profile') === '1') {
      window.location.replace(`/sign-in/?returnTo=${encodeURIComponent('/account/' + window.location.search)}`);
    }
    if (!signedIn || !paramsReady || !account || !identityMatches) return;
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
  const billingLabel = busy ? 'Opening…' : account?.subscriptionStatus === 'past_due' || account?.subscriptionStatus === 'unpaid' ? 'Update payment method' : manage ? 'Manage subscription' : 'Upgrade to Plus';
  return <main className="site-shell account-page">
    <SiteNav />
    <header className="site-page-heading"><span className="site-kicker">{t('Account & pricing')}</span><h1>{t(signedIn ? 'Your account' : 'Free PDF tools. More with KOMO.')}</h1><p>{t('Edit PDFs for free, without an account. Sign in for KOMO, or choose Plus for unlimited conversations.')}</p></header>
    {account && paramsReady && !identityMatches ? <section className="account-plan-summary account-identity-notice"><div>
      <h2>{t('Switch to your desktop account')}</h2><p>{t('This browser is signed in to a different account.')}</p>
      <p>{account.profile.email}</p></div><button className="site-button site-button-primary" disabled={busy} onClick={() => void switchAccount()}>{t('Switch account')}</button></section>
      : account && paramsReady ? <>
        <section className="account-summary" aria-label={t('Your account')}><div><strong>{account.profile.name || account.profile.email}</strong><p>{account.profile.email}</p></div>
          <div className="account-actions"><button className="site-button site-button-outline" disabled={busy} onClick={profile}>{t('Profile settings')}</button><button className="site-button site-button-outline" disabled={busy} onClick={() => void signOut()}>{t('Sign out')}</button></div></section>
        <section className="account-plan-summary"><div><span className="site-kicker">{t('Your current plan')}</span><h2>{plus ? 'KOMO Plus' : t('Free plan')}</h2>
          <p>{plus ? t('Unlimited conversations') : t('{count} credits remaining', { count: account.remainingCredits.toLocaleString(locale, { maximumFractionDigits: 4 }) })}</p><p className="account-fine-print">{t('PDF editing stays free.')}</p></div>
          <button className="site-button site-button-primary" disabled={busy || !account.billingAvailable} onClick={() => void billing(manage ? 'portal' : 'checkout')}>{t(billingLabel)}</button>
        </section>
        {!account.billingAvailable ? <p className="account-fine-print">{t('Subscriptions are currently unavailable. Please try again later.')}</p> : null}
        {account.cancelAtPeriodEnd && account.currentPeriodEnd ? <p className="account-fine-print">{t('Membership ends on {date}', { date: new Date(account.currentPeriodEnd * 1000).toLocaleDateString(locale) })}</p> : null}
        {account.subscriptionStatus === 'past_due' || account.subscriptionStatus === 'unpaid' ? <p className="account-fine-print">{t('Update your payment method to continue using Plus.')}</p> : null}
      </> : signedIn && !error ? <p className="account-loading" role="status">{t('Loading your account…')}</p> : null}
    {message || error ? <section className="account-message"><p role="status">{t(message || error)}</p>
      {error ? <div className="account-actions">
        <button type="button" className="site-button site-button-outline" disabled={busy || !ready} onClick={() => void retryAccount()}>{t(busy ? 'Loading…' : 'Retry')}</button>
        {signedIn ? <><button type="button" className="site-button site-button-outline" disabled={busy} onClick={() => void switchAccount()}>{t('Sign in again')}</button>
          {!account ? <button type="button" className="site-button site-button-outline" disabled={busy} onClick={() => void signOut()}>{t('Sign out')}</button> : null}</> : null}
      </div> : null}</section> : null}
    <section className="account-pricing" id="plans" aria-labelledby="plans-title">
      <div className="account-section-heading"><h2 id="plans-title">{t('Choose your KOMO plan')}</h2><p>{t('PDF editing stays free.')}</p></div>
      <div className="account-pricing-grid">
        <article className="account-price-card"><span className="site-kicker">{t('Free plan')}</span><h3>{t('For everyday PDF work')}</h3><p className="account-price"><strong>$0</strong><span>{t('/ forever')}</span></p>
          <ul>{['All PDF editing tools', 'No account for PDF editing', '1,000 welcome credits', 'KOMO conversations with credits'].map(label => <li key={label}><Check size={16} aria-hidden="true" />{t(label)}</li>)}</ul>
          <p className="account-fine-print">{t('Welcome credits are added when you create an account.')}</p>
          <Link className="site-button site-button-outline" href="/editor/">{t('Open editor')}<ArrowRight size={16} aria-hidden="true" /></Link>
          {!signedIn ? <Link className="site-text-link account-create-link" href={signUpUrl}>{t('Create your account')}</Link> : null}
        </article>
        <article className="account-price-card account-price-card-plus"><span className="site-kicker">KOMO Plus</span><h3>{t('For more work with KOMO')}</h3><p className="account-price"><strong>$4.99</strong><span>{t('/ month')}</span></p>
          <ul>{['All PDF editing tools', 'Unlimited KOMO conversations', 'Web and desktop access', 'Cancel anytime'].map(label => <li key={label}><Check size={16} aria-hidden="true" />{t(label)}</li>)}</ul>
          <p className="account-fine-print">{t('Billed monthly in USD.')}</p>
          {signedIn ? <button className="site-button site-button-primary" disabled={busy || !paramsReady || !identityMatches || !account?.billingAvailable} onClick={() => void billing(manage ? 'portal' : 'checkout')}>{t(billingLabel)}</button>
            : <Link className="site-button site-button-primary" href={signInUrl}>{t('Sign in to upgrade')}<ArrowRight size={16} aria-hidden="true" /></Link>}
          {!signedIn ? <Link className="site-text-link account-create-link" href={signInUrl}>{t('Already have an account? Sign in')}</Link> : null}
        </article>
      </div>
      <p className="account-plan-note">{t('KolmoPDF parsing and layout-preserving translation use your separate KolmoPDF account balance, not KOMO credits or Plus.')}</p>
    </section>
    <SiteFooter />
  </main>;
}
