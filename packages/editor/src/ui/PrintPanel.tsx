import { translate as t, useI18n } from './i18n.js';
import { useEffect, useState } from 'react';
import type { EngineAdapter, HostAdapter } from '@pdf-editor/contracts';
import { selectPrintPages } from './print-settings.js';

export async function printCurrentPdf(engine: EngineAdapter, docId: string, host?: HostAdapter,
  pageIds?: string[], encrypted = false, copies = 1): Promise<'preview' | 'queued'> {
  const native = host && host.capabilities.platform !== 'web';
  if (native && !host.printDocument) throw new Error('Native PDF printing is not available on this device');
  if (native && !pageIds?.length) throw new Error('Select a PDF with pages before printing');
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) throw new Error('Choose between 1 and 99 copies');
  const protection = encrypted && host?.capabilities.platform !== 'windows' ? 'remove' : 'preserve';
  const result = await engine.save({ docId, protection });
  if (native) {
    await host.printDocument!(result, pageIds!, { copies });
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

export function PrintPanel({ disabled, docId, pageIds, currentPageId, encrypted, canPrint, engine, host, onBusyChange }: {
  disabled: boolean; docId: string; pageIds: string[]; currentPageId?: string; encrypted: boolean; canPrint: boolean;
  engine: EngineAdapter; host: HostAdapter; onBusyChange(busy: boolean): void;
}) {
  useI18n();
  const native = host.capabilities.platform !== 'web';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scope, setScope] = useState<'all' | 'current' | 'range'>('all');
  const [range, setRange] = useState('');
  const [copies, setCopies] = useState('1');
  useEffect(() => { setScope('all'); setRange(''); setError(''); setNotice(''); }, [docId]);
  useEffect(() => { setError(''); setNotice(''); }, [scope, range, copies, currentPageId]);
  let selected: string[] = pageIds;
  let validation = '';
  try {
    if (native) selected = selectPrintPages(scope, range, pageIds, currentPageId ?? pageIds[0] ?? '');
    if (native && (!Number.isInteger(Number(copies)) || Number(copies) < 1 || Number(copies) > 99))
      validation = 'Choose between 1 and 99 copies';
  } catch (caught) { validation = caught instanceof Error ? caught.message : 'Invalid page range'; }

  async function submit() {
    if (disabled || busy || !canPrint || validation) return;
    setBusy(true); onBusyChange(true);
    setError(''); setNotice('');
    try {
      const outcome = await printCurrentPdf(engine, docId, host, selected, encrypted, native ? Number(copies) : 1);
      setNotice(outcome === 'queued' ? 'Sent to the system print queue. Check the printer for completion.'
        : 'Print preview opened.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Printing failed'); }
    finally { setBusy(false); onBusyChange(false); }
  }

  return <section className="text-edit-panel" aria-label={t('Print PDF')}>
    <details open><summary>{t('Print')}</summary>
      {native ? <>
        <p><strong>{t('Printer')}: </strong>{t('System default printer')}</p>
        <p className="muted">{t('To use a different printer, change the default in system settings before printing.')}</p>
        <label>{t('Pages to print')}
          <select value={scope} disabled={disabled || busy} onChange={event => setScope(event.target.value as typeof scope)}>
            <option value="all">{t('All pages')}</option>
            <option value="current">{t('Current page')} ({pageIds.indexOf(currentPageId ?? pageIds[0] ?? '') + 1})</option>
            <option value="range">{t('Page range')}</option>
          </select>
        </label>
        {scope === 'range' && <label>{t('Page range')}
          <input autoFocus value={range} placeholder="1-3,5" disabled={disabled || busy}
            aria-invalid={Boolean(validation)} aria-describedby="print-range-help"
            onChange={event => setRange(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
            }} />
        </label>}
        <p id="print-range-help" className="muted">{t('Pages print once each in document order.')}</p>
        <label>{t('Copies')}<input type="number" min={1} max={99} step={1} value={copies}
          disabled={disabled || busy} onChange={event => setCopies(event.target.value)} /></label>
        {!validation && <p role="status">{t('{count} pages × {copies} copies', { count: selected.length, copies })}</p>}
      </> : <p className="muted">{t('Choose the printer, pages and copies in the browser print dialog.')}</p>}
      {validation && <p role="status">{t(validation)}</p>}
      <button type="button" disabled={disabled || busy || !canPrint || !pageIds.length || Boolean(validation)} onClick={() => void submit()}>
        {busy ? t('Preparing print…') : native ? t('Print PDF') : t('Open print dialog')}
      </button>
      {!canPrint && <p role="status">{t('This PDF does not permit printing or its print permission is unavailable.')}</p>}
      {notice && <p role="status">{t(notice)}</p>}
      {error && <p role="alert">{t(error)}</p>}
    </details>
  </section>;
}
