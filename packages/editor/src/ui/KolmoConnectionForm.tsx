import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Link2 } from 'lucide-react';
import type { EditorAiServices, KolmoConnection } from '@pdf-editor/contracts';
import { useI18n } from './i18n.js';

type Props = { services: EditorAiServices; active?: boolean; disabled?: boolean; value?: KolmoConnection;
  onChange?(connection: KolmoConnection): void; openExternal?(url: string): Promise<void> };

export function KolmoConnectionForm({ services, active = true, disabled = false, value, onChange, openExternal }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<KolmoConnection>({ configured: false, points: null });
  const connection = value ?? status;
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const notify = useRef(onChange); notify.current = onChange;
  const update = (value: KolmoConnection) => { setStatus(value); notify.current?.(value); };
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    const refresh = () => services.kolmoConnection(abort.signal).then(value => { if (!abort.signal.aborted) update(value); })
      .catch(caught => { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)); });
    void refresh();
    let unlisten: (() => void) | undefined;
    if (services.subscribeKolmoConnection) void services.subscribeKolmoConnection(() => { void refresh(); })
      .then(stop => { if (abort.signal.aborted) stop(); else unlisten = stop; });
    return () => { abort.abort(); unlisten?.(); };
  }, [services, active]);
  const connect = async (disconnect = false) => {
    setBusy(true); setError('');
    try { update(await services.configureKolmo(disconnect ? '' : key)); setKey(''); setEditing(false); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <section className="kolmo-connection">
    <div className="ai-result-heading"><strong><Link2 size={15} aria-hidden="true" /> KolmoPDF</strong>
      <span>{t(connection.configured ? 'Connected' : 'Not connected')}</span></div>
    {connection.configured && connection.points !== null && <p>{t('KolmoPDF balance: {points} credits', { points: connection.points })}</p>}
    {!connection.configured || editing ? <form className="ai-action-fields" onSubmit={event => { event.preventDefault(); void connect(); }}>
      <label>{t('KolmoPDF API key')}<input type="password" autoComplete="off" value={key} placeholder="sk-…" onChange={event => setKey(event.target.value)} disabled={busy || disabled} /></label>
      <div className="ai-run-row"><button type="submit" className="button button-primary" disabled={!key.trim() || busy || disabled}>{t(busy ? 'Connecting…' : 'Connect')}</button>
        <a className="text-button" href="https://www.kolmopdf.com/api-keys" target="_blank" rel="noopener noreferrer" onClick={event => {
          if (openExternal) { event.preventDefault(); void openExternal(event.currentTarget.href).catch(() => setError('Unable to open the link.')); }
        }}>{t('Get API key')} <ExternalLink size={13} aria-hidden="true" /></a>
        {connection.configured && <button type="button" className="button" disabled={busy || disabled} onClick={() => void connect(true)}>{t('Disconnect')}</button>}
      </div>
    </form> : <button type="button" className="text-button" onClick={() => setEditing(true)}>{t('Manage connection')}</button>}
    {error && <p className="task-error" role="alert">{t(error)}</p>}
  </section>;
}
