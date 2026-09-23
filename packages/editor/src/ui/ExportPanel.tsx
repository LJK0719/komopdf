import { useState } from 'react';
import type { SaveRequest } from '@pdf-editor/contracts';

export type ExportSettings = Pick<SaveRequest, 'protection' | 'password' | 'optimize' | 'imageOptimization'>;

export function ExportPanel({ disabled, encrypted, signed, onExport }: {
  disabled: boolean; encrypted: boolean; signed: boolean; onExport(options: ExportSettings): Promise<void>;
}) {
  const [protection, setProtection] = useState<SaveRequest['protection']>('preserve');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [optimize, setOptimize] = useState(false);
  const [lossyImages, setLossyImages] = useState(false);
  const [imageQuality, setImageQuality] = useState(70);
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
    setBusy(true);
    try { await onExport({ protection, optimize, ...(protection === 'set' ? { password } : {}),
      ...(lossyImages ? { imageOptimization: { quality: imageQuality } } : {}) }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : 'Export failed'); }
    finally { setBusy(false); setPassword(''); setConfirmation(''); }
  }
  return <section className="text-edit-panel" aria-label="PDF export options">
    <details><summary>Protection & export</summary>
      <p>{encrypted ? 'The opened PDF is encrypted.' : 'The opened PDF is not encrypted.'} Normal Save preserves its original protection.</p>
      <p>Exporting a copy leaves the active document, saved status and undo history unchanged. Processing stays on this device.</p>
      <label>Copy protection<select disabled={disabled || busy} value={protection} onChange={event => {
        setProtection(event.target.value as SaveRequest['protection']); setPassword(''); setConfirmation(''); setError('');
      }}>
        <option value="preserve">Keep original protection</option>
        <option value="set">Set AES-256 password</option>
        <option value="remove">Remove password protection</option>
      </select></label>
      {protection === 'set' && <>
        <label>New PDF password<input type="password" autoComplete="off" disabled={disabled || busy} value={password} onChange={event => setPassword(event.target.value)} /></label>
        <label>Confirm PDF password<input type="password" autoComplete="off" disabled={disabled || busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      </>}
      <label><input type="checkbox" disabled={disabled || busy} checked={optimize} onChange={event => setOptimize(event.target.checked)} />Optimize structure without image quality loss</label>
      <label><input type="checkbox" disabled={disabled || busy} checked={lossyImages} onChange={event => setLossyImages(event.target.checked)} />Recompress supported images as JPEG (lossy)</label>
      {lossyImages && <>
        <label>JPEG quality: {imageQuality}<input type="range" min="1" max="95" step="1" disabled={disabled || busy} value={imageQuality} onChange={event => setImageQuality(Number(event.target.value))} /></label>
        <p>Only opaque 8-bit RGB/grayscale Flate or JPEG images can be recompressed. Transparent or masked images and other formats remain unchanged. No image downsampling is available. If no supported image gets smaller, the export fails rather than claiming an optimization.</p>
      </>}
      <p>Optimization does not guarantee a smaller file. Password changes use the password that opened this PDF; it is never sent to the AI service.</p>
      {signed && (optimize || lossyImages || protection !== 'preserve') && <p role="alert">Changing protection or optimizing this PDF will invalidate its existing digital signatures. Save to a different file to retain the signed original.</p>}
      <button type="button" disabled={disabled || busy} onClick={() => void submit()}>{busy ? 'Exporting…' : 'Export PDF copy'}</button>
      {error && <p role="alert">{error}</p>}
    </details>
  </section>;
}
