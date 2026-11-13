import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GripHorizontal, X } from 'lucide-react';
import { useI18n } from './i18n.js';
import type { TextActionSelection } from './text-actions.js';

type Bounds = { left: number; top: number; width?: number; height?: number };
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const MARGIN = 8;

export function AiFloatingWindow({ title, anchor, hidden, onClose, children, closeLabel = 'Close AI window', className = '' }: {
  title: string; anchor?: TextActionSelection['anchor']; hidden: boolean; onClose(): void; children: ReactNode;
  closeLabel?: string; className?: string;
}) {
  const { t } = useI18n();
  const windowRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<Bounds>({ left: 16, top: 160 });
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const resize = useRef<{
    edge: ResizeEdge; pointerId: number; x: number; y: number;
    left: number; top: number; width: number; height: number;
  } | null>(null);

  const clamp = (value: Bounds): Bounds => {
    const measured = windowRef.current?.getBoundingClientRect();
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - MARGIN * 2);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - MARGIN * 2);
    const width = value.width !== undefined ? Math.max(MIN_WIDTH, Math.min(value.width, maxWidth)) : undefined;
    const height = value.height !== undefined ? Math.max(MIN_HEIGHT, Math.min(value.height, maxHeight)) : undefined;
    const effectiveWidth = width ?? measured?.width ?? 560;
    const effectiveHeight = height ?? measured?.height ?? 360;
    const left = Math.max(MARGIN, Math.min(value.left, window.innerWidth - effectiveWidth - MARGIN));
    const top = Math.max(MARGIN, Math.min(value.top, window.innerHeight - effectiveHeight - MARGIN));
    return { left, top, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
  };

  useLayoutEffect(() => {
    if (hidden) return;
    const width = windowRef.current?.getBoundingClientRect().width ?? 560;
    const left = anchor && anchor.right + width + 20 <= window.innerWidth ? anchor.right + 12 : anchor?.left ?? (window.innerWidth - width) / 2;
    setBounds(previous => clamp({
      left,
      top: anchor ? anchor.bottom + 10 : 160,
      ...(previous.width !== undefined ? { width: previous.width } : {}),
      ...(previous.height !== undefined ? { height: previous.height } : {}),
    }));
    const onViewportResize = () => setBounds(previous => {
      const next = clamp(previous);
      return next.left === previous.left && next.top === previous.top
        && next.width === previous.width && next.height === previous.height ? previous : next;
    });
    const observer = new ResizeObserver(onViewportResize);
    if (windowRef.current) observer.observe(windowRef.current);
    window.addEventListener('resize', onViewportResize);
    return () => { observer.disconnect(); window.removeEventListener('resize', onViewportResize); };
  }, [hidden, anchor]);

  const startResize = (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !windowRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = windowRef.current.getBoundingClientRect();
    resize.current = {
      edge, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resize.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    let { left, top, width, height } = start;
    if (start.edge.includes('e')) {
      width = Math.max(MIN_WIDTH, Math.min(start.width + dx, window.innerWidth - start.left - MARGIN));
    }
    if (start.edge.includes('s')) {
      height = Math.max(MIN_HEIGHT, Math.min(start.height + dy, window.innerHeight - start.top - MARGIN));
    }
    if (start.edge.includes('w')) {
      const right = start.left + start.width;
      const nextLeft = Math.max(MARGIN, Math.min(start.left + dx, right - MIN_WIDTH));
      left = nextLeft;
      width = right - nextLeft;
    }
    if (start.edge.includes('n')) {
      const bottom = start.top + start.height;
      const nextTop = Math.max(MARGIN, Math.min(start.top + dy, bottom - MIN_HEIGHT));
      top = nextTop;
      height = bottom - nextTop;
    }
    setBounds({ left, top, width, height });
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    resize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const style: React.CSSProperties = {
    left: bounds.left,
    top: bounds.top,
    ...(bounds.width !== undefined ? { width: bounds.width } : {}),
    ...(bounds.height !== undefined ? { height: bounds.height } : {}),
  };

  return createPortal(<div ref={windowRef} className={`ai-floating-window ai-owned-focus ${className}${bounds.height !== undefined ? ' ai-floating-resized' : ''}`}
    role="dialog" aria-modal="false" aria-label={title} hidden={hidden} style={style} onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); onClose(); }
    }}>
    <div className="ai-floating-surface">
      <header className="ai-floating-title" onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest('button')) return;
        event.preventDefault();
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        const start = drag.current;
        if (start?.pointerId === event.pointerId) {
          setBounds(previous => clamp({ ...previous, left: start.left + event.clientX - start.x, top: start.top + event.clientY - start.y }));
        }
      }} onPointerUp={event => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { drag.current = null; }}>
        <GripHorizontal size={16} aria-hidden="true" /><strong>{title}</strong>
        <button type="button" className="icon-button" aria-label={t(closeLabel)} onClick={onClose}><X size={17} /></button>
      </header>
      {children}
    </div>
    {RESIZE_EDGES.map(edge => (
      <div key={edge} aria-hidden="true" className={`ai-floating-resize ai-resize-${edge}`}
        onPointerDown={event => startResize(edge, event)}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={() => { resize.current = null; }} />
    ))}
  </div>, window.document.body);
}
