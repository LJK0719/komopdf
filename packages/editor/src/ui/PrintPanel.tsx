import { useState } from 'react';
import type { EngineAdapter, HostAdapter } from '@pdf-editor/contracts';

export async function printCurrentPdf(engine: EngineAdapter, docId: string, host?: HostAdapter,
  pageIds?: string[], encrypted = false): Promise<'preview' | 'queued'> {
  const protection = encrypted && host?.capabilities.platform !== 'windows' ? 'remove' : 'preserve';
  const result = await engine.save({ docId, protection });
  if (host && host.capabilities.platform !== 'web') {
    if (!host.printDocument) throw new Error('Native PDF printing is not available on this device');
    if (!pageIds?.length) throw new Error('Select a PDF with pages before printing');
    await host.printDocument(result, pageIds);
    return 'queued';
  }
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
  return 'preview';
}

export function PrintPanel({ disabled, docId, pageIds, encrypted, canPrint, engine, host, onBusyChange }: {
  disabled: boolean; docId: string; pageIds: string[]; encrypted: boolean; canPrint: boolean;
  engine: EngineAdapter; host: HostAdapter; onBusyChange(busy: boolean): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function submit() {
    if (disabled || busy || !canPrint) return;
    setBusy(true); onBusyChange(true);
    setError(''); setNotice('');
    try {
      const outcome = await printCurrentPdf(engine, docId, host, pageIds, encrypted);
      setNotice(outcome === 'queued' ? 'PDF submitted to the system print queue; physical output is not verified.'
        : 'PDF print preview opened. This does not confirm a saved document.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Printing failed'); }
    finally { setBusy(false); onBusyChange(false); }
  }

  return <section className="text-edit-panel" aria-label="Print PDF">
    <details><summary>Print</summary>
      <p>{host.capabilities.platform === 'web'
        ? 'Print the current PDF revision using your browser’s PDF viewer. This does not save the document or change its undo history.'
        : 'Send every page of the current PDF revision to the system print queue. Printing does not mark the PDF as saved or change undo history.'}</p>
      <button type="button" disabled={disabled || busy || !canPrint} onClick={() => void submit()}>{busy ? 'Preparing print…' : 'Print PDF'}</button>
      {!canPrint && <p role="status">This PDF does not permit printing or its print permission is unavailable.</p>}
      {encrypted && canPrint && <p role="status">Printing an unlocked protected PDF may create a temporary local unencrypted copy; the active document remains protected.</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  </section>;
}
