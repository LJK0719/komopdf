import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CommandRegistry } from '@pdf-editor/commands';
import {
  type CommitResult, type DocumentInfo, type EditCommand, type EditTransaction,
  type EngineAdapter, type PageModel, type Rect,
} from '@pdf-editor/contracts';

type Props = {
  document: DocumentInfo;
  page: PageModel;
  engine: EngineAdapter;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
  onCommitted(result: CommitResult): Promise<void>;
};
type Point = [number, number];
export type SignatureStroke = Point[];
type PlacementDraft = { x: string; y: string; width: string; height: string };
type Gesture = { pointerId: number; scope: string; points: SignatureStroke };
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

export function SignaturePanel({ document, page, engine, disabled, onBusyChange, onCommitted }: Props) {
  const scope = `${document.id}\0${document.revision}\0${page.id}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const gesture = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<{ scope: string; strokes: SignatureStroke[] }>({ scope, strokes: [] });
  const [placement, setPlacement] = useState<PlacementDraft>({ x: '36', y: '36', width: '180', height: '60' });
  const [width, setWidth] = useState('2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const strokes = draft.scope === scope ? draft.strokes : [];
  const locked = disabled || busy || !document.permissions.annotate || !document.capabilities.includes('annotation.add');

  function pointFromEvent(event: ReactPointerEvent<SVGSVGElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    ];
  }

  function appendPoint(event: ReactPointerEvent<SVGSVGElement>, force = false): void {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId || active.scope !== scope || locked) return;
    const point = pointFromEvent(event);
    const last = active.points[active.points.length - 1]!;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!force && Math.hypot((point[0] - last[0]) * rect.width, (point[1] - last[1]) * rect.height) < 1.5) return;
    active.points = [...active.points, point];
    setDraft(current => current.scope === scope
      ? { scope, strokes: [...current.strokes.slice(0, -1), active.points] } : current);
  }

  function cancelStroke(event: ReactPointerEvent<SVGSVGElement>): void {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDraft(current => current.scope === active.scope
      ? { scope: active.scope, strokes: current.strokes.slice(0, -1) } : current);
  }

  function clearDraft(lastOnly: boolean): void {
    gesture.current = null;
    setDraft({ scope, strokes: lastOnly ? strokes.slice(0, -1) : [] });
  }

  async function placeSignature(): Promise<void> {
    if (locked || !strokes.length) return;
    const expectedScope = scope;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      await commitSignature(engine, document, page, strokes, {
        x: Number(placement.x), y: Number(placement.y),
        width: Number(placement.width), height: Number(placement.height),
      }, Number(width), () => scopeRef.current === expectedScope, async result => {
        if (scopeRef.current === expectedScope) setDraft({ scope: expectedScope, strokes: [] });
        await onCommitted(result);
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not place the signature');
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return <section className="text-edit-panel document-tools-panel" aria-label="Handwritten signature">
    <span className="eyebrow">Handwritten signature</span>
    <p>Draw with a mouse, pen, or finger. Each stroke becomes an editable PDF ink annotation.</p>
    <p>This is a visual signature, not a certificate-based digital signature.</p>
    {document.permissions.signed ? <p role="alert">Changing this signed PDF may invalidate its existing digital signature.</p> : null}
    {!document.capabilities.includes('annotation.add') ? <p role="status">The current PDF core does not support ink annotations.</p> : null}
    {!document.permissions.annotate ? <p role="alert">This document does not permit annotations.</p> : null}
    <svg viewBox={`0 0 ${DRAW_WIDTH} ${DRAW_HEIGHT}`} preserveAspectRatio="none"
      role="img" aria-label="Signature drawing area" style={{ display: 'block', width: '100%', height: DRAW_HEIGHT,
        border: '1px solid #858d99', background: '#fff', touchAction: 'none' }}
      onPointerDown={event => {
        if (locked || gesture.current || !event.isPrimary || event.button !== 0) return;
        const points: SignatureStroke = [pointFromEvent(event)];
        gesture.current = { pointerId: event.pointerId, scope, points };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraft(current => ({ scope, strokes: [...(current.scope === scope ? current.strokes : []), points] }));
      }}
      onPointerMove={event => appendPoint(event)}
      onPointerUp={event => {
        const active = gesture.current;
        if (!active || active.pointerId !== event.pointerId) return;
        if (locked || active.scope !== scope) { cancelStroke(event); return; }
        appendPoint(event);
        if (active.points.length === 1) {
          const [x, y] = active.points[0]!;
          active.points = [active.points[0]!, [x < 1 ? x + 1 / DRAW_WIDTH : x - 1 / DRAW_WIDTH, y]];
          setDraft(current => current.scope === scope
            ? { scope, strokes: [...current.strokes.slice(0, -1), active.points] } : current);
        }
        gesture.current = null;
      }}
      onPointerCancel={cancelStroke}>
      {strokes.map((stroke, index) => <polyline key={index}
        points={stroke.map(([x, y]) => `${x * DRAW_WIDTH},${y * DRAW_HEIGHT}`).join(' ')}
        fill="none" stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
    <div className="text-edit-actions">
      <button type="button" disabled={busy || !strokes.length} onClick={() => clearDraft(true)}>Undo draft stroke</button>
      <button type="button" disabled={busy || !strokes.length} onClick={() => clearDraft(false)}>Clear draft</button>
    </div>
    <p>Place within the current PDF page (coordinates in points from the top-left).</p>
    <div className="document-tools-grid">
      {(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>
        {key === 'x' ? 'X' : key === 'y' ? 'Y' : key === 'width' ? 'Width' : 'Height'} (pt)
        <input type="number" step="any" value={placement[key]} disabled={disabled || busy}
          onChange={event => setPlacement(current => ({ ...current, [key]: event.target.value }))} />
      </label>)}
      <label>Stroke width (pt)<input type="number" min="0.1" step="0.1" value={width} disabled={disabled || busy}
        onChange={event => setWidth(event.target.value)} /></label>
    </div>
    <button type="button" disabled={locked || !strokes.length} onClick={() => void placeSignature()}>Place signature</button>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
