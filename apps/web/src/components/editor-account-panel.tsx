'use client';

import { useEffect, useState } from 'react';
import { KomoChatPanel, createKomoChatStore, type KomoChatStore, type EditorAiContext } from '@pdf-editor/editor';
import { AccountProvider, AccountStrip, useKomoAccount } from './account-provider';
import '../app/account/account.css';

function AccountChat({ context, store, onOwner }: { context: EditorAiContext; store: KomoChatStore; onOwner(owner: string | null | undefined): void }) {
  const { userId, account, signedIn, ready, authenticatedFetch, refresh } = useKomoAccount();
  useEffect(() => onOwner(userId), [userId, onOwner]);
  const identityPending = store.owner != null && (!ready || (signedIn && !account));
  const sessionOwner = account?.userId ?? (!signedIn && ready ? null : undefined);
  return <><AccountStrip /><div className="komo-account-chat" hidden={identityPending}><KomoChatPanel store={store} {...(sessionOwner !== undefined ? { sessionOwner } : {})}
    context={{ ...context, handoff: identityPending ? null : context.handoff ?? null,
      disabled: context.disabled || !signedIn || !account || (account.plan === 'free' && account.remainingCredits <= 0) }}
    disabledReason={!signedIn ? 'Sign in to start using KOMO.' : !account ? 'Your account is currently unavailable.' : account.plan === 'free' && account.remainingCredits <= 0 ? 'Not enough credits. Open Account to continue.' : undefined}
    fetch={authenticatedFetch} onComplete={() => void refresh()} /></div></>;
}

function Identity({ onOwner }: { onOwner(owner: string | null | undefined): void }) {
  const { userId } = useKomoAccount();
  useEffect(() => onOwner(userId), [userId, onOwner]);
  return null;
}
export function EditorAccountIdentity({ onOwner }: { onOwner(owner: string | null | undefined): void }) {
  return <AccountProvider><Identity onOwner={onOwner} /></AccountProvider>;
}

export default function EditorAccountPanel({ context, onOwner }: { context: EditorAiContext; onOwner(owner: string | null | undefined): void }) {
  const [store] = useState(createKomoChatStore);
  return <AccountProvider><AccountChat context={context} store={store} onOwner={onOwner} /></AccountProvider>;
}
