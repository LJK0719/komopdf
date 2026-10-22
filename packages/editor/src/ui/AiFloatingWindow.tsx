import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GripHorizontal, X } from 'lucide-react';
import { useI18n } from './i18n.js';
import type { TextActionSelection } from './text-actions.js';

type Position = { left: number; top: number };
export function AiFloatingWindow({ title, anchor, hidden, onClose, children }: {
  title: string; anchor?: TextActionSelection['anchor']; hidden: boolean; onClose(): void; children: ReactNode;
}) {
  const { t } = useI18n();
  const windowRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>({ left: 16, top: 160 });
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const clamp = (value: Position) => {
    const rect = windowRef.current?.getBoundingClientRect();
    return { left: Math.max(8, Math.min(value.left, window.innerWidth - (rect?.width ?? 560) - 8)),
      top: Math.max(8, Math.min(value.top, window.innerHeight - (rect?.height ?? 360) - 8)) };
  };
  useLayoutEffect(() => {
    if (hidden) return;
    const width = windowRef.current?.getBoundingClientRect().width ?? 560;
    const left = anchor && anchor.right + width + 20 <= window.innerWidth ? anchor.right + 12 : anchor?.left ?? (window.innerWidth - width) / 2;
    setPosition(clamp({ left, top: anchor ? anchor.bottom + 10 : 160 }));
    const resize = () => setPosition(previous => {
      const next = clamp(previous); return next.left === previous.left && next.top === previous.top ? previous : next;
    });
    const observer = new ResizeObserver(resize);
    if (windowRef.current) observer.observe(windowRef.current);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [hidden, anchor]);
  return createPortal(<div ref={windowRef} className="ai-floating-window ai-owned-focus" role="dialog" aria-modal="false" aria-label={title}
    hidden={hidden} style={{ left: position.left, top: position.top }} onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); onClose(); }
    }}>
    <header className="ai-floating-title" onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest('button')) return;
      event.preventDefault();
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, ...position };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      const start = drag.current;
      if (start?.pointerId === event.pointerId) setPosition(clamp({ left: start.left + event.clientX - start.x, top: start.top + event.clientY - start.y }));
    }} onPointerUp={event => {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => { drag.current = null; }}>
      <GripHorizontal size={16} aria-hidden="true" /><strong>{title}</strong>
      <button type="button" className="icon-button" aria-label={t('Close AI window')} onClick={onClose}><X size={17} /></button>
    </header>{children}
  </div>, window.document.body);
}
