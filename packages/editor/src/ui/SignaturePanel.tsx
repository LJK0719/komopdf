import { useI18n } from './i18n.js';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { SignatureDraft, SignaturePoint as Point, SignatureStroke } from './signature-placement.js';
import './signature-placement.css';
export type { SignatureDraft, SignatureStroke } from './signature-placement.js';
import { CommandRegistry } from '@pdf-editor/commands';
import {
  type CommitResult, type DocumentInfo, type EditCommand, type EditTransaction,
  type EngineAdapter, type PageModel, type Rect,
} from '@pdf-editor/contracts';

type Props = {
  document: DocumentInfo;
  disabled: boolean;
  draft: SignatureDraft | null;
  placing?: boolean;
  onDraftChange(draft: SignatureDraft | null): void;
  onPlacementRequest(draft: SignatureDraft | null): void;
};
type Gesture = { pointerId: number; documentId: string; points: SignatureStroke };
const DRAW_WIDTH = 600;
const DRAW_HEIGHT = 200;

export function buildSignatureTransaction(
  document: DocumentInfo, page: PageModel, strokes: SignatureStroke[], placement: Rect, strokeWidth: number,
): EditTransaction {
  if (!strokes.length) throw new Error('Draw a signature before placing it');
  if (!Number.isFinite(strokeWidth) || strokeWidth <= 0) throw new Error('Stroke width must be positive');
  if (![placement.x, placement.y, placement.width, placement.height].every(Number.isFinite) ||
    placement.x < 0 || placement.y < 0 || placement.width <= 0 || placement.height <= 0 ||
    placement.x + placement.width > page.widthPt || placement.y + placement.height > page.heightPt) {
    throw new Error('Signature placement must fit within the current PDF page');
  }
  const commands: EditCommand[] = strokes.map(stroke => {
    if (stroke.length < 2 || stroke.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || x > 1 || y < 0 || y > 1)) throw new Error('Each stroke needs at least two points inside the drawing area');
    const points: Point[] = stroke.map(([x, y]) => [placement.x + x * placement.width, placement.y + y * placement.height]);
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    const half = strokeWidth / 2;
    const left = Math.max(0, Math.min(...xs) - half);
    const top = Math.max(0, Math.min(...ys) - half);
    const right = Math.min(page.widthPt, Math.max(...xs) + half);
    const bottom = Math.min(page.heightPt, Math.max(...ys) + half);
    return {
      type: 'annotation.add', pageId: page.id, annotationId: crypto.randomUUID(), subtype: 'ink',
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
      points, strokeWidth, color: [0, 0, 0], opacity: 1,
    };
  });
  return { id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual', commands };
}

export async function commitSignature(
  engine: EngineAdapter, document: DocumentInfo, page: PageModel, strokes: SignatureStroke[],
  placement: Rect, strokeWidth: number, isCurrent: () => boolean,
  onCommitted: (result: CommitResult) => Promise<void>,
): Promise<void> {
  const transaction = buildSignatureTransaction(document, page, strokes, placement, strokeWidth);
  await engine.previewTransaction(transaction);
  if (!isCurrent()) throw new Error('The document changed while previewing this edit');
  const result = await new CommandRegistry(engine).execute(transaction, {
    document, pages: new Map([[page.id, page]]),
  });
  await onCommitted(result);
}

export function SignaturePanel({ document, disabled, draft, placing = false, onDraftChange, onPlacementRequest }: Props) {
  const { t } = useI18n();
  const gesture = useRef<Gesture | null>(null);
  const [drawing, setDrawing] = useState<SignatureStroke | null>(null);
  const strokes = draft?.strokes ?? [];
  const strokeWidth = draft?.strokeWidth ?? 2;
  const locked = disabled || placing || !document.permissions.annotate || !document.capabilities.includes('annotation.add');

  useEffect(() => {
    gesture.current = null;
    setDrawing(null);
  }, [document.id, locked]);

  function pointFromEvent(event: ReactPointerEvent<SVGSVGElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    ];
  }

  function appendPoint(event: ReactPointerEvent<SVGSVGElement>, force = false): void {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId || active.documentId !== document.id || locked) return;
    const point = pointFromEvent(event);
    const last = active.points[active.points.length - 1]!;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!force && Math.hypot((point[0] - last[0]) * rect.width, (point[1] - last[1]) * rect.height) < 1.5) return;
    active.points = [...active.points, point];
    setDrawing(active.points);
  }

  function cancelStroke(event: ReactPointerEvent<SVGSVGElement>): void {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDrawing(null);
  }

  return <section className="text-edit-panel document-tools-panel signature-panel" aria-label={t('Handwritten signature')}>
    <span className="eyebrow">{t('Handwritten signature')}</span>
    <p>{t('Draw once, then place your signature as many times as you need.')}</p>
    {document.permissions.signed ? <p role="alert">{t('Changing this signed PDF may invalidate its existing digital signature.')}</p> : null}
    {!document.capabilities.includes('annotation.add') ? <p role="status">{t('Signatures are not available for this document.')}</p> : null}
    {!document.permissions.annotate ? <p role="alert">{t('This document does not permit annotations.')}</p> : null}
    <svg className="signature-drawing-area" viewBox={`0 0 ${DRAW_WIDTH} ${DRAW_HEIGHT}`} preserveAspectRatio="none"
      role="img" aria-label={t('Signature drawing area')} aria-disabled={locked}
      onPointerDown={event => {
        if (locked || gesture.current || !event.isPrimary || event.button !== 0) return;
        const points: SignatureStroke = [pointFromEvent(event)];
        gesture.current = { pointerId: event.pointerId, documentId: document.id, points };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrawing(points);
      }}
      onPointerMove={event => appendPoint(event)}
      onPointerUp={event => {
        const active = gesture.current;
        if (!active || active.pointerId !== event.pointerId) return;
        if (locked || active.documentId !== document.id) { cancelStroke(event); return; }
        appendPoint(event, true);
        if (active.points.length === 2 && active.points[0]![0] === active.points[1]![0] && active.points[0]![1] === active.points[1]![1]) {
          const [x, y] = active.points[0]!;
          active.points = [[x, y], [x < 1 ? Math.min(1, x + 1 / DRAW_WIDTH) : x - 1 / DRAW_WIDTH, y]];
        }
        gesture.current = null;
        setDrawing(null);
        onDraftChange({ strokes: [...strokes, active.points], strokeWidth });
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={cancelStroke} onLostPointerCapture={cancelStroke}>
      <line x1="24" y1="155" x2="576" y2="155" className="signature-drawing-baseline" />
      {[...strokes, ...(drawing ? [drawing] : [])].map((stroke, index) => <polyline key={index}
        points={stroke.map(([x, y]) => `${x * DRAW_WIDTH},${y * DRAW_HEIGHT}`).join(' ')}
        fill="none" stroke="#000" strokeWidth={strokeWidth * 2} strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
    <div className="signature-draft-actions">
      <button type="button" disabled={locked || !strokes.length || !!drawing}
        onClick={() => onDraftChange({ strokes: strokes.slice(0, -1), strokeWidth })}>{t('Undo draft stroke')}</button>
      <button type="button" className="signature-clear" disabled={disabled || (!strokes.length && !drawing)} onClick={() => {
        gesture.current = null;
        setDrawing(null);
        onDraftChange(null);
        onPlacementRequest(null);
      }}>{t('Clear signature')}</button>
    </div>
    <label className="signature-stroke-control">{t('Stroke width (pt)')}
      <input type="range" min="0.5" max="5" step="0.5" value={strokeWidth} disabled={locked}
        onChange={event => onDraftChange({ strokes, strokeWidth: Number(event.target.value) })} />
      <output>{strokeWidth}</output>
    </label>
    {placing ? <>
      <p className="signature-placement-status" role="status">{t('Signature preview active. Drag it on the page, then confirm to place.')}</p>
      <button type="button" disabled={disabled} onClick={() => onPlacementRequest(null)}>{t('Cancel placement')}</button>
    </> : <button type="button" className="signature-primary" disabled={locked || !strokes.length || !!drawing}
      onClick={() => { if (draft) onPlacementRequest(draft); }}>{t('Place signature')}</button>}
    <p className="signature-session-note">{t('Kept only for this editing session. Clear it when you are done.')}</p>
    <p className="signature-session-note">{t('Handwritten ink only, not a digital certificate signature.')}</p>
  </section>;
}
