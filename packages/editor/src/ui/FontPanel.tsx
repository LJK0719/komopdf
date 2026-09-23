import { useEffect, useRef, useState } from 'react';
import type { EngineAdapter, FontFaceInfo, FontSelection, HostAdapter, SystemFontEntry } from '@pdf-editor/contracts';
import { addImportedFont } from './font-resources.js';

type Props = { engine: EngineAdapter; host: HostAdapter; disabled: boolean; onBusyChange(busy: boolean): void };

export function FontPanel({ engine, host, disabled, onBusyChange }: Props) {
  const [selection, setSelection] = useState<FontSelection | null>(null);
  const [faces, setFaces] = useState<FontFaceInfo[]>([]);
  const [index, setIndex] = useState(0);
  const [systemFonts, setSystemFonts] = useState<SystemFontEntry[]>([]);
  const [systemId, setSystemId] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setSelection(null); setFaces([]); setSystemFonts([]); setNotice('');
    return () => { generation.current++; };
  }, [engine, host]);
  const locked = disabled || busy;
  const face = faces.find(item => item.index === index);

  async function run(action: (current: () => boolean) => Promise<void>) {
    if (locked) return;
    const captured = generation.current;
    const current = () => generation.current === captured;
    setBusy(true); onBusyChange(true); setError(''); setNotice('');
    try { await action(current); }
    catch (caught) { if (current()) setError(caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : 'Font operation failed'); }
    finally { if (current()) setBusy(false); onBusyChange(false); }
  }

  async function inspect(value: FontSelection | null, current: () => boolean) {
    if (!value || !current()) return;
    const information = await engine.inspectFont!(value.source);
    if (!current()) return;
    setSelection(value); setFaces(information);
    setIndex(information.find(item => item.editableEmbedding)?.index ?? information[0]?.index ?? 0);
  }

  if (!host.pickFont || !engine.inspectFont || !engine.registerFont) return null;
  const visible = systemFonts.filter(item => item.label.toLowerCase().includes(filter.toLowerCase()));
  return <section className="text-edit-panel" aria-label="Font resources">
    <details><summary>Import & system fonts</summary>
      <p>Fonts stay on this device. Adding a font makes it available in this session; it does not change the PDF. Saved PDFs retain their embedded fonts.</p>
      <button type="button" disabled={locked} onClick={() => void run(async current => {
        await inspect(await host.pickFont!(), current);
      })}>Import font file</button>
      {host.capabilities.systemFonts && host.listSystemFonts && host.getSystemFont && <>
        <button type="button" disabled={locked} onClick={() => void run(async current => {
          const list = await host.listSystemFonts!();
          if (current()) { setSystemFonts(list); setSystemId(list[0]?.id ?? ''); if (!list.length) setNotice('No local font files were found.'); }
        })}>Browse system fonts</button>
        {systemFonts.length > 0 && <>
          <label>Find system font<input value={filter} disabled={locked} onChange={event => { setFilter(event.target.value); setSystemId(''); }} /></label>
          <label>System font<select value={systemId} disabled={locked} onChange={event => setSystemId(event.target.value)}>
            <option value="">Choose a local font</option>
            {visible.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}
          </select></label>
          <button type="button" disabled={locked || !systemId} onClick={() => void run(async current => {
            await inspect(await host.getSystemFont!(systemId), current);
          })}>Inspect system font</button>
        </>}
      </>}
      {!host.capabilities.systemFonts && <p>System font access is unavailable in this browser. Import a local font file instead.</p>}
      {selection && <>
        <p>{selection.name}</p>
        <label>Font face<select value={index} disabled={locked} onChange={event => setIndex(Number(event.target.value))}>
          {faces.map(item => <option key={item.index} value={item.index}>
            {item.index + 1}: {item.family} · {item.style}{item.editableEmbedding ? '' : ' — embedding restricted'}
          </option>)}
        </select></label>
        {face && <p>{face.format.toUpperCase()} · Weight {face.weight}{face.italic ? ' · Italic' : ''}
          {face.editableEmbedding ? ' · Editable embedding allowed by font flags' : ' · Font flags do not permit editable embedding'}</p>}
        <button type="button" disabled={locked || !face?.editableEmbedding} onClick={() => void run(async current => {
          const registered = await engine.registerFont!({ id: `user-font-${crypto.randomUUID()}`, source: selection.source, faceIndex: index });
          if (!current()) return;
          addImportedFont(engine, registered);
          setNotice(`Added ${registered.family} · ${registered.style}. Choose it in Font or Replacement font.`);
          setSelection(null); setFaces([]);
        })}>Add selected font</button>
      </>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  </section>;
}
