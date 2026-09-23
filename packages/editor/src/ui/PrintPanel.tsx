import { useState } from 'react';
import type { EngineAdapter } from '@pdf-editor/contracts';

export async function printCurrentPdf(engine: EngineAdapter, docId: string): Promise<void> {
  const result = await engine.save({ docId, protection: 'preserve' });
  if (result.kind !== 'bytes') throw new Error('Browser printing requires PDF bytes');

  const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/pdf' }));
  const frame = document.createElement('iframe');
  frame.title = 'PDF print preview';
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0';
  frame.src = url;

  await new Promise<void>((resolve, reject) => {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (cleanupTimer) clearTimeout(cleanupTimer);
      window.removeEventListener('afterprint', cleanup);
      frame.remove();
      URL.revokeObjectURL(url);
    };
    frame.addEventListener('load', () => {
      const printWindow = frame.contentWindow;
      if (!printWindow) {
        cleanup();
        reject(new Error('PDF print window unavailable'));
        return;
      }
      printWindow.addEventListener('afterprint', cleanup, { once: true });
      window.addEventListener('afterprint', cleanup, { once: true });
      cleanupTimer = setTimeout(cleanup, 60_000);
      try {
        printWindow.focus();
        printWindow.print();
        resolve();
      } catch (error) {
        cleanup();
        reject(error);
      }
    }, { once: true });
    frame.addEventListener('error', () => {
      cleanup();
      reject(new Error('PDF print preview could not open'));
    }, { once: true });
    document.body.appendChild(frame);
  });
}

export function PrintPanel({ disabled, docId, engine }: {
  disabled: boolean; docId: string; engine: EngineAdapter;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (disabled || busy) return;
    setBusy(true);
    setError('');
    try { await printCurrentPdf(engine, docId); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Printing failed'); }
    finally { setBusy(false); }
  }

  return <section className="text-edit-panel" aria-label="Print PDF">
    <details><summary>Print</summary>
      <p>Print the current PDF revision using your browser’s PDF viewer. This does not save the document or change its undo history.</p>
      <button type="button" disabled={disabled || busy} onClick={() => void submit()}>{busy ? 'Preparing print…' : 'Print PDF'}</button>
      {error && <p role="alert">{error}</p>}
    </details>
  </section>;
}
