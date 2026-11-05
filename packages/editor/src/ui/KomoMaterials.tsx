import { useEffect, useRef, useState } from 'react';
import type { EditorAiContext } from './EditorShell.js';
import type { AiMaterial } from './text-actions.js';
import { isMaterialCurrent, materialDocument, materialIssue, MATERIAL_UPDATE_PROMPT, prepareMaterials, readDocumentMaterial } from './komo-materials.js';
import { useI18n } from './i18n.js';
import './komo-materials.css';

type Props = {
  context: Pick<EditorAiContext, 'document' | 'documents' | 'getDocumentInfo' | 'engine' | 'locateMaterial' | 'confirmMaterialUpdate' | 'prepareDocument'>;
  materials: readonly AiMaterial[]; onAdd(material: AiMaterial): void; onRemove(id: string): void;
};
export function KomoMaterials({ context, materials, onAdd, onRemove }: Props) {
  const { t } = useI18n();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const latest = useRef(context); latest.current = context;
  useEffect(() => () => pending.current?.abort(), []);
  const addDocument = async (id: string) => {
    const document = materialDocument(context, id);
    const entry = context.documents?.find(item => item.id === id);
    if (!document || !entry || pending.current) return;
    const abort = new AbortController(); pending.current = abort; setReading(true); setError('');
    try {
      const material = await readDocumentMaterial({ engine: context.engine, document, name: entry.name, signal: abort.signal,
        currentDocument: () => materialDocument(latest.current, id) });
      abort.signal.throwIfAborted(); onAdd(material);
    } catch (caught) { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : 'Unable to read this reference PDF.'); }
    finally { if (!abort.signal.aborted) setReading(false); pending.current = null; }
  };
  const refresh = async (material: AiMaterial) => {
    if (pending.current) return;
    const abort = new AbortController(); pending.current = abort; setReading(true); setError('');
    try {
      const prepared = await prepareMaterials([material], { ...context, getDocumentInfo: id => materialDocument(latest.current, id) }, abort.signal);
      if (prepared && !abort.signal.aborted) onAdd(prepared[0]!);
    } catch (caught) { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : 'Unable to read this reference PDF.'); }
    finally { if (!abort.signal.aborted) setReading(false); pending.current = null; }
  };
  if (!materials.length && (context.documents?.length ?? 0) < 2) return null;
  return <div className="komo-materials" aria-label={t('Attachments')}>
    <div className="komo-materials-heading"><span>{t('Attachments')}</span></div>
    {materials.map(material => {
      const valid = isMaterialCurrent(material, context), issue = materialIssue(material, context);
      return <details className="komo-material-card" key={material.id}>
        <summary><strong>{material.name}</strong><span>{t(material.kind === 'document' ? 'PDF' : material.kind === 'selection' ? 'Selected text' : 'Text')}</span></summary>
        <div className="komo-material-card-body">
          {material.locations.length > 0 && <p>{t('Pages')}: {[...new Set(material.locations.map(location => location.pageNumber))].join(', ')}</p>}
          {material.text && <><h4>{t('Original text')}</h4><pre>{material.text}</pre></>}
          {material.generatedText && <><h4>{t('AI result')}</h4><pre>{material.generatedText}</pre></>}
          {!valid && issue !== MATERIAL_UPDATE_PROMPT && <p role="status">{t(issue!)}</p>}
          {issue === MATERIAL_UPDATE_PROMPT && <button type="button" disabled={reading} onClick={() => void refresh(material)}>{t('Update material')}</button>}
          <div className="komo-material-actions">{context.locateMaterial && material.locations.length > 0 && <button type="button" disabled={!valid || materialDocument(context, material.documentId)?.revision !== material.revision}
            onClick={() => void context.locateMaterial!(material).catch(() => setError('Unable to locate this material.'))}>{t('Locate source')}</button>}
            <button type="button" onClick={() => onRemove(material.id)}>{t('Remove material')}</button></div>
        </div>
      </details>;
    })}
    {context.documents && context.documents.length > 1 && <label>{t('Add PDF')}<select aria-label={t('Add PDF')} value="" disabled={reading}
      onChange={event => { if (event.target.value) void addDocument(event.target.value); }}>
      <option value="">{t('Choose an open PDF…')}</option>
      {context.documents.filter(document => document.id !== context.document?.id).map(document => <option key={document.id} value={document.id}
        disabled={materials.some(material => material.kind === 'document' && material.documentId === document.id)}>{document.name}</option>)}
    </select></label>}
    {reading && <p role="status">{t('Reading document…')}</p>}
    {error && <p role="alert">{t(error)}</p>}
  </div>;
}
