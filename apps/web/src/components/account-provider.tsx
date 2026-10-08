'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ClerkProvider, useAuth, useClerk } from '@clerk/react';
import { enUS, zhCN } from '@clerk/localizations';
import { useI18n } from '@pdf-editor/editor/i18n';

export type KomoAccount = { userId: string; plan: 'free' | 'plus'; freeCredits: number; usedCredits: number;
  remainingCredits: number; tokensPerCredit: number; subscriptionStatus: string | null;
  currentPeriodEnd: number | null; cancelAtPeriodEnd: boolean };
type AccountContextValue = { account: KomoAccount | null; ready: boolean; signedIn: boolean;
  error: string; refresh(): Promise<void>; login(): void; profile(): void; logout(): Promise<void>;
  request(path: string, body?: unknown): Promise<any>; authenticatedFetch: typeof fetch };
const Context = createContext<AccountContextValue | null>(null);
export function useKomoAccount() {
  const value = useContext(Context);
  if (!value) throw new Error('Account provider is missing');
  return value;
}
export function AccountProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/account/config', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('KOMO is currently unavailable. Please try again later.');
      const data = await response.json(); if (active) setKey(data.publishableKey);
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  if (!key) return <Context.Provider value={{ account: null, signedIn: false, ready: Boolean(error), error,
    refresh: async () => {}, login: () => {}, profile: () => {}, logout: async () => {}, authenticatedFetch: fetch,
    request: async () => { throw new Error(error || 'Loading account service…'); } }}>{children}</Context.Provider>;
  return <ClerkProvider publishableKey={key} localization={locale === 'zh-CN' ? zhCN : enUS}><ConnectedAccount>{children}</ConnectedAccount></ClerkProvider>;
}
function ConnectedAccount({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken, userId } = useAuth();
  const clerk = useClerk();
  const [loadedAccount, setAccount] = useState<KomoAccount | null>(null);
  const account = loadedAccount?.userId === userId ? loadedAccount : null;
  const currentUser = useRef(userId); currentUser.current = userId;
  const [error, setError] = useState('');
  const authenticatedFetch = useCallback<typeof fetch>(async (input, init) => {
    const token = await getToken();
    if (!token) return Response.json({ error: { code: 'SIGN_IN_REQUIRED', message: 'Sign in to continue.' } }, { status: 401 });
    const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers, cache: 'no-store' });
  }, [getToken]);
  const request = useCallback(async (path: string, body?: unknown) => {
    const response = await authenticatedFetch(path, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Account request failed.');
    return data;
  }, [authenticatedFetch]);
  const refresh = useCallback(async () => {
    if (!isSignedIn) { setAccount(null); return; }
    try {
      const snapshot = await request('/api/account');
      if (currentUser.current === userId) { setAccount(snapshot); setError(''); }
    } catch (error) {
      if (currentUser.current === userId) setError(error instanceof Error ? error.message : 'Account service unavailable');
    }
  }, [isSignedIn, userId, request]);
  useEffect(() => { setAccount(null); void refresh(); }, [userId, refresh]);
  useEffect(() => {
    const focus = () => void refresh(); window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [refresh]);
  return <Context.Provider value={{ account, ready: Boolean(isLoaded), signedIn: Boolean(isSignedIn), error, request, refresh,
    login: () => { clerk.openSignIn(); }, profile: () => { clerk.openUserProfile(); }, logout: async () => { await clerk.signOut(); setAccount(null); }, authenticatedFetch }}>{children}</Context.Provider>;
}
export function AccountStrip() {
  const { account, signedIn, login, error } = useKomoAccount();
  const { t } = useI18n();
  return <div className="komo-account-strip">
    <span>{account ? account.plan === 'plus' ? 'KOMO Plus' : t('{count} credits left', { count: Math.floor(account.remainingCredits).toLocaleString() })
      : t(signedIn ? 'Loading credits…' : '1,000 free credits · PDF tools always free')}</span>
    {signedIn ? <a href="/account/" target="_blank" rel="noreferrer">{t(account?.plan === 'plus' ? 'Account' : 'Plus · $4.99/mo')}</a>
      : <button type="button" disabled={Boolean(error)} onClick={login}>{t('Sign in')}</button>}
    {error ? <p role="status">{t(error)}</p> : null}
  </div>;
}
