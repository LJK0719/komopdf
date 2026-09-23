import { useRef, useState } from 'react';
import type { PageModel, RenderResult } from '@pdf-editor/contracts';

type Props = { page: PageModel; render: RenderResult; selectedIds: string[]; disabled: boolean; canTransform: boolean;
  onSelect(id: string, additive: boolean): void; onBoxSelect(ids: string[]): void;
  onMove(ids: string[], dx: number, dy: number): Promise<void> };
type Gesture = { pointerId: number; startX: number; startY: number; ids: string[] | null; additive: boolean };

export function ObjectSelectionLayer({ page, render, selectedIds, disabled, canTransform, onSelect, onBoxSelect, onMove }: Props) {
  const scaleX = render.width / page.widthPt, scaleY = render.height / page.heightPt;
  const gesture = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const [preview, setPreview] = useState<{ x: number; y: number; dx: number; dy: number; ids: string[] | null } | null>(null);
  const names = { text: 'Text', image: 'Image', path: 'Path', form: 'Form', group: 'Group' };
  return <div className="selection-layer" style={{ width: render.width, height: render.height, pointerEvents: 'auto', touchAction: 'none' }}
    onClick={event => event.stopPropagation()}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      gesture.current = { pointerId: event.pointerId, startX: event.clientX - rect.left, startY: event.clientY - rect.top,
        ids: null, additive: event.ctrlKey || event.metaKey || event.shiftKey };
      moved.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId || disabled) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const dx = event.clientX - rect.left - active.startX, dy = event.clientY - rect.top - active.startY;
      if (Math.hypot(dx, dy) >= 3) moved.current = true;
      if (moved.current) setPreview({ x: active.startX, y: active.startY, dx, dy, ids: active.ids });
    }}
    onPointerUp={event => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      gesture.current = null; setPreview(null);
      const rect = event.currentTarget.getBoundingClientRect();
      const dx = event.clientX - rect.left - active.startX, dy = event.clientY - rect.top - active.startY;
      if (disabled) return;
      if (active.ids) {
        if (moved.current) { onBoxSelect(active.ids); void onMove(active.ids, dx / scaleX, dy / scaleY); }
      } else if (!moved.current) {
        if (!active.additive) onBoxSelect([]);
      } else {
        const left = Math.min(active.startX, active.startX + dx) / scaleX;
        const top = Math.min(active.startY, active.startY + dy) / scaleY;
        const right = left + Math.abs(dx) / scaleX, bottom = top + Math.abs(dy) / scaleY;
        const ids = page.objects.filter(object => {
          const b = object.bounds;
          return object.locator.containerPath.length === 0 && b.x < right && b.x + b.width > left && b.y < bottom && b.y + b.height > top;
        }).map(object => object.id);
        onBoxSelect(active.additive ? [...new Set([...selectedIds, ...ids])] : ids);
      }
    }}
    onPointerCancel={() => { gesture.current = null; setPreview(null); moved.current = false; }}>
    {page.objects.map(object => {
      const selected = selectedIds.includes(object.id);
      const moving = preview?.ids?.includes(object.id);
      return <button type="button" key={object.id} data-object-id={object.id} data-object-type={object.type}
        className={selected ? 'object-hitbox object-hitbox-selected' : 'object-hitbox'}
        style={{ left: object.bounds.x * scaleX, top: object.bounds.y * scaleY,
          width: Math.max(object.bounds.width * scaleX, 6), height: Math.max(object.bounds.height * scaleY, 6),
          ...(moving && preview ? { transform: `translate(${preview.dx}px, ${preview.dy}px)` } : {}) }}
        onPointerDown={event => {
          moved.current = false;
          if (disabled || !canTransform || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const layer = event.currentTarget.parentElement!;
          const rect = layer.getBoundingClientRect();
          gesture.current = { pointerId: event.pointerId, startX: event.clientX - rect.left, startY: event.clientY - rect.top,
            ids: selected ? selectedIds : [object.id], additive: false };
          moved.current = false;
          // Keep click targeting on the button while pointer events bubble to the layer.
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onClick={event => {
          event.stopPropagation();
          if (disabled) return;
          if (moved.current) { moved.current = false; return; }
          onSelect(object.id, event.ctrlKey || event.metaKey || event.shiftKey);
        }}
        aria-pressed={selected} aria-label={`Select ${names[object.type]} object`} />;
    })}
    {preview && !preview.ids && <div aria-hidden="true" style={{ position: 'absolute', pointerEvents: 'none',
      left: Math.min(preview.x, preview.x + preview.dx), top: Math.min(preview.y, preview.y + preview.dy),
      width: Math.abs(preview.dx), height: Math.abs(preview.dy), border: '1px solid #2563eb', background: '#2563eb20' }} />}
  </div>;
}
