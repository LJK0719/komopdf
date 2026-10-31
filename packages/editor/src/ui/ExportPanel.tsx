import { translate as t, useI18n } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { ConversionFormat, ConversionProgress, SaveRequest, SaveOutcome } from '@pdf-editor/contracts';
import './panel-refresh.css';

export type ExportSettings = ({ format: 'pdf' } & Pick<SaveRequest, 'protection' | 'password' | 'optimize' | 'imageOptimization'>)
  | { format: ConversionFormat; pages: string; dpi: number; quality: number };

export type ExportOutcome = Omit<SaveOutcome, 'status'> & { status: SaveOutcome['status'] | 'prepared'; warnings: string[]; format: string; pageCount: number };

export function ExportPanel({ disabled, encrypted, signed, wordAvailable, onExport, onOpenFile }: {
  disabled: boolean; encrypted: boolean; signed: boolean; wordAvailable: boolean;
  onExport(options: ExportSettings, signal: AbortSignal, progress: (value: ConversionProgress) => void): Promise<string[] | ExportOutcome>;
  onOpenFile?(handle: string, reveal: boolean): Promise<void>;
}) {
  useI18n();
  const [format, setFormat] = useState<'pdf' | ConversionFormat>('pdf');
  const [pages, setPages] = useState('all');
  const [dpi, setDpi] = useState(144);
  const [quality, setQuality] = useState(85);
  const [protection, setProtection] = useState<SaveRequest['protection']>('preserve');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [optimize, setOptimize] = useState(false);
  const [lossyImages, setLossyImages] = useState(false);
  const [imageQuality, setImageQuality] = useState(70);
  const [maxEdge, setMaxEdge] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [completed, setCompleted] = useState<ExportOutcome | null>(null);
  const [progress, setProgress] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const locked = disabled || busy;
  useEffect(() => () => pending.current?.abort(), []);

  async function submit() {
    if (locked) return;
    setError(''); setWarnings([]); setCompleted(null); setProgress(0);
    let options: ExportSettings;
    if (format === 'pdf') {
      if (protection === 'set' && (!password || password !== confirmation || password.includes('\0')
          || new TextEncoder().encode(password).length > 127)) {
        setError('Enter matching, nonempty passwords of at most 127 UTF-8 bytes, without null characters.'); return;
      }
      const edge = maxEdge.trim() ? Number(maxEdge) : undefined;
      if (lossyImages && edge !== undefined && (!Number.isInteger(edge) || edge < 1 || edge > 0x7fffffff)) {
        setError('Maximum image edge must be a positive whole number of pixels.'); return;
      }
      options = { format, protection, optimize, ...(protection === 'set' ? { password } : {}),
        ...(lossyImages ? { imageOptimization: { quality: imageQuality, ...(edge === undefined ? {} : { maxEdge: edge }) } } : {}) };
    } else {
      if (format === 'docx' && !wordAvailable) return;
      if (!Number.isFinite(dpi) || dpi < 36 || dpi > 600 || !Number.isInteger(dpi) || !Number.isFinite(quality) || quality < 1 || quality > 100) {
        setError('Choose a DPI from 36 to 600 and quality from 1 to 100.'); return;
      }
      options = { format, pages, dpi, quality };
    }
    const controller = new AbortController(); pending.current = controller; setBusy(true);
    try {
      const result = await onExport(options, controller.signal, value => setProgress(value.progress));
      const outcome: ExportOutcome = Array.isArray(result) ? { status: 'prepared', warnings: result, format: format.toUpperCase(), pageCount: 0 } : result;
      setWarnings(outcome.warnings);
      if (!controller.signal.aborted) {
        setCompleted(outcome);
        if (outcome.status !== 'cancelled') { setPassword(''); setConfirmation(''); }
      }
    } catch (caught) {
      setError(controller.signal.aborted ? 'Conversion cancelled' : caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : 'Export failed');
    } finally {
      setBusy(false); pending.current = null;
    }
  }

  return <section className="text-edit-panel task-panel export-panel" aria-label={t('Export options')}>
    <header className="task-panel-header"><h2>{t('Export settings')}</h2></header>
    <div className="task-panel-body">
      <label>{t('File format')}<select aria-label={t('File format')} disabled={locked} value={format}
        onChange={event => { setFormat(event.target.value as typeof format); setError(''); setWarnings([]); setCompleted(null); }}>
        <option value="pdf">PDF</option><option value="docx" disabled={!wordAvailable}>{t('Word document (.docx)')}{wordAvailable ? '' : ` — ${t('Desktop only')}`}</option>
        <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="txt">{t('Plain text (.txt)')}</option><option value="html">HTML</option>
      </select></label>
      {format !== 'pdf' ? <>
        <label>{t('Pages to export')}<input aria-label={t('Pages to export')} disabled={locked} value={pages} onChange={event => setPages(event.target.value)} placeholder="all / current / 1-3,5" /></label>
        <p className="panel-refresh-muted">{t('Use all, current, or page ranges such as 1-3,5. Page order is preserved.')}</p>
        {(format === 'png' || format === 'jpeg' || format === 'html') ? <details><summary>{t('Image settings')}</summary>
          <label>{t('Resolution (DPI)')}<input type="number" aria-label={t('Resolution (DPI)')} min="36" max="600" disabled={locked} value={dpi} onChange={event => setDpi(Number(event.target.value))} /></label>
          {format === 'jpeg' ? <label>{t('Image quality')}<input type="range" min="1" max="100" disabled={locked} value={quality} onChange={event => setQuality(Number(event.target.value))} /> <output>{quality}</output></label> : null}
        </details> : null}
        {format === 'png' || format === 'jpeg' ? <p>{t('Multiple pages are saved as a ZIP archive.')}</p> : null}
        {format === 'html' ? <p>{t('HTML is a self-contained fixed-layout copy with page text, not a reflowable Word document.')}</p> : null}
        {format === 'docx' ? <p>{t('Convert locally with editable text, tables and images. Complex layouts may differ; scanned pages need OCR first.')}</p> : null}
      </> : <>
        <p className="panel-refresh-muted">{t('Export a copy of the current PDF, including applied edits.')}</p>
        <label><input type="checkbox" disabled={locked} checked={optimize} onChange={event => setOptimize(event.target.checked)} />{t('Reduce file size without losing quality')}</label>
        <details open={encrypted || protection === 'set'}><summary>{t('Password protection')}</summary>
          <label>{t('Password protection')}<select disabled={locked} value={protection} onChange={event => {
            setProtection(event.target.value as SaveRequest['protection']); setPassword(''); setConfirmation(''); setError('');
          }}><option value="preserve">{t('Keep original protection')}</option><option value="set">{t('Set a password')}</option><option value="remove">{t('Remove password protection')}</option></select></label>
          {protection === 'set' ? <>
            <label>{t('New PDF password')}<input type="password" autoComplete="off" disabled={locked} value={password} onChange={event => setPassword(event.target.value)} /></label>
            <label>{t('Confirm PDF password')}<input type="password" autoComplete="off" disabled={locked} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
          </> : null}
        </details>
        <details><summary>{t('Image compression')}</summary>
          <label><input type="checkbox" disabled={locked} checked={lossyImages} onChange={event => setLossyImages(event.target.checked)} />{t('Compress images')}</label>
          {lossyImages ? <>
            <label>{t('JPEG quality:')} {imageQuality}<input type="range" min="1" max="95" disabled={locked} value={imageQuality} onChange={event => setImageQuality(Number(event.target.value))} /></label>
            <label>{t('Maximum image edge (pixels, optional)')}<input type="number" min="1" step="1" disabled={locked} value={maxEdge} onChange={event => setMaxEdge(event.target.value)} placeholder={t('Keep original pixel dimensions')} /></label>
          </> : null}
        </details>
        {signed && (optimize || lossyImages || protection !== 'preserve') ? <p role="alert">{t('Changing protection or optimizing this PDF will invalidate its existing digital signatures. Save to a different file to retain the signed original.')}</p> : null}
      </>}
      {!wordAvailable ? <details><summary>{t('Need Word conversion?')}</summary>
        <p>{t('Save a PDF copy first, then open that copy in the desktop app. Your current edits do not transfer automatically.')}</p>
        <a className="panel-result-link" href="/download/" target="_blank" rel="noreferrer">{t('Download desktop app')}</a>
      </details> : null}
      {completed && <div className="export-result layout-result" role="status">
        <strong>{t(completed.status === 'cancelled' ? 'Export cancelled' : completed.status === 'download-started' ? 'Download started' : completed.status === 'written' ? 'Export complete' : 'Export prepared')}</strong>
        {completed.status !== 'cancelled' && <><span>{completed.name ?? completed.format}</span>
          {completed.pageCount > 0 && <small>{t('{format} · {count} pages', { format: completed.format, count: completed.pageCount })}</small>}
          {completed.location && <small>{completed.location}</small>}
          {completed.status === 'download-started' && <p>{t('Find the file in your browser downloads.')}</p>}
          {completed.handle && onOpenFile && <div className="text-edit-actions">
            <button type="button" disabled={locked} onClick={() => void onOpenFile(completed.handle!, false).catch(caught => setError(String(caught)))}>{t('Open file')}</button>
            <button type="button" disabled={locked} onClick={() => void onOpenFile(completed.handle!, true).catch(caught => setError(String(caught)))}>{t('Show in folder')}</button>
          </div>}
        </>}
      </div>}
      {warnings.length > 0 ? <details open><summary>{t('Conversion notes')}</summary><ul>{warnings.map((warning, index) => <li key={index}>{t(warning)}</li>)}</ul></details> : null}
    </div>
    <footer className="task-panel-footer">
      {busy ? <div role="status"><progress max="1" value={progress} aria-label={t('Export progress')} /> {Math.round(progress * 100)}%</div> : null}
      {error ? <p role="alert">{t(error)}</p> : null}
      <div className="text-edit-actions">
        <button type="button" className="task-panel-primary" disabled={locked} onClick={() => void submit()}>{busy ? t('Exporting…') : format === 'pdf' ? t('Export PDF') : t('Export file')}</button>
        {busy ? <button type="button" onClick={() => pending.current?.abort()}>{t('Cancel')}</button> : null}
      </div>
    </footer>
  </section>;
}
