import { translate as t, useI18n } from './i18n.js';
import { useState } from 'react';
import type { SaveRequest } from '@pdf-editor/contracts';

export type ExportSettings = Pick<SaveRequest, 'protection' | 'password' | 'optimize' | 'imageOptimization'>;

export function ExportPanel({ disabled, encrypted, signed, onExport }: {
  disabled: boolean; encrypted: boolean; signed: boolean; onExport(options: ExportSettings): Promise<void>;
}) {
  useI18n();
  const [protection, setProtection] = useState<SaveRequest['protection']>('preserve');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [optimize, setOptimize] = useState(false);
  const [lossyImages, setLossyImages] = useState(false);
  const [imageQuality, setImageQuality] = useState(70);
  const [maxEdge, setMaxEdge] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    if (disabled || busy) return;
    setError('');
    if (protection === 'set' && (!password || password !== confirmation || password.includes('\0')
        || new TextEncoder().encode(password).length > 127)) {
      setError('Enter matching, nonempty passwords of at most 127 UTF-8 bytes, without null characters.');
      return;
    }
    const edge = maxEdge.trim() ? Number(maxEdge) : undefined;
    if (lossyImages && edge !== undefined && (!Number.isInteger(edge) || edge < 1 || edge > 0x7fffffff)) {
      setError('Maximum image edge must be a positive whole number of pixels.');
      return;
    }
    setBusy(true);
    try { await onExport({ protection, optimize, ...(protection === 'set' ? { password } : {}),
      ...(lossyImages ? { imageOptimization: { quality: imageQuality, ...(edge === undefined ? {} : { maxEdge: edge }) } } : {}) }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : 'Export failed'); }
    finally { setBusy(false); setPassword(''); setConfirmation(''); }
  }
  return <section className="text-edit-panel" aria-label="PDF export options">
    <details open><summary>{t("Export settings")}</summary>


      <label>{t("Password protection")}<select disabled={disabled || busy} value={protection} onChange={event => {
        setProtection(event.target.value as SaveRequest['protection']); setPassword(''); setConfirmation(''); setError('');
      }}>
        <option value="preserve">{t("Keep original protection")}</option>
        <option value="set">{t("Set a password")}</option>
        <option value="remove">{t("Remove password protection")}</option>
      </select></label>
      {protection === 'set' && <>
        <label>{t("New PDF password")}<input type="password" autoComplete="off" disabled={disabled || busy} value={password} onChange={event => setPassword(event.target.value)} /></label>
        <label>{t("Confirm PDF password")}<input type="password" autoComplete="off" disabled={disabled || busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      </>}
      <label><input type="checkbox" disabled={disabled || busy} checked={optimize} onChange={event => setOptimize(event.target.checked)} />{t("Reduce file size without losing quality")}</label>
      <label><input type="checkbox" disabled={disabled || busy} checked={lossyImages} onChange={event => setLossyImages(event.target.checked)} />{t("Compress images")}</label>
      {lossyImages && <>
        <label>{t("JPEG quality:")} {imageQuality}<input type="range" min="1" max="95" step="1" disabled={disabled || busy} value={imageQuality} onChange={event => setImageQuality(Number(event.target.value))} /></label>
        <label>{t("Maximum image edge (pixels, optional)")}<input type="number" min="1" step="1" disabled={disabled || busy}
          value={maxEdge} onChange={event => setMaxEdge(event.target.value)} placeholder={t("Keep original pixel dimensions")} /></label>

      </>}

      {signed && (optimize || lossyImages || protection !== 'preserve') && <p role="alert">{t("Changing protection or optimizing this PDF will invalidate its existing digital signatures. Save to a different file to retain the signed original.")}</p>}
      <button type="button" disabled={disabled || busy} onClick={() => void submit()}>{busy ? t("Exporting…") : t("Export PDF")}</button>
      {error && <p role="alert">{t(error)}</p>}
    </details>
  </section>;
}
