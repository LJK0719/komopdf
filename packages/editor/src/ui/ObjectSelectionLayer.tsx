import { translate as t, useI18n } from './i18n.js';
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { PageModel, RenderResult } from '@pdf-editor/contracts';
import { containsRect, isContainerInterior, pickObject, selectionScope } from './object-selection.js';

type ScaleHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type Props = {
  page: PageModel;
  render: RenderResult;
  selectedIds: string[];
  disabled: boolean;
  canTransform: boolean;
  onSelect(id: string, additive: boolean): void;
  onBoxSelect(ids: string[]): void;
  onEditText(id: string): void;
  onMove(ids: string[], dx: number, dy: number): Promise<void>;
  onTransform?(ids: string[], matrix: [number, number, number, number, number, number]): Promise<void>;
};

type SelectionBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  widthPt: number;
  heightPt: number;
  cxPt: number;
  cyPt: number;
  boxLeft: number;
  boxTop: number;
  boxWidth: number;
  boxHeight: number;
};

type Gesture =
  | { type: 'box'; pointerId: number; startX: number; startY: number; additive: boolean; clickId?: string }
  | { type: 'move'; pointerId: number; startX: number; startY: number; ids: string[]; clickId: string; additive: boolean }
  | { type: 'scale'; pointerId: number; startX: number; startY: number; handle: ScaleHandle; ids: string[]; bounds: SelectionBounds }
  | { type: 'rotate'; pointerId: number; startX: number; startY: number; startAngle: number; ids: string[]; bounds: SelectionBounds };

type Preview =
  | { type: 'box'; x: number; y: number; dx: number; dy: number }
  | { type: 'move'; dx: number; dy: number; ids: string[] }
  | { type: 'scale'; sx: number; sy: number; originX: string; originY: string; matrix: [number, number, number, number, number, number]; ids: string[] }
  | { type: 'rotate'; angleDegrees: number; matrix: [number, number, number, number, number, number]; ids: string[] };

const HANDLES: Array<{
  handle: ScaleHandle;
  xPct: number;
  yPct: number;
  label: string;
}> = [
  { handle: 'nw', xPct: 0, yPct: 0, label: 'Scale top-left' },
  { handle: 'n', xPct: 50, yPct: 0, label: 'Scale top' },
  { handle: 'ne', xPct: 100, yPct: 0, label: 'Scale top-right' },
  { handle: 'e', xPct: 100, yPct: 50, label: 'Scale right' },
  { handle: 'se', xPct: 100, yPct: 100, label: 'Scale bottom-right' },
  { handle: 's', xPct: 50, yPct: 100, label: 'Scale bottom' },
  { handle: 'sw', xPct: 0, yPct: 100, label: 'Scale bottom-left' },
  { handle: 'w', xPct: 0, yPct: 50, label: 'Scale left' },
];

function getScaleAnchor(handle: ScaleHandle, b: SelectionBounds): { ax: number; ay: number; originX: string; originY: string } {
  switch (handle) {
    case 'nw': return { ax: b.maxX, ay: b.maxY, originX: '100%', originY: '100%' };
    case 'ne': return { ax: b.minX, ay: b.maxY, originX: '0%', originY: '100%' };
    case 'se': return { ax: b.minX, ay: b.minY, originX: '0%', originY: '0%' };
    case 'sw': return { ax: b.maxX, ay: b.minY, originX: '100%', originY: '0%' };
    case 'n': return { ax: b.cxPt, ay: b.maxY, originX: '50%', originY: '100%' };
    case 's': return { ax: b.cxPt, ay: b.minY, originX: '50%', originY: '0%' };
    case 'w': return { ax: b.maxX, ay: b.cyPt, originX: '100%', originY: '50%' };
    case 'e': return { ax: b.minX, ay: b.cyPt, originX: '0%', originY: '50%' };
  }
}

function computeScaleMatrix(
  handle: ScaleHandle,
  b: SelectionBounds,
  currentX: number,
  currentY: number,
  isShift: boolean,
): { matrix: [number, number, number, number, number, number]; sx: number; sy: number; originX: string; originY: string } {
  const { ax, ay, originX, originY } = getScaleAnchor(handle, b);
  let newWidthPx = b.boxWidth;
  let newHeightPx = b.boxHeight;

  if (handle === 'se' || handle === 'e' || handle === 'ne') {
    newWidthPx = currentX - b.boxLeft;
  } else if (handle === 'nw' || handle === 'w' || handle === 'sw') {
    newWidthPx = (b.boxLeft + b.boxWidth) - currentX;
  }

  if (handle === 'se' || handle === 's' || handle === 'sw') {
    newHeightPx = currentY - b.boxTop;
  } else if (handle === 'nw' || handle === 'n' || handle === 'ne') {
    newHeightPx = (b.boxTop + b.boxHeight) - currentY;
  }

  let sx = handle === 'n' || handle === 's' ? 1 : newWidthPx / b.boxWidth;
  let sy = handle === 'e' || handle === 'w' ? 1 : newHeightPx / b.boxHeight;

  sx = Math.max(0.05, sx);
  sy = Math.max(0.05, sy);

  if (isShift && (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw')) {
    const s = Math.max(sx, sy);
    sx = s;
    sy = s;
  }

  const matrix: [number, number, number, number, number, number] = [
    sx, 0, 0, sy, (1 - sx) * ax, (1 - sy) * ay,
  ];

  return { matrix, sx, sy, originX, originY };
}

function computeRotateMatrix(
  b: SelectionBounds,
  startAngle: number,
  currentX: number,
  currentY: number,
  isShift: boolean,
): { matrix: [number, number, number, number, number, number]; angleRadians: number; angleDegrees: number } {
  const centerX = b.boxLeft + b.boxWidth / 2;
  const centerY = b.boxTop + b.boxHeight / 2;
  const currentAngle = Math.atan2(currentY - centerY, currentX - centerX);
  let angleDiff = currentAngle - startAngle;

  let deg = (angleDiff * 180) / Math.PI;
  if (isShift) {
    deg = Math.round(deg / 15) * 15;
    angleDiff = (deg * Math.PI) / 180;
  }

  const cos = Math.cos(angleDiff);
  const sin = Math.sin(angleDiff);
  const matrix: [number, number, number, number, number, number] = [
    cos,
    sin,
    -sin,
    cos,
    b.cxPt - cos * b.cxPt + sin * b.cyPt,
    b.cyPt - sin * b.cxPt - cos * b.cyPt,
  ];

  return { matrix, angleRadians: angleDiff, angleDegrees: deg };
}

export function ObjectSelectionLayer({
  page,
  render,
  selectedIds,
  disabled,
  canTransform,
  onSelect,
  onBoxSelect,
  onEditText,
  onMove,
  onTransform,
}: Props) {
  useI18n();
  const scaleX = render.width / page.widthPt;
  const scaleY = render.height / page.heightPt;
  const layerRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  const names = { text: 'Text', image: 'Image', path: 'Path', form: 'Form', group: 'Group', shading: 'Gradient' };
  const selectedObjects = page.objects.filter(object => selectedIds.includes(object.id));
  const objects = selectionScope(page, selectedIds);
  const stacking = new Map(objects.slice().sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)
    .map((object, index) => [object.id, index]));
  const hitAt = (clientX: number, clientY: number) => {
    const rect = layerRef.current!.getBoundingClientRect();
    return pickObject(objects, (clientX - rect.left) / scaleX, (clientY - rect.top) / scaleY, 3 / Math.max(scaleX, scaleY));
  };
  let bounds: SelectionBounds | null = null;
  if (selectedObjects.length > 0) {
    const minX = Math.min(...selectedObjects.map(o => o.bounds.x));
    const minY = Math.min(...selectedObjects.map(o => o.bounds.y));
    const maxX = Math.max(...selectedObjects.map(o => o.bounds.x + o.bounds.width));
    const maxY = Math.max(...selectedObjects.map(o => o.bounds.y + o.bounds.height));
    const widthPt = maxX - minX;
    const heightPt = maxY - minY;
    bounds = {
      minX,
      minY,
      maxX,
      maxY,
      widthPt,
      heightPt,
      cxPt: (minX + maxX) / 2,
      cyPt: (minY + maxY) / 2,
      boxLeft: minX * scaleX,
      boxTop: minY * scaleY,
      boxWidth: Math.max(widthPt * scaleX, 4),
      boxHeight: Math.max(heightPt * scaleY, 4),
    };
  }

  const handleHandlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    handle: ScaleHandle | 'rotate',
  ) => {
    event.stopPropagation();
    if (disabled || !canTransform || event.button !== 0 || !bounds) return;
    const layer = layerRef.current;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    const startX = event.clientX - rect.left;
    const startY = event.clientY - rect.top;

    if (handle === 'rotate') {
      const centerX = bounds.boxLeft + bounds.boxWidth / 2;
      const centerY = bounds.boxTop + bounds.boxHeight / 2;
      const startAngle = Math.atan2(startY - centerY, startX - centerX);
      gesture.current = {
        type: 'rotate',
        pointerId: event.pointerId,
        startX,
        startY,
        startAngle,
        ids: selectedIds,
        bounds,
      };
    } else {
      gesture.current = {
        type: 'scale',
        pointerId: event.pointerId,
        startX,
        startY,
        handle,
        ids: selectedIds,
        bounds,
      };
    }
    moved.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleHandleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    type: 'scale' | 'rotate',
    scaleHandle?: ScaleHandle,
  ) => {
    if (disabled || !canTransform || !selectedIds.length || !bounds || !onTransform) return;
    const isShift = event.shiftKey;
    let matrix: [number, number, number, number, number, number] | null = null;

    if (type === 'scale' && scaleHandle) {
      let factor = 1;
      if (event.key === 'ArrowUp' || event.key === 'ArrowRight' || event.key === '+' || event.key === '=') {
        factor = isShift ? 1.02 : 1.1;
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === '-') {
        factor = isShift ? 0.98 : 0.9;
      }
      if (factor !== 1) {
        event.preventDefault();
        const { ax, ay } = getScaleAnchor(scaleHandle, bounds);
        matrix = [factor, 0, 0, factor, (1 - factor) * ax, (1 - factor) * ay];
      }
    } else if (type === 'rotate') {
      let degrees = 0;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        degrees = isShift ? 5 : 15;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        degrees = isShift ? -5 : -15;
      }
      if (degrees !== 0) {
        event.preventDefault();
        const radians = (degrees * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        matrix = [
          cos,
          sin,
          -sin,
          cos,
          bounds.cxPt - cos * bounds.cxPt + sin * bounds.cyPt,
          bounds.cyPt - sin * bounds.cxPt - cos * bounds.cyPt,
        ];
      }
    }

    if (matrix) {
      void onTransform(selectedIds, matrix);
    }
  };

  let selectionBoxTransform: CSSProperties = {};
  if (preview) {
    if (preview.type === 'move') {
      selectionBoxTransform = { transform: `translate(${preview.dx}px, ${preview.dy}px)` };
    } else if (preview.type === 'scale') {
      selectionBoxTransform = {
        transformOrigin: `${preview.originX} ${preview.originY}`,
        transform: `scale(${preview.sx}, ${preview.sy})`,
      };
    } else if (preview.type === 'rotate') {
      selectionBoxTransform = {
        transformOrigin: '50% 50%',
        transform: `rotate(${preview.angleDegrees}deg)`,
      };
    }
  }

  return (
    <div
      ref={layerRef}
      className="selection-layer"
      style={{ width: render.width, height: render.height, pointerEvents: 'auto', touchAction: 'none' }}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => {
        if (disabled || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const object = hitAt(event.clientX, event.clientY);
        if (object?.type === 'group') {
          const path = [...object.locator.containerPath, object.locator.objectIndex];
          onBoxSelect(page.objects.filter(child => child.locator.containerPath.length === path.length &&
            path.every((part, i) => child.locator.containerPath[i] === part)).map(child => child.id));
        } else if (object?.textBlock) onEditText(object.id);
      }}
      onPointerDown={event => {
        if (disabled || event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const startX = event.clientX - rect.left, startY = event.clientY - rect.top;
        const object = hitAt(event.clientX, event.clientY);
        const additive = event.ctrlKey || event.metaKey || event.shiftKey;
        const box = !object || !canTransform || event.altKey || additive ||
          isContainerInterior(object, objects, startX / scaleX, startY / scaleY, 6 / Math.max(scaleX, scaleY));
        gesture.current = box
          ? { type: 'box', pointerId: event.pointerId, startX, startY, additive, ...(object ? { clickId: object.id } : {}) }
          : { type: 'move', pointerId: event.pointerId, startX, startY, additive, clickId: object.id,
              ids: selectedIds.includes(object.id) ? selectedIds : [object.id] };
        moved.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const active = gesture.current;
        if (!active || active.pointerId !== event.pointerId || disabled) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const currentX = event.clientX - rect.left;
        const currentY = event.clientY - rect.top;
        const dx = currentX - active.startX;
        const dy = currentY - active.startY;

        if (active.type === 'box') {
          if (Math.hypot(dx, dy) >= 3) moved.current = true;
          if (moved.current) setPreview({ type: 'box', x: active.startX, y: active.startY, dx, dy });
        } else if (active.type === 'move') {
          if (Math.hypot(dx, dy) >= 3) moved.current = true;
          if (moved.current) setPreview({ type: 'move', dx, dy, ids: active.ids });
        } else if (active.type === 'scale') {
          if (Math.hypot(dx, dy) >= 3) moved.current = true;
          if (moved.current) {
            const res = computeScaleMatrix(active.handle, active.bounds, currentX, currentY, event.shiftKey);
            setPreview({
              type: 'scale',
              sx: res.sx,
              sy: res.sy,
              originX: res.originX,
              originY: res.originY,
              matrix: res.matrix,
              ids: active.ids,
            });
          }
        } else if (active.type === 'rotate') {
          const res = computeRotateMatrix(active.bounds, active.startAngle, currentX, currentY, event.shiftKey);
          if (Math.abs(res.angleRadians) >= 0.02) moved.current = true;
          if (moved.current) {
            setPreview({
              type: 'rotate',
              angleDegrees: res.angleDegrees,
              matrix: res.matrix,
              ids: active.ids,
            });
          }
        }
      }}
      onPointerUp={event => {
        const active = gesture.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const currentX = event.clientX - rect.left;
        const currentY = event.clientY - rect.top;
        const dx = currentX - active.startX;
        const dy = currentY - active.startY;

        gesture.current = null;
        setPreview(null);
        if (disabled) return;

        if (active.type === 'box') {
          if (!moved.current) {
            if (active.clickId) onSelect(active.clickId, active.additive);
            else if (!active.additive) onBoxSelect([]);
          } else {
            const left = Math.min(active.startX, active.startX + dx) / scaleX;
            const top = Math.min(active.startY, active.startY + dy) / scaleY;
            const right = left + Math.abs(dx) / scaleX;
            const bottom = top + Math.abs(dy) / scaleY;
            const box = { x: left, y: top, width: right - left, height: bottom - top };
            const enclosed = objects.filter(object => containsRect(box, object.bounds, 1 / scaleX));
            // A selected Form already owns its children; never transform both twice.
            const ids = enclosed.filter(object => !enclosed.some(parent => parent.id !== object.id &&
              ['form', 'group'].includes(parent.type) &&
              object.locator.containerPath.length > parent.locator.containerPath.length &&
              [...parent.locator.containerPath, parent.locator.objectIndex].every((part, i) => object.locator.containerPath[i] === part)))
              .map(object => object.id);
            onBoxSelect(active.additive ? [...new Set([...selectedIds, ...ids])] : ids);
          }
        } else if (active.type === 'move') {
          if (moved.current) {
            onBoxSelect(active.ids);
            void onMove(active.ids, dx / scaleX, dy / scaleY);
          } else onSelect(active.clickId, active.additive);
        } else if (active.type === 'scale') {
          if (moved.current && onTransform) {
            const res = computeScaleMatrix(active.handle, active.bounds, currentX, currentY, event.shiftKey);
            void onTransform(active.ids, res.matrix);
          }
        } else if (active.type === 'rotate') {
          if (moved.current && onTransform) {
            const res = computeRotateMatrix(active.bounds, active.startAngle, currentX, currentY, event.shiftKey);
            void onTransform(active.ids, res.matrix);
          }
        }
      }}
      onPointerCancel={() => {
        gesture.current = null;
        setPreview(null);
        moved.current = false;
      }}
    >
      {objects.map(object => {
          const selected = selectedIds.includes(object.id);
          const moving = preview?.type === 'move' && preview.ids.includes(object.id);
          return (
            <button
              type="button"
              key={object.id}
              disabled={disabled}
              data-object-id={object.id}
              data-object-type={object.type}
              className={selected ? 'object-hitbox object-hitbox-selected' : 'object-hitbox'}
              style={{
                zIndex: stacking.get(object.id),
                left: object.bounds.x * scaleX,
                top: object.bounds.y * scaleY,
                width: Math.max(object.bounds.width * scaleX, 6),
                height: Math.max(object.bounds.height * scaleY, 6),
                ...(moving && preview?.type === 'move'
                  ? { transform: `translate(${preview.dx}px, ${preview.dy}px)` }
                  : {}),
              }}
              onClick={event => {
                event.stopPropagation();
                if (!disabled && event.detail === 0) onSelect(object.id, event.ctrlKey || event.metaKey || event.shiftKey);
              }}
              aria-pressed={selected}
              aria-label={`Select ${names[object.type]} object`}
            />
          );
        })}

      {bounds && selectedObjects.length > 0 && (
        <div
          className="selection-box"
          style={{
            zIndex: objects.length + 1,
            left: bounds.boxLeft,
            top: bounds.boxTop,
            width: bounds.boxWidth,
            height: bounds.boxHeight,
            ...selectionBoxTransform,
          }}
        >
          <div className="selection-box-outline" aria-hidden="true" />
          {canTransform && (
            <>
              <div className="selection-rotate-stem" aria-hidden="true" />
              <button
                type="button"
                className="selection-handle selection-handle-rotate"
                data-handle="rotate"
                aria-label={t("Rotate selected objects")}
                disabled={disabled}
                tabIndex={disabled ? -1 : 0}
                onPointerDown={event => handleHandlePointerDown(event, 'rotate')}
                onKeyDown={event => handleHandleKeyDown(event, 'rotate')}
              />
              {HANDLES.map(h => (
                <button
                  key={h.handle}
                  type="button"
                  className="selection-handle"
                  data-handle={`scale-${h.handle}`}
                  aria-label={t(h.label)}
                  style={{ left: `${h.xPct}%`, top: `${h.yPct}%` }}
                  disabled={disabled}
                  tabIndex={disabled ? -1 : 0}
                  onPointerDown={event => handleHandlePointerDown(event, h.handle)}
                  onKeyDown={event => handleHandleKeyDown(event, 'scale', h.handle)}
                />
              ))}
            </>
          )}
        </div>
      )}

      {preview?.type === 'box' && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            zIndex: objects.length + 2,
            pointerEvents: 'none',
            left: Math.min(preview.x, preview.x + preview.dx),
            top: Math.min(preview.y, preview.y + preview.dy),
            width: Math.abs(preview.dx),
            height: Math.abs(preview.dy),
            border: '1px solid #2563eb',
            background: '#2563eb20',
          }}
        />
      )}
    </div>
  );
}
