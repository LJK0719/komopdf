'use client';

import * as React from 'react';
import { EditorLoading } from './editor-loading';
import { EditorShell, KomoChatPanel, WasmEngineAdapter, WebHostAdapter, WorkerRpcClient, createKomoChatStore, type KomoChatStore, type EditorAiContext } from '@pdf-editor/editor';
import { AccountProvider, AccountStrip, useKomoAccount } from './account-provider';
import '../app/account/account.css';

function AccountIdentity({ onChange }: { onChange(owner: string | null | undefined): void }) {
  const { userId } = useKomoAccount();
  React.useEffect(() => onChange(userId), [userId, onChange]);
  return null;
}

function AccountChat({ context, store }: { context: EditorAiContext; store: KomoChatStore }) {
  const { account, signedIn, ready, authenticatedFetch, refresh } = useKomoAccount();
  // Hide a known owner's private draft/history until the next identity is known.
  const identityPending = store.owner != null && (!ready || (signedIn && !account));
  const sessionOwner = account?.userId ?? (!signedIn && ready ? null : undefined);
  return <><AccountStrip /><div className="komo-account-chat" hidden={identityPending}><KomoChatPanel store={store} {...(sessionOwner !== undefined ? { sessionOwner } : {})}
    context={{ ...context, handoff: identityPending ? null : context.handoff ?? null,
      disabled: context.disabled || !signedIn || !account || (account.plan === 'free' && account.remainingCredits <= 0) }}
    disabledReason={!signedIn ? 'Sign in to start using KOMO.' : !account ? 'Your account is currently unavailable.' : account.plan === 'free' && account.remainingCredits <= 0 ? 'Not enough credits. Open Account to continue.' : undefined}
    fetch={authenticatedFetch} onComplete={() => void refresh()} /></div></>;
}

export default function EditorClient() {
  const [preferenceOwner, setPreferenceOwner] = React.useState<string | null | undefined>(undefined);
  const [chatStore] = React.useState(createKomoChatStore);
  const [instances, setInstances] = React.useState<{
    engine: WasmEngineAdapter;
    host: WebHostAdapter;
  } | null>(null);

  React.useEffect(() => {
    // In browser, instantiate the dedicated WebAssembly worker
    const worker = new Worker(new URL('/engines/engine.worker.js', window.location.origin), {
      type: 'module',
      name: 'pdf-core',
    });
    const rpc = new WorkerRpcClient(worker);
    const engine = new WasmEngineAdapter(rpc);
    const host = new WebHostAdapter();

    setInstances({ engine, host });

    const onPageHide = () => {
      engine.dispose();
      worker.terminate();
    };
    window.addEventListener('pagehide', onPageHide, { once: true });

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      engine.dispose();
      worker.terminate();
    };
  }, []);

  if (!instances) return <EditorLoading />;

  return <EditorShell preferenceOwner={preferenceOwner} engine={instances.engine} host={instances.host}
    renderAiPanel={context => <AccountProvider><AccountIdentity onChange={setPreferenceOwner} /><AccountChat context={context} store={chatStore} /></AccountProvider>} />;
}
