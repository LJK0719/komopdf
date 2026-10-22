import { useEffect, useRef, useState } from 'react';
import type { CommitResult, DocumentInfo, EditCommand, EngineAdapter, PageModel, Rect } from '@pdf-editor/contracts';
import { annotationBounds, annotationPointFromClient, type AnnotationPoint } from './annotation-drawing.js';
import { useI18n } from './i18n.js';

export type PagePlacementRequest = {
  documentId: string; label: string;
  command(pageId: string, bounds: Rect): EditCommand;
};

export function PagePlacementLayer({ request, document: info, page, engine, disabled, onBusyChange, onCommitted, onCancel }: {
  request: PagePlacementRequest; document: DocumentInfo; page: PageModel; engine: EngineAdapter; disabled: boolean;
  onBusyChange(busy: boolean): void; onCommitted(result: CommitResult): Promise<void>; onCancel(): void;
}) {
  const { t } = useI18n();
  const [bounds, setBounds] = useState<Rect | null>(null);
  const [error, setError] = useState('');
  const gesture = useRef<{ start: AnnotationPoint; pointer: number } | null>(null);
  const busy = useRef(false);
  const cancel = useRef(onCancel); cancel.current = onCancel;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && !busy.current) { event.preventDefault(); cancel.current(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  async function place(rect: Rect) {
    if (busy.current || disabled || !info.permissions.modify || info.id !== request.documentId) return;
    busy.current = true; onBusyChange(true); setError('');
    try {
      const transaction = { id: crypto.randomUUID(), docId: info.id, baseRevision: info.revision, source: 'manual' as const,
        commands: [request.command(page.id, rect)] };
      await engine.previewTransaction(transaction);
      await onCommitted(await engine.apply(transaction));
      onCancel();
    } catch (caught) {
      console.warn('Unable to place item', caught);
      setError(t('This item could not be added. Try another position or a larger area.'));
    } finally { busy.current = false; onBusyChange(false); }
  }
  return <div className="annotation-drawing-layer">
    <svg className="annotation-drawing-surface" aria-label={t('Placement area')} viewBox={`0 0 ${page.widthPt} ${page.heightPt}`} preserveAspectRatio="none"
      style={{ pointerEvents: disabled ? 'none' : 'auto' }}
      onPointerDown={event => {
        if (disabled || busy.current || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); setError('');
        const start = annotationPointFromClient(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), page);
        gesture.current = { start, pointer: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId);
        setBounds({ x: start[0], y: start[1], width: 0, height: 0 });
      }}
      onPointerMove={event => {
        if (gesture.current?.pointer !== event.pointerId) return;
        const point = annotationPointFromClient(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), page);
        setBounds(annotationBounds([gesture.current.start, point], page));
      }}
      onPointerUp={event => {
        const active = gesture.current;
        if (!active || active.pointer !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation(); gesture.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const point = annotationPointFromClient(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), page);
        const rect = annotationBounds([active.start, point], page);
        if (rect.width >= 4 && rect.height >= 4) { setBounds(rect); void place(rect); }
        else setBounds(null);
      }} onPointerCancel={() => { gesture.current = null; setBounds(null); }}>
      {bounds && <rect {...bounds} fill="#227b5e22" stroke="#227b5e" strokeWidth="1" strokeDasharray="4 3" />}
    </svg>
    <span className="annotation-drawing-hint">{t('Drag on the page to place {item}. Esc cancels.', { item: t(request.label) })}</span>
    {error && <div className="annotation-note-editor" role="alert" style={{ left: 12, bottom: 12 }}>{error}<button type="button" onClick={onCancel}>{t('Cancel')}</button></div>}
  </div>;
}
