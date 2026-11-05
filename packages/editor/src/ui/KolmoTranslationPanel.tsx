import { useEffect, useRef, useState } from 'react';
import { Download, FileText, FolderOpen, RefreshCw } from 'lucide-react';
import type { DocumentInfo, EditorAiServices, HostAdapter, KolmoConnection, KolmoDocumentInput, KolmoFile, KolmoJob, KolmoSavedJob, KolmoTranslationOptions } from '@pdf-editor/contracts';
import { KolmoConnectionForm } from './KolmoConnectionForm.js';
import { useI18n } from './i18n.js';

const LANGUAGES = [['en', 'English'], ['zh', '简体中文'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['ru', 'Русский'], ['pt', 'Português']] as const;
const running = (job: KolmoJob | null) => job?.status === 'queued' || job?.status === 'processing';
type Props = { active: boolean; document: DocumentInfo | null; name: string | null; services: EditorAiServices; host: HostAdapter;
  disabled: boolean; prepareDocument(): Promise<KolmoDocumentInput | null>; onOpen(file: KolmoFile, jobId: string): Promise<void>; onResultsReady?: (() => void) | undefined };

export function KolmoTranslationPanel({ active, document, name, services, host, disabled, prepareDocument, onOpen, onResultsReady }: Props) {
  const { t, locale } = useI18n();
  const [connection, setConnection] = useState<KolmoConnection>({ configured: false, points: null });
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
  const estimated = (document?.pageOrder.length ?? 0) * 2;
  const insufficient = connection.points !== null && connection.points < estimated;
  const refreshJobs = () => services.listKolmoJobs().then(saved => setJobs(saved.filter(item => item.operation !== 'parse')));
  const receiveFiles = async (id: string, signal: AbortSignal) => {
    const result = await services.downloadKolmoResult(id, signal);
    signal.throwIfAborted(); setFiles(result); onResultsReady?.();
  };
  useEffect(() => {
    if (active) void refreshJobs().catch(caught => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [active, services]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (active && files.length && body.current && resultList.current) body.current.scrollTop += resultList.current.getBoundingClientRect().top - body.current.getBoundingClientRect().top;
  }, [files, active]);
  useEffect(() => {
    if (!active || !waiting || !connection.configured || !job || !running(job)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void services.getKolmoJob(job.id, abort.signal).then(async next => {
        if (abort.signal.aborted) return;
        if (next.status === 'succeeded') await receiveFiles(next.id, abort.signal);
        if (abort.signal.aborted) return;
        setJob(next);
        if (!running(next)) await refreshJobs();
      }).catch(caught => {
        if (!abort.signal.aborted) { setWaiting(false); setError(caught instanceof Error ? caught.message : String(caught)); }
      });
    }, 3000);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [job, active, waiting, connection.configured, services]);

  const start = async () => {
    if (busy || disabled || !document || !connection.configured || !layoutModes.length || !document.permissions.copy) return;
    setBusy(true); setError(''); setNotice('');
    const abort = new AbortController(); request.current = abort;
    try {
      const options: KolmoTranslationOptions = { sourceLanguage, targetLanguage,
        layoutModes: (['translated_only', 'side_by_side'] as const).filter(mode => layoutModes.includes(mode)),
        translateImages, translateTables, ...(glossary ? { glossary } : {}) };
      const signature = JSON.stringify([document.id, document.revision, options]);
      const input = pending.current?.signature === signature ? pending.current.input : await prepareDocument();
      if (!input) return;
      const snapshotSignature = JSON.stringify([input.documentId, input.revision, options]);
      if (pending.current?.signature !== snapshotSignature) pending.current = { signature: snapshotSignature, input, id: crypto.randomUUID() };
      const created = await services.translateDocument(input, options, pending.current.id, abort.signal);
      setJob(created); setJobName(input.name); setFiles([]); setWaiting(true); setSettingsOpen(false); pending.current = null;
      if (created.remaining_points !== undefined) setConnection(previous => ({ ...previous, points: created.remaining_points! }));
      if (created.status === 'succeeded') await receiveFiles(created.id, abort.signal);
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
      if (next.status === 'succeeded') await receiveFiles(id, abort.signal);
      await refreshJobs();
    } catch (caught) { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)); }
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
    try { await receiveFiles(job.id, abort.signal); await refreshJobs(); }
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
  const mode = (value: 'translated_only' | 'side_by_side', checked: boolean) => setLayoutModes(previous => checked ? [...previous, value] : previous.filter(item => item !== value));

  return <section className="task-panel kolmo-translation-panel" aria-label={t('Translate PDF')}>
    <header className="task-panel-header"><h2>{t('Translate PDF')}</h2></header>
    <div className="task-panel-body" ref={body}>
      <details className="kolmo-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}><summary>{t('Translation options')}</summary><div className="ai-action-fields">
        <KolmoConnectionForm services={services} active={active} disabled={busy} value={connection} onChange={setConnection} openExternal={url => host.openExternal(url)} />
        <div className="kolmo-document"><FileText size={18} /><strong title={name ?? ''}>{name ?? t('Open a PDF to get started.')}</strong>{document && <span>{t('{pages} pages', { pages: document.pageOrder.length })}</span>}</div>
        <div className="ai-language-pair"><label>{t('Source language')}<select value={sourceLanguage} disabled={busy} onChange={event => setSourceLanguage(event.target.value)}>
          {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
          <label>{t('Target language')}<select value={targetLanguage} disabled={busy} onChange={event => setTargetLanguage(event.target.value)}>{LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label></div>
        {sourceLanguage === targetLanguage && <p className="task-help">{t('Choose a target language.')}</p>}
        <fieldset disabled={busy}><legend>{t('Output layout')}</legend>
          <label className="checkbox-row"><input type="checkbox" checked={layoutModes.includes('translated_only')} onChange={event => mode('translated_only', event.target.checked)} />{t('Translated PDF')}</label>
          <label className="checkbox-row"><input type="checkbox" checked={layoutModes.includes('side_by_side')} onChange={event => mode('side_by_side', event.target.checked)} />{t('Bilingual side-by-side PDF')}</label>
        </fieldset>
        <details><summary>{t('More options')}</summary>
          <label className="checkbox-row"><input type="checkbox" checked={translateImages} disabled={busy} onChange={event => setTranslateImages(event.target.checked)} />{t('Translate text in images')}</label>
          <label className="checkbox-row"><input type="checkbox" checked={translateTables} disabled={busy} onChange={event => setTranslateTables(event.target.checked)} />{t('Translate tables')}</label>
          <label>{t('Glossary CSV (optional)')}<input type="file" accept=".csv,text/csv" disabled={busy} onChange={event => {
            const file = event.target.files?.[0]; if (!file) { setGlossary(undefined); return; }
            if (file.size > 2 * 1024 * 1024) { setError('Choose a glossary smaller than 2 MB.'); return; }
            void file.text().then(text => setGlossary({ name: file.name, text })).catch(() => setError('Unable to read the glossary.'));
          }} /></label>{glossary && <button className="text-button" type="button" onClick={() => setGlossary(undefined)}>{t('Remove glossary')}</button>}
        </details>
        <p className="kolmo-cost">{t('Estimated cost: {points} credits', { points: estimated })}</p>
        {insufficient && <p className="task-error">{t('Not enough KolmoPDF credits.')} <a className="text-button" href="https://www.kolmopdf.com/credits" target="_blank" rel="noopener noreferrer" onClick={event => {
          event.preventDefault(); void host.openExternal(event.currentTarget.href);
        }}>{t('Get credits')}</a></p>}
      </div></details>
      {error && <p role="alert" className="task-error">{t(error)}</p>}
      {notice && <p role="status">{notice}</p>}
      {job && <section className="kolmo-job" aria-live="polite"><strong>{jobName}</strong><span>{t(`Translation ${job.status}`)}</span>
        {typeof job.progress === 'number' && <progress max="100" value={job.progress} aria-label={t('Translation progress')} />}
        {job.error?.message && <p className="task-error">{job.error.message}</p>}
        {running(job) && <button type="button" className="button" disabled={busy} onClick={() => void cancel()}>{t('Cancel translation')}</button>}
        {job.status === 'succeeded' && !files.length && <button type="button" className="button button-primary" disabled={busy || !connection.configured} onClick={() => void download()}><Download size={16} />{t('Get translated files')}</button>}
        {(!waiting || !running(job) && job.status !== 'succeeded') && <button type="button" className="button" disabled={busy || !connection.configured} onClick={() => void resume()}><RefreshCw size={16} />{t('Refresh task')}</button>}
      </section>}
      {files.length > 0 && <div className="kolmo-result-files" ref={resultList}>{files.map((file, index) => <article className="kolmo-result-file" key={`${file.name}:${index}`}><strong>{file.name}</strong><div className="ai-run-row">
        {/\.pdf$/i.test(file.name) && <button type="button" className="button" onClick={() => void onOpen(file, job!.id).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))}><FileText size={15} />{t('Open PDF')}</button>}
        <button type="button" className="button" onClick={() => void save(file)}><Download size={15} />{t(host.capabilities.platform === 'web' ? 'Download' : 'Save as…')}</button>
        {file.kind === 'native-file' && host.openSavedFile && <button type="button" className="button" onClick={() => void host.openSavedFile!(file.handle, true).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))}><FolderOpen size={15} />{t('Show in folder')}</button>}
      </div></article>)}</div>}
      {jobs.length > 0 && <details className="kolmo-task-list"><summary>{t('Recent translations')}</summary>{jobs.map(saved => <button type="button" key={saved.job.id} disabled={busy || !connection.configured} onClick={() => void resume(saved)}>
        <strong>{saved.name}</strong><span>{t(`Translation ${saved.job.status}`)}</span></button>)}</details>}
    </div>
    <footer className="task-panel-footer"><button type="button" className="button button-primary" disabled={busy || disabled || (!job && (!connection.configured || !document?.permissions.copy || !layoutModes.length || sourceLanguage === targetLanguage || insufficient))}
      onClick={event => {
        if (event.detail > 1) return;
        if (job) { setJob(null); setFiles([]); setError(''); setSettingsOpen(true); pending.current = null; if (body.current) body.current.scrollTop = 0; }
        else void start();
      }}>{t(busy ? 'Please wait…' : job ? 'New translation' : 'Translate PDF')}</button>
    </footer>
  </section>;
}
