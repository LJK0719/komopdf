'use client';

import * as React from 'react';
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

  if (!instances) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#1b1d1b] text-[#f7f5ed]">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#d7ff37] border-t-transparent" />
          <span className="text-sm font-medium tracking-wide">Initializing komopdf WebAssembly core...</span>
        </div>
      </div>
    );
  }

  return <EditorShell engine={instances.engine} host={instances.host} />;
}
