'use client';

import * as React from 'react';
import { EditorLoading } from './editor-loading';
import { EditorShell, KomoChatPanel, WasmEngineAdapter, WebHostAdapter, WorkerRpcClient, type EditorAiContext } from '@pdf-editor/editor';
import { AccountProvider, AccountStrip, useKomoAccount } from './account-provider';
import '../app/account/account.css';

function AccountChat({ context }: { context: EditorAiContext }) {
  const { account, signedIn, authenticatedFetch, refresh } = useKomoAccount();
  return <><AccountStrip /><KomoChatPanel key={signedIn ? account?.userId ?? 'loading-account' : 'signed-out'} context={{ ...context, disabled: context.disabled || !signedIn || !account || (account.plan === 'free' && account.remainingCredits <= 0) }}
    fetch={authenticatedFetch} onComplete={() => void refresh()} /></>;
}

export default function EditorClient() {
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

  return <EditorShell engine={instances.engine} host={instances.host}
    renderAiPanel={context => <AccountProvider><AccountChat context={context} /></AccountProvider>} />;
}
