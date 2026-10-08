'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@pdf-editor/editor/i18n';
import { AccountProvider, useKomoAccount } from '../../components/account-provider';
import './account.css';

export default function AccountPage() { return <AccountProvider><AccountPageContent /></AccountProvider>; }
function AccountPageContent() {
  const { t, locale, setLocale } = useI18n();
  const { account, ready, signedIn, login, profile, logout, request, refresh, error } = useKomoAccount();
  const [device, setDevice] = useState('');
  const [deviceApproved, setDeviceApproved] = useState(false);
  const [checkoutRequested, setCheckoutRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const billing = useCallback(async (kind: 'checkout' | 'portal') => {
    setBusy(true); setMessage('');
    try { const result = await request(`/api/account/${kind}`, {}); window.location.assign(result.url); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to open billing. Please try again.'); }
    finally { setBusy(false); }
  }, [request]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setDevice(params.get('device') || '');
    const sessionId = params.get('session_id');
    if (!signedIn || !sessionId || params.get('checkout') !== 'success') return;
    let active = true;
    request('/api/account/checkout/confirm', { sessionId }).then(async confirmed => {
      await refresh(); if (active) setMessage(confirmed.plan === 'plus' ? 'KOMO Plus is now active.' : 'Payment is not confirmed yet.');
    }).catch(error => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, [signedIn, request, refresh]);
  useEffect(() => {
    if (!checkoutRequested || !signedIn || !account) return;
    setCheckoutRequested(false);
    void billing(account.plan === 'plus' ? 'portal' : 'checkout');
  }, [checkoutRequested, signedIn, account, billing]);
  const upgrade = () => {
    if (signedIn) void billing(account?.plan === 'plus' ? 'portal' : 'checkout');
    else { setCheckoutRequested(true); login(); }
  };
  const signIn = () => { setCheckoutRequested(false); login(); };
  const approve = async () => {
    setBusy(true); setMessage('');
    try {
      await request('/api/account/device/approve', { code: device });
      setDeviceApproved(true); setMessage('Signed in. You can return to komopdf.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to sign in. Please try again.'); }
    finally { setBusy(false); }
  };
  const plus = account?.plan === 'plus';
  return <main className="account-page">
    <nav><Link href="/" className="account-wordmark">komopdf<span> / {t('Account')}</span></Link>
      <label className="account-language"><span className="sr-only">{t('Language')}</span><select aria-label={t('Language')} value={locale}
        onChange={event => setLocale(event.target.value as 'en' | 'zh-CN')}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      <Link href="/editor/">{t('Open editor')} ↗</Link></nav>
    <header><h1>{t(signedIn ? 'Your account' : 'Choose your KOMO plan')}</h1>
      <p>{t(signedIn ? 'Manage your plan and connected services.' : 'Get help with your documents. PDF editing is always free.')}</p></header>
    {device ? <section className="device-approval"><h2>{t(deviceApproved ? 'Desktop connected' : 'Sign in to komopdf')}</h2>
      {!deviceApproved ? <><p>{t('Confirm the code shown in your desktop app.')}</p><code>{device}</code></> : null}
      <button disabled={!ready || busy || deviceApproved || Boolean(error)} onClick={() => signedIn ? void approve() : signIn()}>
        {t(deviceApproved ? 'Connected' : signedIn ? 'Continue' : 'Sign in')}</button></section> : null}
    {signedIn ? <section className="account-summary"><div><strong>{plus ? 'KOMO Plus' : t('Free plan')}</strong>
      <p>{plus ? t('Unlimited conversations') : account ? t('{count} credits remaining', { count: Math.floor(account.remainingCredits).toLocaleString(locale) }) : t('Loading…')}</p></div>
      <button className="account-signout" disabled={busy} onClick={profile}>{t('Profile settings')}</button>
      <button className="account-signout" disabled={busy} onClick={() => void logout()}>{t('Sign out')}</button></section> : null}
    <div className="account-plans">
      <section><h2>{t('Free')}</h2><p className="plan-price">$0 <span>{t('/ forever')}</span></p>
        <ul>{['All PDF editing tools', '1,000 welcome credits', 'KOMO conversations with credits'].map(item => <li key={item}>{t(item)}</li>)}</ul>
        {!signedIn ? <button disabled={!ready || Boolean(error)} onClick={signIn}>{t('Get started')}</button> : <p>{t(plus ? 'PDF editing stays free.' : 'Your current plan')}</p>}
      </section>
      <section className="plus-plan"><h2>KOMO Plus</h2><p className="plan-price">$4.99 <span>{t('/ month')}</span></p>
        <ul>{['Unlimited KOMO conversations', 'Web and desktop access', 'Cancel anytime'].map(item => <li key={item}>{t(item)}</li>)}</ul>
        <button disabled={busy || !ready || Boolean(error)} onClick={upgrade}>{t(busy ? 'Opening…' : plus ? 'Manage subscription' : 'Upgrade to Plus')}</button>
        <p>{t('Billed monthly in USD.')}</p>
      </section>
    </div>
    <section className="account-reading"><h2>{t('Full-text reading with KolmoPDF')}</h2>
      <p>{t('Connect KolmoPDF in desktop settings to read papers and books with KOMO.')}</p>
      <p className="account-fine-print">{t('KolmoPDF parsing is billed separately.')}</p>
      <a href="https://www.kolmopdf.com/api-keys" target="_blank" rel="noreferrer">{t('Get an API key')} ↗</a>
    </section>
    {account?.cancelAtPeriodEnd && account.currentPeriodEnd ? <p>{t('Membership ends on {date}', { date: new Date(account.currentPeriodEnd * 1000).toLocaleDateString(locale) })}</p> : null}
    {account?.subscriptionStatus === 'past_due' || account?.subscriptionStatus === 'unpaid' ? <p>{t('Update your payment method to continue using Plus.')} <button disabled={busy} onClick={() => void billing('portal')}>{t('Update payment method')}</button></p> : null}
    {message || error ? <p role="status" className="account-message">{t(message || error)}</p> : null}
    <footer><Link href="/privacy/">{t('Privacy')}</Link><Link href="/help/">{t('Help')}</Link></footer>
  </main>;
}
