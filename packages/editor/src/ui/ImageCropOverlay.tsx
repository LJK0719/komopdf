import { useRef, useState } from 'react';
import type { Rect } from '@pdf-editor/contracts';
import { useI18n } from './i18n.js';

export function ImageCropOverlay({ bounds, scale, disabled, onCrop, onCancel, page = false }: {
  bounds: Rect; scale: number; disabled: boolean; page?: boolean; onCrop(bounds: Rect): void; onCancel(): void;
}) {
  const { t } = useI18n();
  const [crop, setCrop] = useState<Rect>({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  const start = useRef<{ x: number; y: number } | null>(null);
  return <div className={`crop-overlay ${page ? 'page-crop-overlay' : ''}`} style={{ left: bounds.x * scale, top: bounds.y * scale, width: bounds.width * scale, height: bounds.height * scale }}
    onClick={event => event.stopPropagation()}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || (event.target as HTMLElement).closest('.crop-actions')) return;
      event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect();
      start.current = { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (!start.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = Math.min(bounds.width, Math.max(0, (event.clientX - rect.left) / scale));
      const y = Math.min(bounds.height, Math.max(0, (event.clientY - rect.top) / scale));
      setCrop({ x: Math.min(start.current.x, x), y: Math.min(start.current.y, y), width: Math.abs(x - start.current.x), height: Math.abs(y - start.current.y) });
    }} onPointerUp={() => { start.current = null; }} onPointerCancel={() => { start.current = null; }}>
    <div className="crop-selection" style={{ left: crop.x * scale, top: crop.y * scale, width: crop.width * scale, height: crop.height * scale }} />
    <div className="crop-actions"><span>{t('Drag to select the area to keep.')}</span>
      <button type="button" disabled={disabled || crop.width < 1 || crop.height < 1} onClick={() => onCrop({ ...crop, x: bounds.x + crop.x, y: bounds.y + crop.y })}>{t('Crop')}</button>
      <button type="button" disabled={disabled} onClick={onCancel}>{t('Cancel')}</button>
    </div>
  </div>;
}
