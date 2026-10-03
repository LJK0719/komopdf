import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CommitResult, DocumentInfo, EngineAdapter, PageModel } from '@pdf-editor/contracts';
import { annotationBounds, annotationNoteBounds, annotationPointFromClient, buildDrawnAnnotation, commitDrawnAnnotation,
  type AnnotationDrawingOptions, type AnnotationPoint } from './annotation-drawing.js';
import { useI18n } from './i18n.js';
import './annotations.css';

type Props = {
  document: DocumentInfo;
  page: PageModel;
  engine: EngineAdapter;
  options: AnnotationDrawingOptions | null;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
  onCommitted(result: CommitResult): Promise<void>;
  onCancel(): void;
};
type Gesture = { scope: string; pointerId: number; points: AnnotationPoint[]; startClient: AnnotationPoint; distance: number };
type Draft = { scope: string; points: AnnotationPoint[] };
type Note = { scope: string; point: AnnotationPoint; text: string };

export function AnnotationDrawingLayer({ document: info, page, engine, options, disabled, onBusyChange, onCommitted, onCancel }: Props) {
  const { t } = useI18n();
  const svg = useRef<SVGSVGElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const scope = `${info.id}\0${info.revision}\0${page.id}\0${JSON.stringify(options)}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const onCancelRef = useRef(onCancel); onCancelRef.current = onCancel;
  const allowed = info.permissions.annotate && info.capabilities.includes('annotation.add');
  const locked = disabled || busy || !allowed;
  const visibleDraft = draft?.scope === scope ? draft : null;
  const visibleNote = note?.scope === scope ? note : null;

  function clearDraft(): void {
    const active = gesture.current;
    gesture.current = null;
    if (active && svg.current?.hasPointerCapture(active.pointerId)) svg.current.releasePointerCapture(active.pointerId);
    setDraft(null); setNote(null);
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  useEffect(() => { clearDraft(); setFeedback(null); }, [scope]);
  useEffect(() => { if ((disabled && !busyRef.current) || !allowed) clearDraft(); }, [disabled, allowed]);
  useEffect(() => { if (visibleNote) textarea.current?.focus(); }, [visibleNote?.scope, visibleNote?.point]);
  useEffect(() => {
    if (!options) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || globalThis.document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation();
      generation.current += 1; clearDraft(); onCancelRef.current();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [Boolean(options)]);

  async function submit(points: AnnotationPoint[], text = options?.text ?? ''): Promise<void> {
    if (!options || locked || busyRef.current) return;
    const expectedScope = scope, expectedGeneration = generation.current;
    const isCurrent = () => mounted.current && scopeRef.current === expectedScope && generation.current === expectedGeneration;
    busyRef.current = true; setBusy(true); onBusyChange(true); setFeedback(null);
    try {
      const command = buildDrawnAnnotation(page, { ...options, text }, points);
      if (!command) return;
      await commitDrawnAnnotation(engine, info, page, command, isCurrent, async result => {
        clearDraft();
        await onCommitted(result);
        if (mounted.current) setFeedback({ error: false, text: 'Annotation added.' });
      });
    } catch (caught) {
      if (isCurrent()) setFeedback({ error: true, text: caught instanceof Error ? caught.message : 'Could not add the annotation.' });
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
      onBusyChange(false);
    }
  }

  function appendPoint(event: ReactPointerEvent<SVGSVGElement>): void {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId || active.scope !== scope || locked || !options) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = annotationPointFromClient(event.clientX, event.clientY, rect, page);
    const last = active.points[active.points.length - 1]!;
    const distance = Math.hypot((point[0] - last[0]) * rect.width / page.widthPt, (point[1] - last[1]) * rect.height / page.heightPt);
    if (distance < 0.5) return;
    active.distance += distance;
    active.points = options.tool === 'ink' ? [...active.points, point] : [active.points[0]!, point];
    setDraft({ scope, points: active.points });
  }

  function cancelPointer(event: ReactPointerEvent<SVGSVGElement>): void {
    if (gesture.current?.pointerId === event.pointerId) clearDraft();
  }

  if (!options || !allowed) return null;
  const bounds = visibleDraft ? annotationBounds(visibleDraft.points, page) : null;
  const noteBounds = visibleNote ? annotationNoteBounds(visibleNote.point, page) : null;
  const hint = options.tool === 'text' ? 'Click on the page to write a note. Esc cancels.'
    : options.tool === 'rectangle' ? 'Drag to draw a rectangle. Esc cancels.' : 'Draw on the page. Esc cancels.';

  return <div className={`annotation-drawing-layer annotation-drawing-${options.tool}`} data-annotation-tool={options.tool}>
    <svg ref={svg} viewBox={`0 0 ${page.widthPt} ${page.heightPt}`} preserveAspectRatio="none"
      aria-label={t('Annotation drawing area')} className="annotation-drawing-surface"
      style={{ pointerEvents: locked || visibleNote ? 'none' : 'auto' }}
      onPointerDown={event => {
        if (locked || busyRef.current || visibleNote || gesture.current || !event.isPrimary || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); setFeedback(null);
        const point = annotationPointFromClient(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), page);
        gesture.current = { scope, pointerId: event.pointerId, points: [point], startClient: [event.clientX, event.clientY], distance: 0 };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraft({ scope, points: [point] });
      }}
      onPointerMove={event => { if (gesture.current) { event.preventDefault(); event.stopPropagation(); appendPoint(event); } }}
      onPointerUp={event => {
        const active = gesture.current;
        if (!active || active.pointerId !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        if (locked || active.scope !== scope) { clearDraft(); return; }
        appendPoint(event);
        gesture.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        const dx = Math.abs(event.clientX - active.startClient[0]), dy = Math.abs(event.clientY - active.startClient[1]);
        if (options.tool === 'text') {
          setDraft(null);
          if (Math.hypot(dx, dy) <= 5) setNote({ scope, point: active.points[0]!, text: options.text });
        } else if (options.tool === 'rectangle' ? dx >= 3 && dy >= 3 : active.distance >= 3) {
          void submit(active.points);
        } else setDraft(null);
      }}
      onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}>
      {bounds && options.tool === 'rectangle' ? <rect {...bounds} fill="none" stroke={options.color}
        strokeOpacity={options.opacity} strokeWidth={options.strokeWidth} /> : null}
      {visibleDraft && options.tool === 'ink' ? <polyline points={visibleDraft.points.map(point => point.join(',')).join(' ')}
        fill="none" stroke={options.color} strokeOpacity={options.opacity} strokeWidth={options.strokeWidth} strokeLinecap="round" strokeLinejoin="round" /> : null}
      {noteBounds ? <rect {...noteBounds} rx="3" fill={options.color} fillOpacity={options.opacity} stroke="#555" strokeWidth="0.6" /> : null}
    </svg>
    {visibleNote ? <form className="annotation-note-editor" aria-label={t('New note')}
      style={{ left: `clamp(6px, ${visibleNote.point[0] / page.widthPt * 100}%, max(6px, calc(100% - 292px)))`,
        top: `clamp(6px, ${visibleNote.point[1] / page.heightPt * 100}%, max(6px, calc(100% - 200px)))` }}
      onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
        event.stopPropagation();
        if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key === 'Enter' && visibleNote.text.trim()) {
          event.preventDefault(); void submit([visibleNote.point], visibleNote.text);
        }
      }} onSubmit={event => { event.preventDefault(); void submit([visibleNote.point], visibleNote.text); }}>
      <label>{t('New note')}<textarea ref={textarea} rows={4} value={visibleNote.text} disabled={busy}
        placeholder={t('Write a note…')} onChange={event => setNote({ ...visibleNote, text: event.target.value })} /></label>
      <div className="annotation-note-actions">
        <span>{t('Ctrl/⌘ + Enter to save')}</span>
        <button type="button" disabled={busy} onClick={clearDraft}>{t('Cancel')}</button>
        <button type="submit" disabled={locked || !visibleNote.text.trim()}>{t('Add note')}</button>
      </div>
    </form> : null}
    <div className={`annotation-drawing-hint${feedback?.error ? ' annotation-drawing-error' : ''}`} role={feedback?.error ? 'alert' : 'status'}>
      {busy ? t('Saving annotation…') : feedback ? t(feedback.text) : t(hint)}
    </div>
  </div>;
}
