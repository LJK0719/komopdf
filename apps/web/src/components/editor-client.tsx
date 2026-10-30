'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { EditorLoading } from './editor-loading';
import { EditorShell, WasmEngineAdapter, WebHostAdapter, WorkerRpcClient } from '@pdf-editor/editor';

const EditorAccountPanel = dynamic(() => import('./editor-account-panel'), { ssr: false });
const EditorAccountIdentity = dynamic(() => import('./editor-account-panel').then(module => module.EditorAccountIdentity), { ssr: false });

export default function EditorClient() {
  const [preferenceOwner, setPreferenceOwner] = React.useState<string | null | undefined>(undefined);
  const [identityNeeded, setIdentityNeeded] = React.useState(false);
  const onDocumentChange = React.useCallback(({ document }: { document: unknown }) => { if (document) setIdentityNeeded(true); }, []);
  const [instances, setInstances] = React.useState<{
    engine: WasmEngineAdapter;
    host: WebHostAdapter;
  } | null>(null);

  React.useEffect(() => {
    const worker = new Worker(new URL('/engines/engine.worker.js', window.location.origin), {
      type: 'module', name: 'pdf-core',
    });
    const rpc = new WorkerRpcClient(worker);
    const engine = new WasmEngineAdapter(rpc);
    const host = new WebHostAdapter();
    setInstances({ engine, host });

    // The same handshake is reused by the first document request.
    const warmup = () => { void rpc.handshake().catch(() => undefined); };
    const supportsIdle = typeof window.requestIdleCallback === 'function';
    const idle = supportsIdle ? window.requestIdleCallback(warmup) : window.setTimeout(warmup, 200);
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) engine.dispose();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      if (supportsIdle) window.cancelIdleCallback(idle); else window.clearTimeout(idle);
      window.removeEventListener('pagehide', onPageHide);
      engine.dispose();
    };
  }, []);

  if (!instances) return <EditorLoading />;
  return <>
    {identityNeeded && <EditorAccountIdentity onOwner={setPreferenceOwner} />}
    <EditorShell preferenceOwner={preferenceOwner} engine={instances.engine} host={instances.host} onDocumentChange={onDocumentChange}
      renderAiPanel={context => <EditorAccountPanel context={context} onOwner={setPreferenceOwner} />} />
  </>;
}
