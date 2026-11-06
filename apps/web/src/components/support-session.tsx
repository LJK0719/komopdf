'use client';
import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useI18n } from '@pdf-editor/editor/i18n';
import { localizedPath } from '@pdf-editor/editor/i18n-locales';
import { supportCopy } from '@pdf-editor/editor/support-copy';
import { browserSupportClient } from '@pdf-editor/editor/support-client';
import { AccountProvider, useKomoAccount } from './account-provider';
const Panel = dynamic(() => import('@pdf-editor/editor/support-panel').then(module => module.SupportPanel), { ssr: false });
const Desk = dynamic(() => import('@pdf-editor/editor/support-admin').then(module => module.SupportDesk), { ssr: false });
function Customer({ open, close }: { open: boolean; close(): void }) {
  const { locale } = useI18n(); const { ready, userId, signedIn, authenticatedFetch } = useKomoAccount();
  const client = useMemo(() => browserSupportClient(locale, signedIn ? authenticatedFetch : fetch), [locale, signedIn, authenticatedFetch]);
  return ready ? <Panel key={`${userId || 'guest'}:${locale}`} open={open} onClose={close} client={client} copy={supportCopy(locale)} product="komopdf" adminHref={localizedPath('/admin/support/',locale)} /> : null;
}
export function SupportCustomerSession({ open, close }: { open: boolean; close(): void }) { return <AccountProvider><Customer open={open} close={close} /></AccountProvider>; }
function AdminContent() {
  const { locale } = useI18n(); const { ready, userId, signedIn, authenticatedFetch } = useKomoAccount();
  const client = useMemo(() => browserSupportClient(locale, signedIn ? authenticatedFetch : fetch), [locale, signedIn, authenticatedFetch]);
  return ready ? <Desk key={userId || 'guest'} client={client} copy={supportCopy(locale)} signInHref={localizedPath('/sign-in/',locale)} /> : null;
}
export function SupportAdminSession() { return <AccountProvider><AdminContent /></AccountProvider>; }
