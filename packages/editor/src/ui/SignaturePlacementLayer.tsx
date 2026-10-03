import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { CommitResult, DocumentInfo, EngineAdapter, PageModel, Rect } from '@pdf-editor/contracts';
import { useI18n } from './i18n.js';
import { commitSignature } from './SignaturePanel.js';
import {
  initialSignaturePlacement, moveSignaturePlacement, resizeSignaturePlacement, signaturePagePoint,
  signaturePreviewPoints, type SignatureDraft, type SignaturePoint,
} from './signature-placement.js';
import './signature-placement.css';

type Props = {
  document: DocumentInfo;
  page: PageModel;
  draft: SignatureDraft;
  disabled: boolean;
  engine: EngineAdapter;
  onBusyChange(busy: boolean): void;
  onCommitted(result: CommitResult): Promise<void>;
  onCancel(): void;
};
type Gesture = { pointerId: number; kind: 'move' | 'resize'; start: SignaturePoint; bounds: Rect };

/** A disposable visual draft. Only the explicit confirm button writes an Ink transaction. */
export function SignaturePlacementLayer({ document, page, draft, disabled, engine, onBusyChange, onCommitted, onCancel }: Props) {
  const { t } = useI18n();
  const layer = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const scope = `${document.id}\0${document.revision}\0${page.id}`;
  const origin = useRef(scope);
  const currentScope = useRef(scope); currentScope.current = scope;
  const [bounds, setBounds] = useState(() => initialSignaturePlacement(page));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = disabled || busy || !document.permissions.annotate || !document.capabilities.includes('annotation.add');

  useEffect(() => {
    mounted.current = true;
    layer.current?.focus({ preventScroll: true });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (scope !== origin.current) onCancel();
  }, [scope, onCancel]);
  useEffect(() => {
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || globalThis.document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (!locked && !submitting.current) onCancel();
    }
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [locked, onCancel]);

  function point(event: PointerEvent): SignaturePoint {
    return signaturePagePoint(event.clientX, event.clientY, layer.current!.getBoundingClientRect(), page);
  }

  function start(event: PointerEvent, kind: Gesture['kind'], reposition = false) {
    event.stopPropagation();
    if (locked || gesture.current || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    layer.current?.focus({ preventScroll: true });
    const startPoint = point(event);
    const next = reposition
      ? moveSignaturePlacement(bounds, startPoint[0] - bounds.width / 2, startPoint[1] - bounds.height / 2, page)
      : bounds;
    setBounds(next);
    gesture.current = { pointerId: event.pointerId, kind, start: startPoint, bounds: next };
    layer.current?.setPointerCapture(event.pointerId);
  }

  function end(event: PointerEvent, cancel = false) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (cancel) setBounds(active.bounds);
    gesture.current = null;
    if (layer.current?.hasPointerCapture(event.pointerId)) layer.current.releasePointerCapture(event.pointerId);
  }

  async function confirm() {
    if (locked || submitting.current || gesture.current || !draft.strokes.length || scope !== origin.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    onBusyChange(true);
    try {
      await commitSignature(engine, document, page, draft.strokes, bounds, draft.strokeWidth,
        () => mounted.current && currentScope.current === scope, onCommitted);
      onCancel();
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not place the signature');
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
      onBusyChange(false);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (locked || event.nativeEvent.isComposing || (event.target as HTMLElement).closest('button')) return;
    const delta = event.shiftKey ? 10 : 1;
    let next: Rect;
    switch (event.key) {
      case 'ArrowLeft': next = moveSignaturePlacement(bounds, bounds.x - delta, bounds.y, page); break;
      case 'ArrowRight': next = moveSignaturePlacement(bounds, bounds.x + delta, bounds.y, page); break;
      case 'ArrowUp': next = moveSignaturePlacement(bounds, bounds.x, bounds.y - delta, page); break;
      case 'ArrowDown': next = moveSignaturePlacement(bounds, bounds.x, bounds.y + delta, page); break;
      case '+': case '=': next = resizeSignaturePlacement(bounds, bounds.width * 1.1, page); break;
      case '-': next = resizeSignaturePlacement(bounds, bounds.width / 1.1, page); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    setBounds(next);
  }

  if (scope !== origin.current) return null;
  const toolbarBelow = bounds.y + bounds.height < page.heightPt * 0.78;
  return <div ref={layer} className="signature-placement-layer" role="group" tabIndex={0}
    aria-label={t('Signature placement preview')} aria-busy={busy}
    onKeyDown={keyDown} onClick={event => event.stopPropagation()}
    onPointerDown={event => start(event, 'move', true)}
    onPointerMove={event => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId || locked) return;
      event.stopPropagation();
      const [x, y] = point(event);
      const dx = x - active.start[0], dy = y - active.start[1];
      if (active.kind === 'move') {
        setBounds(moveSignaturePlacement(active.bounds, active.bounds.x + dx, active.bounds.y + dy, page));
      } else {
        // Project the pointer onto the aspect-ratio diagonal so either axis resizes naturally.
        const ratio = active.bounds.height / active.bounds.width;
        setBounds(resizeSignaturePlacement(active.bounds, active.bounds.width + (dx + ratio * dy) / (1 + ratio * ratio), page));
      }
    }}
    onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)}
    onLostPointerCapture={event => end(event, true)}>
    <span className="signature-sr-only">{t('Drag to move. Use the corner or plus and minus buttons to resize. Arrow keys move; Escape cancels.')}</span>
    <div className="signature-page-preview" aria-label={t('Drag signature')} onPointerDown={event => start(event, 'move')}
      style={{ left: `${bounds.x / page.widthPt * 100}%`, top: `${bounds.y / page.heightPt * 100}%`,
        width: `${bounds.width / page.widthPt * 100}%`, height: `${bounds.height / page.heightPt * 100}%` }}>
      <svg viewBox={`0 0 ${bounds.width} ${bounds.height}`} preserveAspectRatio="none" aria-hidden="true">
        {draft.strokes.map((stroke, index) => <polyline key={index} points={signaturePreviewPoints(stroke, bounds)}
          fill="none" stroke="#000" strokeWidth={draft.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />)}
      </svg>
      <button type="button" className="signature-resize-handle" disabled={locked} tabIndex={-1}
        aria-label={t('Resize signature')} title={t('Resize signature')} onPointerDown={event => start(event, 'resize')} />
    </div>
    <div className={`signature-placement-toolbar ${toolbarBelow ? '' : 'signature-toolbar-above'}`}
      style={{ left: `clamp(130px, ${(bounds.x + bounds.width / 2) / page.widthPt * 100}%, calc(100% - 130px))`,
        top: `${(toolbarBelow ? bounds.y + bounds.height : bounds.y) / page.heightPt * 100}%` }}
      onPointerDown={event => event.stopPropagation()}>
      <span className="signature-preview-label">{busy ? t('Placing signature…') : t('Signature preview')}</span>
      <div className="signature-toolbar-actions">
        <button type="button" className="signature-size-button" disabled={locked}
          aria-label={t('Make signature smaller')} title={t('Make signature smaller')}
          onClick={() => setBounds(resizeSignaturePlacement(bounds, bounds.width / 1.15, page))}>−</button>
        <button type="button" className="signature-size-button" disabled={locked}
          aria-label={t('Make signature larger')} title={t('Make signature larger')}
          onClick={() => setBounds(resizeSignaturePlacement(bounds, bounds.width * 1.15, page))}>+</button>
        <button type="button" className="signature-primary" disabled={locked} onClick={() => void confirm()}>{t('Confirm signature')}</button>
        <button type="button" disabled={locked} onClick={onCancel}>{t('Cancel')}</button>
      </div>
      {error ? <p role="alert">{t(error)}</p> : null}
    </div>
  </div>;
}
