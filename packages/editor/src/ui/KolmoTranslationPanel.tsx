import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Download, FileText, FolderOpen, RefreshCw } from 'lucide-react';
import type { DocumentInfo, EditorAiServices, HostAdapter, KolmoConnection, KolmoDocumentInput, KolmoFile, KolmoJob, KolmoSavedJob, KolmoTranslationOptions } from '@pdf-editor/contracts';
import { useI18n } from './i18n.js';

const LANGUAGES = [['en', 'English'], ['zh', '简体中文'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['ru', 'Русский'], ['pt', 'Português']] as const;
const running = (job: KolmoJob | null) => job?.status === 'queued' || job?.status === 'processing';
type Props = { active: boolean; document: DocumentInfo | null; name: string | null; services: EditorAiServices; host: HostAdapter;
  disabled: boolean; prepareDocument(): Promise<KolmoDocumentInput | null>; onOpen(file: KolmoFile, jobId: string): Promise<void>; onResultsReady?: (() => void) | undefined };

export function KolmoTranslationPanel({ active, document, name, services, host, disabled, prepareDocument, onOpen, onResultsReady }: Props) {
  const { t, locale } = useI18n();
  const [connection, setConnection] = useState<KolmoConnection>({ configured: false, points: null });
  const [checking, setChecking] = useState(false);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [key, setKey] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [targetLanguage, setTargetLanguage] = useState(locale.startsWith('zh') ? 'zh' : 'en');
  const [layoutModes, setLayoutModes] = useState<('translated_only' | 'side_by_side')[]>(['translated_only']);
  const [translateImages, setTranslateImages] = useState(false);
  const [translateTables, setTranslateTables] = useState(false);
  const [glossary, setGlossary] = useState<{ name: string; text: string } | undefined>();
  const [jobs, setJobs] = useState<KolmoSavedJob[]>([]);
  const [job, setJob] = useState<KolmoJob | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const resultList = useRef<HTMLDivElement>(null);
  const [jobName, setJobName] = useState('');
  const [files, setFiles] = useState<KolmoFile[]>([]);
  const [waiting, setWaiting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<{ signature: string; input: KolmoDocumentInput; id: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const current = useRef(document); current.current = document;
  const estimated = (document?.pageOrder.length ?? 0) * 2;
  const insufficient = connection.points !== null && connection.points < estimated;
  const refreshJobs = () => services.listKolmoJobs().then(setJobs);
  useEffect(() => {
    if (!active || !services.subscribeKolmoConnection) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void services.subscribeKolmoConnection(() => {
      if (!disposed) setConnectionVersion(version => version + 1);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => { if (!disposed) setError(t('Something went wrong. Please try again.')); });
    return () => { disposed = true; unlisten?.(); };
  }, [active, services]);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController(); setChecking(true);
    void Promise.all([services.kolmoConnection(abort.signal), services.listKolmoJobs()]).then(([status, saved]) => {
      if (!abort.signal.aborted) { setConnection(status); setJobs(saved); }
    }).catch(caught => { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => { if (!abort.signal.aborted) setChecking(false); });
    return () => abort.abort();
  }, [active, services, connectionVersion]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (active && files.length && body.current && resultList.current) {
      body.current.scrollTop += resultList.current.getBoundingClientRect().top - body.current.getBoundingClientRect().top;
    }
  }, [files, active]);
  useEffect(() => {
    if (!active || !waiting || !connection.configured || !job || !running(job)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void services.getKolmoJob(job.id, abort.signal).then(next => {
        if (!abort.signal.aborted) { setJob(next); if (!running(next)) void refreshJobs(); }
      }).catch(caught => {
        if (!abort.signal.aborted) { setWaiting(false); setError(caught instanceof Error ? caught.message : String(caught)); }
      });
    }, 3000);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [job, active, waiting, connection.configured, services]);

  const connect = async (disconnect = false) => {
    if (checking || busy) return;
    setChecking(true); setError(''); setNotice('');
    try {
      setConnection(await services.configureKolmo(disconnect ? '' : key.trim())); setKey('');
      if (disconnect) { setWaiting(false); setFiles([]); setNotice(t('KOLMOPDF disconnected. Existing remote tasks are not cancelled.')); }
      else { setWaiting(true); await refreshJobs(); setNotice(t('KOLMOPDF connected')); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setChecking(false); }
  };
  const start = async () => {
    if (busy || disabled || !document || !connection.configured || !layoutModes.length || !document.permissions.copy) return;
    setBusy(true); setError(''); setNotice('');
    const abort = new AbortController(); request.current = abort;
    try {
      const options: KolmoTranslationOptions = { sourceLanguage, targetLanguage,
        layoutModes: (['translated_only', 'side_by_side'] as const).filter(mode => layoutModes.includes(mode)),
        translateImages, translateTables, ...(glossary ? { glossary } : {}) };
      const signature = JSON.stringify([document.id, document.revision, options]);
      let input = pending.current?.signature === signature ? pending.current.input : await prepareDocument();
      if (!input) return;
      if (input.documentId !== current.current?.id || input.revision !== current.current?.revision) throw new Error('The document changed. Confirm the current version before uploading.');
      if (input.pageCount > 800) throw new Error('KOLMOPDF supports up to 800 pages per translation.');
      if (input.pageCount !== document.pageOrder.length) {
        pending.current = { signature: JSON.stringify([input.documentId, input.revision, options]), input, id: crypto.randomUUID() };
        setNotice(t('The page count changed. Review the updated cost and click Upload and translate again.')); return;
      }
      const snapshotSignature = JSON.stringify([input.documentId, input.revision, options]);
      if (pending.current?.signature !== snapshotSignature) pending.current = { signature: snapshotSignature, input, id: crypto.randomUUID() };
      const created = await services.translateDocument(input, options, pending.current.id, abort.signal);
      setJob(created); setJobName(input.name); setFiles([]); setWaiting(true); setSettingsOpen(false); pending.current = null;
      if (created.remaining_points !== undefined) setConnection(previous => ({ ...previous, points: created.remaining_points! }));
      await refreshJobs();
    } catch (caught) { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); request.current = null; }
  };
  const resume = async (saved?: KolmoSavedJob) => {
    const id = saved?.job.id ?? job?.id;
    if (!id || busy || !connection.configured) return;
    setBusy(true); setError('');
    const abort = new AbortController(); request.current = abort;
    try {
      const next = await services.getKolmoJob(id, abort.signal);
      setJob(next); setWaiting(true);
      if (saved) { setJobName(saved.name); setFiles([]); setSettingsOpen(false); }
      await refreshJobs();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); request.current = null; }
  };
  const cancel = async () => {
    if (!job || busy) return;
    setBusy(true); setError('');
    try { setJob(await services.cancelKolmoJob(job.id)); setWaiting(true); await refreshJobs(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const download = async () => {
    if (!job || busy) return;
    setBusy(true); setError('');
    const abort = new AbortController(); request.current = abort;
    try { setFiles(await services.downloadKolmoResult(job.id, abort.signal)); onResultsReady?.(); await refreshJobs(); }
    catch (caught) { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); request.current = null; }
  };
  const save = async (file: KolmoFile) => {
    if (!host.saveExport) return;
    setError('');
    try {
      const result = await host.saveExport({ ...file, jobId: job?.id ?? crypto.randomUUID(), extension: file.name.split('.').at(-1) ?? 'pdf', warnings: [], pageIndices: [] }, file.name);
      if (result?.status !== 'cancelled') setNotice(t(result?.status === 'written' ? 'File saved' : 'Download started'));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const external = (url: string) => { void host.openExternal(url).catch(caught => setError(caught instanceof Error ? caught.message : String(caught))); };
  const mode = (value: 'translated_only' | 'side_by_side', checked: boolean) => setLayoutModes(previous => checked ? [...previous, value] : previous.filter(item => item !== value));

  return <section className="task-panel kolmo-translation-panel" aria-label={t('Translate entire PDF')}>
    <header className="task-panel-header"><h2>{t('Translate entire PDF')}</h2><p>{t('Preserve the layout with KOLMOPDF')}</p></header>
    <div className="task-panel-body" ref={body}>
      <details className="kolmo-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}><summary>{t('Connection and translation options')}</summary><div className="ai-action-fields">
      <section className="kolmo-connection"><div className="ai-result-heading"><strong>KOLMOPDF</strong><span>{t(checking ? 'Checking connection…' : connection.configured ? 'Connected' : 'Not connected')}</span></div>
        {!connection.configured && <p>{t('Create a KOLMOPDF account and connect your API key to translate PDFs without leaving the editor.')}</p>}
        <div className="kolmo-links"><button className="text-button" type="button" onClick={() => external('https://www.kolmopdf.com/api-keys')}>{t('Register / get API key')} <ExternalLink size={13} /></button>
          <button className="text-button" type="button" onClick={() => external('https://www.kolmopdf.com')}>{t('Use KOLMOPDF website')} <ExternalLink size={13} /></button></div>
        {!connection.configured && <small>{t('Using the website? Save or download the current PDF version first, then upload that copy.')}</small>}
        <details open={!connection.configured}><summary>{t('Service connection')}</summary>
          <label>{t('KOLMOPDF API key')}<input type="password" autoComplete="off" value={key} placeholder="sk-…" onChange={event => setKey(event.target.value)} disabled={checking || busy} /></label>
          <div className="ai-run-row"><button type="button" className="button" disabled={!key.trim() || checking || busy} onClick={() => void connect()}>{t(connection.configured ? 'Update connection' : 'Connect')}</button>
            {connection.configured && <button type="button" className="button" disabled={checking || busy} onClick={() => void connect(true)}>{t('Disconnect')}</button>}</div>
          <small>{t(host.capabilities.platform === 'web' ? 'Your key is kept only for this browser session.' : 'Your key is saved in system credential storage.')}</small>
        </details>
        {connection.configured && connection.points !== null && <p>{t('KOLMOPDF balance: {points} credits', { points: connection.points })}</p>}
      </section>
      <div className="kolmo-document"><FileText size={18} /><strong title={name ?? ''}>{name ?? t('Open a PDF to get started.')}</strong>
        {document && <span>{t('{pages} pages', { pages: document.pageOrder.length })}</span>}</div>
      <div className="ai-language-pair"><label>{t('Source language')}<select value={sourceLanguage} disabled={busy} onChange={event => setSourceLanguage(event.target.value)}>
        {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
        <label>{t('Target language')}<select value={targetLanguage} disabled={busy} onChange={event => setTargetLanguage(event.target.value)}>{LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label></div>
      {sourceLanguage === targetLanguage && <p className="task-help">{t('Choose different source and target languages.')}</p>}
      <fieldset disabled={busy}><legend>{t('Output layout')}</legend>
        <label className="checkbox-row"><input type="checkbox" checked={layoutModes.includes('translated_only')} onChange={event => mode('translated_only', event.target.checked)} />{t('Translated PDF')}</label>
        <label className="checkbox-row"><input type="checkbox" checked={layoutModes.includes('side_by_side')} onChange={event => mode('side_by_side', event.target.checked)} />{t('Bilingual side-by-side PDF')}</label>
      </fieldset>
      <details><summary>{t('Translation options')}</summary>
        <label className="checkbox-row"><input type="checkbox" checked={translateImages} disabled={busy} onChange={event => setTranslateImages(event.target.checked)} />{t('Translate text in images')}</label>
        <label className="checkbox-row"><input type="checkbox" checked={translateTables} disabled={busy} onChange={event => setTranslateTables(event.target.checked)} />{t('Translate tables')}</label>
        <label>{t('Glossary CSV (optional)')}<input type="file" accept=".csv,text/csv" disabled={busy} onChange={event => {
          const file = event.target.files?.[0]; if (!file) { setGlossary(undefined); return; }
          if (file.size > 2 * 1024 * 1024) { setError('The glossary must be a UTF-8 CSV file no larger than 2 MB.'); return; }
          void file.text().then(text => setGlossary({ name: file.name, text })).catch(() => setError('Unable to read the glossary.'));
        }} /></label>{glossary && <button className="text-button" type="button" onClick={() => setGlossary(undefined)}>{t('Remove glossary')}</button>}
      </details>
      <p className="task-help">{t('The current PDF version is uploaded to KOLMOPDF. Your original PDF is not replaced.')}</p>
      {document?.permissions.encrypted && <p className="task-help">{t('The uploaded copy does not include the PDF password protection.')}</p>}
      {document && !document.permissions.copy && <p className="task-error">{t('This PDF does not allow copying its content for translation.')}</p>}
      <p className="kolmo-cost">{t('Estimated KOLMOPDF cost: {points} credits (2 per page). No KOMO credits are used.', { points: estimated })}</p>
      {insufficient && <p className="task-error">{t('Not enough KOLMOPDF credits.')} <button className="text-button" type="button" onClick={() => external('https://www.kolmopdf.com/credits')}>{t('Get KOLMOPDF credits')}</button></p>}
      </div></details>
      {error && <p role="alert" className="task-error">{t(error)}</p>}
      {notice && <p role="status">{notice}</p>}
      {job && <section className="kolmo-job" aria-live="polite"><strong>{jobName}</strong><span>{t(`Translation ${job.status}`)}</span>
        {typeof job.progress === 'number' && <progress max="100" value={job.progress} aria-label={t('Translation progress')} />}
        {job.message && <p>{job.message}</p>}{job.error?.message && <p className="task-error">{job.error.message}</p>}
        <details><summary>{t('Task details')}</summary><small>{job.id}</small></details>
        {running(job) && <><p className="task-help">{t('You can keep working. Closing this panel does not cancel the remote task.')}</p>
          <div className="ai-run-row"><button type="button" className="button" disabled={busy} onClick={() => setWaiting(value => !value)}>{t(waiting ? 'Pause status updates' : 'Resume status updates')}</button>
            <button type="button" className="button" disabled={busy} onClick={() => void cancel()}>{t('Cancel translation')}</button></div></>}
        {job.status === 'succeeded' && <button type="button" className="button button-primary" disabled={busy || !connection.configured} onClick={() => void download()}><Download size={16} />{t('Get translated files')}</button>}
        {!running(job) && job.status !== 'succeeded' && <button type="button" className="button" disabled={busy || !connection.configured} onClick={() => void resume()}><RefreshCw size={16} />{t('Refresh task')}</button>}
      </section>}
      {files.length > 0 && <div className="kolmo-result-files" ref={resultList}>{files.map((file, index) => <article className="kolmo-result-file" key={`${file.name}:${index}`}><strong title={file.location ?? file.name}>{file.name}</strong><div className="ai-run-row">
        {/\.pdf$/i.test(file.name) && <button type="button" className="button" onClick={() => void onOpen(file, job!.id).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))}><FileText size={15} />{t('Open PDF')}</button>}
        <button type="button" className="button" onClick={() => void save(file)}><Download size={15} />{t(host.capabilities.platform === 'web' ? 'Download' : 'Save as…')}</button>
        {file.kind === 'native-file' && host.openSavedFile && <button type="button" className="button" onClick={() => void host.openSavedFile!(file.handle, true).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))}><FolderOpen size={15} />{t('Show in folder')}</button>}
      </div></article>)}</div>}
      {jobs.length > 0 && <details className="kolmo-task-list"><summary>{t('Recent translation tasks')}</summary>{jobs.map(saved => <button type="button" key={saved.job.id} disabled={busy || !connection.configured} onClick={() => void resume(saved)}>
        <strong>{saved.name}</strong><span>{t(`Translation ${saved.job.status}`)}</span></button>)}</details>}
    </div>
    <footer className="task-panel-footer"><button type="button" className="button button-primary" disabled={busy || disabled || checking || (!job && (!connection.configured || !document?.permissions.copy || !layoutModes.length || sourceLanguage === targetLanguage || insufficient))}
      onClick={event => {
        if (event.detail > 1) return;
        if (job) { setJob(null); setFiles([]); setError(''); setSettingsOpen(true); pending.current = null; if (body.current) body.current.scrollTop = 0; setNotice(t('Review the options before starting a new translation.')); }
        else void start();
      }}>{t(busy ? 'Please wait…' : job ? 'New translation' : 'Upload and translate')}</button>
      <small>{t('Uses your KOLMOPDF account. A KOMO subscription does not include these credits.')}</small>
    </footer>
  </section>;
}
