import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react';
import type { CommitResult, DocumentInfo, EditCommand, EngineAdapter, PdfAnnotationInfo } from '@pdf-editor/contracts';
import { AiFloatingWindow } from './AiFloatingWindow.js';
import { AppDialog } from './AppDialog.js';
import type { AnnotationDraftHandle } from './AnnotationDrawingLayer.js';
import type { CommentSelection } from './AnnotationLayer.js';
import { useI18n } from './i18n.js';

export function AnnotationPopup({ selection, document, engine, disabled, draftRef, onDirty, onBusyChange, onCommitted, onClose }: {
  selection: CommentSelection; document: DocumentInfo; engine: EngineAdapter; disabled: boolean;
  draftRef: RefObject<AnnotationDraftHandle | null>; onDirty(dirty: boolean): void; onBusyChange(busy: boolean): void;
  onCommitted(result: CommitResult): Promise<void>; onClose(): void;
}) {
  const { t } = useI18n();
  const [annotation, setAnnotation] = useState<PdfAnnotationInfo | null>(null);
  const [anchor, setAnchor] = useState(selection.anchor);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirm, setConfirm] = useState<'close' | 'delete' | null>(null);
  const composing = useRef(false);
  const inFlight = useRef(false);
  const dirty = editing && annotation !== null && text !== annotation.text;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const current = useRef(document); current.current = document;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onDirty(false); }; }, []);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setLoadFailed(false);
    if (!engine.describeAnnotations) { setError(t('Unable to load comments.')); setLoading(false); return; }
    void Promise.all([engine.describeAnnotations(document.id, selection.pageId), engine.describePage(document.id, selection.pageId)]).then(([items, page]) => {
      if (!active) return;
      const item = items.find(item => item.id === selection.id);
      if (!item) { onClose(); return; }
      if (!anchor) {
        const node = [...globalThis.document.querySelectorAll<HTMLElement>('[data-document-page]')].find(node => node.dataset.documentPage === selection.pageId);
        const rect = node?.getBoundingClientRect();
        if (rect) {
          const left = rect.left + item.bounds.x * rect.width / page.widthPt, top = rect.top + item.bounds.y * rect.height / page.heightPt;
          setAnchor({ left, top, right: left + 24, bottom: top + 24 });
        }
      }
      if (!dirtyRef.current) { setAnnotation(item); setText(item.text); }
      setLoading(false);
    }).catch(caught => { if (active) {
      console.warn('Unable to read comment', caught);
      setError(t('This comment could not be loaded. Please try again.')); setLoadFailed(true); setLoading(false);
    } });
    return () => { active = false; };
  }, [engine, document.id, document.revision, selection.pageId, selection.id, reload]);
  const editable = annotation && annotation.subtype === 'text' && document.permissions.annotate && document.capabilities.includes('annotation.update');
  const deletable = annotation && !['link', 'other'].includes(annotation.subtype) && document.permissions.annotate && document.capabilities.includes('annotation.delete');

  async function execute(remove: boolean): Promise<boolean> {
    if (disabled || inFlight.current || !annotation || composing.current || (remove ? !deletable : !editable)) return false;
    inFlight.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      const info = current.current;
      const latest = (await engine.describeAnnotations!(info.id, selection.pageId)).find(item => item.id === selection.id);
      if (!latest || latest.text !== annotation.text || info.revision !== current.current.revision) throw new Error('The comment changed. Reopen it before editing.');
      const command: EditCommand = remove ? { type: 'annotation.delete', pageId: latest.pageId, annotationId: latest.id }
        : { type: 'annotation.update', pageId: latest.pageId, annotationId: latest.id, subtype: latest.subtype as 'text' | 'highlight' | 'rectangle',
          bounds: latest.bounds, text, color: latest.color, opacity: latest.opacity };
      const result = await engine.apply({ id: crypto.randomUUID(), docId: info.id, baseRevision: info.revision, source: 'manual', commands: [command] });
      if (mounted.current) { setEditing(false); dirtyRef.current = false; onDirty(false); if (!remove) setAnnotation({ ...latest, text }); }
      await onCommitted(result);
      if (remove) onClose();
      return true;
    } catch (caught) {
      console.warn('Unable to update comment', caught);
      if (mounted.current) setError(t(caught instanceof Error && caught.message === 'The comment changed. Reopen it before editing.'
        ? caught.message : remove ? 'This comment could not be deleted. Please try again.' : 'This comment could not be saved. Your edits are still here.'));
      return false;
    }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); onBusyChange(false); }
  }
  const finish = async () => !dirty || await execute(false);
  useImperativeHandle(draftRef, () => ({ finish }));
  const close = () => { if (busy) return; if (dirty) setConfirm('close'); else onClose(); };
  return <>
    <AiFloatingWindow title={t('Comment')} anchor={anchor} hidden={false} onClose={close} closeLabel="Close comment" className="comment-popup">
      <section className="comment-popup-content" aria-label={t('Comment content')}>
        <p className="comment-location">{t('Page {page}', { page: document.pageOrder.indexOf(selection.pageId) + 1 })}</p>
        {loading ? <p role="status">{t('Loading comment…')}</p> : annotation && (editing ? <label>{t('Comment text')}
          <textarea autoFocus value={text} disabled={busy} onChange={event => setText(event.target.value)}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void execute(false); } }} />
        </label> : <div className="comment-body" tabIndex={0} dir="auto">{annotation.text || t('No comment text')}</div>)}
        {error && <p className="task-error" role="alert">{t(error)}</p>}
        {loadFailed && <button type="button" className="button" onClick={() => setReload(value => value + 1)}>{t('Try again')}</button>}
        {annotation && annotation.subtype !== 'text' && <p className="task-help">{t('This markup is shown read-only here to preserve its original appearance.')}</p>}
        {!document.permissions.annotate && <p className="task-help">{t('This document does not permit annotations.')}</p>}
        <footer>
          {editing ? <><button type="button" className="button" disabled={busy} onClick={() => { setText(annotation!.text); setEditing(false); setError(''); }}>{t('Cancel')}</button>
            <button type="button" className="button button-primary" disabled={busy || disabled || !dirty} onClick={() => void execute(false)}>{t('Save comment')}</button></>
            : editable && <button type="button" className="button" disabled={busy || disabled} onClick={() => setEditing(true)}>{t('Edit comment')}</button>}
          {deletable && <button type="button" className="button" disabled={busy || disabled} onClick={() => setConfirm('delete')}>{t('Delete comment')}</button>}
        </footer>
      </section>
    </AiFloatingWindow>
    <AppDialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null); }} title={t(confirm === 'delete' ? 'Delete comment?' : 'Save comment changes?')} className="ai-owned-focus">
      <p>{t(confirm === 'delete' ? 'You can undo this deletion.' : 'Save your edits or discard them before closing this comment.')}</p>
      <div className="comment-confirm-actions"><button type="button" className="button" onClick={() => setConfirm(null)}>{t('Cancel')}</button>
        {confirm === 'close' && <button type="button" className="button" onClick={onClose}>{t('Discard changes')}</button>}
        <button type="button" className="button button-primary" disabled={busy} onClick={() => { void execute(confirm === 'delete').then(ok => { if (ok) { setConfirm(null); onClose(); } }); }}>{t(confirm === 'delete' ? 'Delete comment' : 'Save comment')}</button>
      </div>
    </AppDialog>
  </>;
}
