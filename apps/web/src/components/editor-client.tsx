'use client';

import * as React from 'react';
import { EditorLoading } from './editor-loading';
import { EditorShell, WasmEngineAdapter, WebHostAdapter, WorkerRpcClient } from '@pdf-editor/editor';

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

  return <EditorShell engine={instances.engine} host={instances.host} />;
}
