import { translate as t, useI18n } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { ConversionFormat, ConversionProgress, SaveRequest } from '@pdf-editor/contracts';

export type ExportSettings = ({ format: 'pdf' } & Pick<SaveRequest, 'protection' | 'password' | 'optimize' | 'imageOptimization'>)
  | { format: ConversionFormat; pages: string; dpi: number; quality: number };

export function ExportPanel({ disabled, encrypted, signed, wordAvailable, onExport }: {
  disabled: boolean; encrypted: boolean; signed: boolean; wordAvailable: boolean;
  onExport(options: ExportSettings, signal: AbortSignal, progress: (value: ConversionProgress) => void): Promise<string[]>;
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
  const [progress, setProgress] = useState(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function submit() {
    if (disabled || busy) return;
    setError(''); setWarnings([]); setProgress(0);
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
      if (!Number.isFinite(dpi) || dpi < 36 || dpi > 600 || !Number.isInteger(dpi) || !Number.isFinite(quality) || quality < 1 || quality > 100) {
        setError('Choose a DPI from 36 to 600 and quality from 1 to 100.'); return;
      }
      options = { format, pages, dpi, quality };
    }
    const controller = new AbortController(); pending.current = controller; setBusy(true);
    try { setWarnings(await onExport(options, controller.signal, value => setProgress(value.progress))); }
    catch (caught) { setError(controller.signal.aborted ? 'Conversion cancelled' : caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : 'Export failed'); }
    finally { setBusy(false); pending.current = null; setPassword(''); setConfirmation(''); }
  }
  return <section className="text-edit-panel" aria-label={t('Export options')}>
    <details open><summary>{t('Export settings')}</summary>
      <label>{t('File format')}<select aria-label={t('File format')} disabled={disabled || busy} value={format}
        onChange={event => { setFormat(event.target.value as typeof format); setError(''); setWarnings([]); }}>
        <option value="pdf">PDF</option><option value="docx" disabled={!wordAvailable}>{t('Word document (.docx)')}{wordAvailable ? '' : ` — ${t('Desktop only')}`}</option>
        <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="txt">{t('Plain text (.txt)')}</option><option value="html">HTML</option>
      </select></label>
      {format !== 'pdf' && <>
        <label>{t('Pages to export')}<input aria-label={t('Pages to export')} disabled={disabled || busy} value={pages} onChange={event => setPages(event.target.value)} placeholder="all / current / 1-3,5" /></label>
        <small>{t('Use all, current, or page ranges such as 1-3,5. Page order is preserved.')}</small>
        {(format === 'png' || format === 'jpeg' || format === 'html') && <label>{t('Resolution (DPI)')}<input type="number" aria-label={t('Resolution (DPI)')} min="36" max="600" disabled={disabled || busy} value={dpi} onChange={event => setDpi(Number(event.target.value))} /></label>}
        {format === 'jpeg' && <label>{t('Image quality')}<input type="range" min="1" max="100" disabled={disabled || busy} value={quality} onChange={event => setQuality(Number(event.target.value))} /> {quality}</label>}
        {(format === 'png' || format === 'jpeg') && <p>{t('Multiple pages are saved as a ZIP archive.')}</p>}
        {format === 'html' && <p>{t('HTML is a self-contained fixed-layout copy with page text, not a reflowable Word document.')}</p>}
        {format === 'docx' && <p>{t('Convert locally with editable text, tables and images. Complex layouts may differ; scanned pages need OCR first.')}</p>}
        {!wordAvailable && <small>{t('For layout-preserving Word conversion, use the desktop app. Your PDF is not uploaded.')}</small>}
      </>}
      {format === 'pdf' && <>
        <label>{t('Password protection')}<select disabled={disabled || busy} value={protection} onChange={event => {
          setProtection(event.target.value as SaveRequest['protection']); setPassword(''); setConfirmation(''); setError('');
        }}><option value="preserve">{t('Keep original protection')}</option><option value="set">{t('Set a password')}</option><option value="remove">{t('Remove password protection')}</option></select></label>
        {protection === 'set' && <>
          <label>{t('New PDF password')}<input type="password" autoComplete="off" disabled={disabled || busy} value={password} onChange={event => setPassword(event.target.value)} /></label>
          <label>{t('Confirm PDF password')}<input type="password" autoComplete="off" disabled={disabled || busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
        </>}
        <label><input type="checkbox" disabled={disabled || busy} checked={optimize} onChange={event => setOptimize(event.target.checked)} />{t('Reduce file size without losing quality')}</label>
        <label><input type="checkbox" disabled={disabled || busy} checked={lossyImages} onChange={event => setLossyImages(event.target.checked)} />{t('Compress images')}</label>
        {lossyImages && <>
          <label>{t('JPEG quality:')} {imageQuality}<input type="range" min="1" max="95" disabled={disabled || busy} value={imageQuality} onChange={event => setImageQuality(Number(event.target.value))} /></label>
          <label>{t('Maximum image edge (pixels, optional)')}<input type="number" min="1" step="1" disabled={disabled || busy} value={maxEdge} onChange={event => setMaxEdge(event.target.value)} placeholder={t('Keep original pixel dimensions')} /></label>
        </>}
        {signed && (optimize || lossyImages || protection !== 'preserve') && <p role="alert">{t('Changing protection or optimizing this PDF will invalidate its existing digital signatures. Save to a different file to retain the signed original.')}</p>}
      </>}
      {busy && <div role="status"><progress max="1" value={progress} aria-label={t('Export progress')} /> {Math.round(progress * 100)}%</div>}
      <div className="text-edit-actions"><button type="button" disabled={disabled || busy} onClick={() => void submit()}>{busy ? t('Exporting…') : format === 'pdf' ? t('Export PDF') : t('Export file')}</button>
        {busy && <button type="button" onClick={() => pending.current?.abort()}>{t('Cancel')}</button>}</div>
      {error && <p role="alert">{t(error)}</p>}
      {warnings.length > 0 && <div role="status"><strong>{t('Conversion notes')}</strong><ul>{warnings.map((warning, index) => <li key={index}>{t(warning)}</li>)}</ul></div>}
    </details>
  </section>;
}
