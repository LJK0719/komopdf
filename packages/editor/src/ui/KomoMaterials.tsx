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
  return <div className="komo-materials" aria-label={t('Pending materials')}>
    <div className="komo-materials-heading"><span>{t('Pending materials')}</span><small>{t('References are read-only')}</small></div>
    {materials.map(material => {
      const valid = isMaterialCurrent(material, context);
      return <details className="komo-material-card" key={material.id}>
        <summary><strong>{material.name}</strong><span>{t(material.kind === 'document' ? 'Reference PDF' : material.kind === 'selection' ? 'Selected passage' : 'Attached text')}</span>
          {material.generatedText ? <span>{t('Generated text')}</span> : null}</summary>
        <div className="komo-material-card-body">
          <p>{material.locations.length ? `${t('Pages')}: ${[...new Set(material.locations.map(location => location.pageNumber))].join(', ')}` : t('Attached text')}
            {material.action ? ` · ${material.action}` : ''}{material.sourceLanguage ? ` · ${material.sourceLanguage} → ${material.targetLanguage ?? ''}` : ''}</p>
          {material.text ? <><h4>{t(material.kind === 'text' ? 'Attached text' : 'PDF original')}</h4><pre>{material.text}</pre></> : null}
          {material.generatedText ? <><h4>{t(material.generatedFromRevision !== undefined && material.generatedFromRevision !== material.revision ? 'Generated text from an earlier version' : 'Generated text')}</h4><p>{t('Generated text is not a quotation from the PDF.')}</p><pre>{material.generatedText}</pre></> : null}
          {!valid ? <p role="status">{t(materialIssue(material, context)!)}</p> : null}
          {materialIssue(material, context) === MATERIAL_UPDATE_PROMPT ? <button type="button" disabled={reading} onClick={() => void refresh(material)}>{t('Save and update material')}</button> : null}
          <div className="komo-material-actions">{context.locateMaterial && material.locations.length ? <button type="button" disabled={!valid || materialDocument(context, material.documentId)?.revision !== material.revision}
            onClick={() => void context.locateMaterial!(material).catch(() => setError('Unable to locate this material.'))}>{t('Locate source')}</button> : null}
            <button type="button" onClick={() => onRemove(material.id)}>{t('Remove material')}</button></div>
        </div>
      </details>;
    })}
    {context.documents && context.documents.length > 1 ? <label>{t('Add reference PDF')}<select aria-label={t('Add reference PDF')} value="" disabled={reading}
      onChange={event => { if (event.target.value) void addDocument(event.target.value); }}>
      <option value="">{t('Choose an open PDF…')}</option>
      {context.documents.filter(document => document.id !== context.document?.id).map(document => <option key={document.id} value={document.id}
        disabled={materials.some(material => material.kind === 'document' && material.documentId === document.id)}>{document.name}</option>)}
    </select></label> : null}
    {reading ? <p role="status">{t('Reading reference PDF…')}</p> : null}
    {error ? <p role="alert">{t(error)}</p> : null}
  </div>;
}
