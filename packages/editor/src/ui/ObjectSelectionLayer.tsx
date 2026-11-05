import { translate as t, useI18n } from './i18n.js';
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { EditableObject, PageModel, Rect } from '@pdf-editor/contracts';
import type { PageGeometry } from './draw-render.js';
import { frameBounds, localFrameDelta, resizedTextFrame, selectionTextFrame, type TextFrame } from './text-frame.js';
import { containsRect, isContainerInterior, normalizeSelection, pickObject, selectionScope } from './object-selection.js';
import { hitText, textClusters, type TextHit } from './text-geometry.js';

type ScaleHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type SelectionPointerStart = Pick<PointerEvent, 'pointerId' | 'button' | 'clientX' | 'clientY' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;
export type SelectionPointerIntent = {
  start: SelectionPointerStart; latest: SelectionPointerStart; ended: boolean; pageVersion: number; tool: 'select' | 'edit';
};
export const ObjectSelectionStartContext = createContext<{
  current: SelectionPointerIntent | null; onConsumed(): void;
} | null>(null);

/** Replay an ended gesture without attempting to capture a pointer that is up. */
export function resumePointerIntent(intent: SelectionPointerIntent, handlers: {
  start(event: SelectionPointerStart, capture: boolean): void;
  move(event: SelectionPointerStart): void;
  end(event: SelectionPointerStart): void;
}): void {
  handlers.start(intent.start, !intent.ended);
  handlers.move(intent.latest);
  if (intent.ended) handlers.end(intent.latest);
}

export function selectionPointer(event: SelectionPointerStart): SelectionPointerStart {
  const { pointerId, button, clientX, clientY, ctrlKey, metaKey, shiftKey, altKey } = event;
  return { pointerId, button, clientX, clientY, ctrlKey, metaKey, shiftKey, altKey };
}

export function selectionLayerPoint(clientX: number, clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, render: PageGeometry): [number, number] {
  return [(clientX - rect.left) * render.width / rect.width, (clientY - rect.top) * render.height / rect.height];
}

type Props = {
  page: PageModel;
  render: PageGeometry;
  selectedIds: string[];
  disabled: boolean;
  canTransform: boolean;
  onSelect(id: string, additive: boolean): void;
  onBoxSelect(ids: string[]): void;
  onEditText(id: string, hit?: TextHit): void;
  onMove(ids: string[], dx: number, dy: number): Promise<void>;
  onTransform?(ids: string[], matrix: [number, number, number, number, number, number]): Promise<void>;
  onResizeText?: ((ids: string[], frame: Rect) => Promise<void>) | undefined;
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
  | { type: 'scale'; pointerId: number; startX: number; startY: number; handle: ScaleHandle; ids: string[]; bounds: SelectionBounds; textFrame: TextFrame | null }
  | { type: 'rotate'; pointerId: number; startX: number; startY: number; startAngle: number; ids: string[]; bounds: SelectionBounds };

type Preview =
  | { type: 'box'; x: number; y: number; dx: number; dy: number }
  | { type: 'move'; dx: number; dy: number; ids: string[] }
  | { type: 'scale'; sx: number; sy: number; originX: string; originY: string; matrix: [number, number, number, number, number, number]; ids: string[] }
  | { type: 'rotate'; angleDegrees: number; matrix: [number, number, number, number, number, number]; ids: string[] }
  | { type: 'resize-text'; bounds: Rect };

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

export function keyboardScaleMatrix(handle: ScaleHandle, bounds: SelectionBounds, factor: number): [number, number, number, number, number, number] {
  const sx = handle === 'n' || handle === 's' ? 1 : factor;
  const sy = handle === 'e' || handle === 'w' ? 1 : factor;
  const { ax, ay } = getScaleAnchor(handle, bounds);
  return [sx, 0, 0, sy, (1 - sx) * ax, (1 - sy) * ay];
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

const names = { text: 'Text', image: 'Image', path: 'Path', form: 'Form', group: 'Group', shading: 'Gradient' };
const ObjectHitbox = memo(function ObjectHitbox({ object, label, selected, hovered, disabled, zIndex, dx, dy, onSelect }: {
  object: EditableObject; label: string; selected: boolean; hovered: boolean; disabled: boolean; zIndex: number | undefined;
  dx: number; dy: number; onSelect: Props['onSelect'];
}) {
  return <button type="button" disabled={disabled} data-object-id={object.id} data-object-type={object.type}
    className={`object-hitbox${selected ? ' object-hitbox-selected' : ''}${object.textBlock ? ' object-hitbox-text' : ''}${hovered ? ' object-hitbox-hovered' : ''}`}
    style={{ zIndex, left: object.bounds.x, top: object.bounds.y, width: object.bounds.width, height: object.bounds.height,
      ...(dx || dy ? { transform: `translate(${dx}px, ${dy}px)` } : {}) }}
    onClick={event => { event.stopPropagation(); if (!disabled && event.detail === 0) onSelect(object.id, event.ctrlKey || event.metaKey || event.shiftKey); }}
    aria-pressed={selected} aria-label={label} />;
});

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
  onResizeText,
}: Props) {
  const { locale } = useI18n();
  const scaleX = render.width / page.widthPt;
  const scaleY = render.height / page.heightPt;
  const layerRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const previewFrame = useRef(0);
  const nextPreview = useRef<Preview | null>(null);
  const schedulePreview = (next: Preview) => {
    nextPreview.current = next;
    if (!previewFrame.current) previewFrame.current = requestAnimationFrame(() => {
      previewFrame.current = 0;
      setPreview(nextPreview.current);
    });
  };
  const clearPreview = () => {
    cancelAnimationFrame(previewFrame.current);
    previewFrame.current = 0;
    nextPreview.current = null;
    setPreview(null);
  };
  useEffect(() => () => cancelAnimationFrame(previewFrame.current), []);

  const objects = useMemo(() => selectionScope(page, selectedIds), [page, selectedIds]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const idsFor = (object: EditableObject) => object.textBlock?.sourceObjectIds ?? [object.id];
  const selectedObjects = useMemo(() => objects.filter(object => idsFor(object).some(id => selectedSet.has(id))), [objects, selectedSet]);
  const textFrame = useMemo(() => selectionTextFrame(page, selectedObjects), [page, selectedObjects]);
  const textOnly = selectedObjects.length === 1 && Boolean(selectedObjects[0]?.textBlock);
  const hoveredObject = useMemo(() => hoveredId ? objects.find(object => object.id === hoveredId
    && !idsFor(object).some(id => selectedSet.has(id))) : undefined, [objects, hoveredId, selectedSet]);
  const hoveredBounds = useMemo(() => {
    const frame = hoveredObject?.textBlock ? selectionTextFrame(page, [hoveredObject]) : null;
    return frame ? frameBounds(frame) : hoveredObject?.bounds;
  }, [page, hoveredObject]);
  const resizeEnabled = !textOnly || Boolean(textFrame && onResizeText);
  const stacking = useMemo(() => new Map(objects.slice().sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)
    .map((object, index) => [object.id, index])), [objects]);
  const movingIds = preview?.type === 'move' ? preview.ids : null;
  const movingSet = useMemo(() => new Set(movingIds), [movingIds]);
  const selectCallback = useRef(onSelect); selectCallback.current = onSelect;
  const selectHitbox = useCallback((id: string, additive: boolean) => selectCallback.current(id, additive), []);
  const moveX = preview?.type === 'move' ? preview.dx / scaleX : 0;
  const moveY = preview?.type === 'move' ? preview.dy / scaleY : 0;
  const hitboxes = useMemo(() => objects.map(object => {
    const moving = idsFor(object).some(id => movingSet.has(id));
    return <ObjectHitbox key={object.id} object={object} label={t('Select {type} object', { type: t(names[object.type]) })} selected={idsFor(object).some(id => selectedSet.has(id))}
      hovered={!disabled && hoveredId === object.id} disabled={disabled} zIndex={stacking.get(object.id)}
      dx={moving ? moveX : 0} dy={moving ? moveY : 0} onSelect={selectHitbox} />;
  }), [objects, selectedSet, movingSet, hoveredId, disabled, stacking, moveX, moveY, selectHitbox, locale]);
  const hitAt = (clientX: number, clientY: number) => {
    const rect = layerRef.current!.getBoundingClientRect();
    const [x, y] = selectionLayerPoint(clientX, clientY, rect, render);
    return pickObject(objects, x / scaleX, y / scaleY, 3 / Math.max(scaleX, scaleY));
  };
  const bounds = useMemo<SelectionBounds | null>(() => {
    if (!selectedObjects.length) return null;
    const boxes = textFrame ? [frameBounds(textFrame)] : selectedObjects.map(object => object.bounds);
    const minX = Math.min(...boxes.map(box => box.x));
    const minY = Math.min(...boxes.map(box => box.y));
    const maxX = Math.max(...boxes.map(box => box.x + box.width));
    const maxY = Math.max(...boxes.map(box => box.y + box.height));
    const widthPt = maxX - minX;
    const heightPt = maxY - minY;
    return {
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
  }, [selectedObjects, textFrame, scaleX, scaleY]);

  const updateSelection = (event: SelectionPointerStart, layer: HTMLDivElement) => {
    const active = gesture.current;
    if (!active) { setHoveredId(disabled ? null : hitAt(event.clientX, event.clientY)?.id ?? null); return; }
    if (active.pointerId !== event.pointerId || disabled) return;
    const rect = layer.getBoundingClientRect();
    const [currentX, currentY] = selectionLayerPoint(event.clientX, event.clientY, rect, render);
    const dx = currentX - active.startX, dy = currentY - active.startY;
    if (active.type === 'box' || active.type === 'move') {
      if (Math.hypot(dx, dy) >= 3) moved.current = true;
      if (moved.current) schedulePreview(active.type === 'box'
        ? { type: 'box', x: active.startX, y: active.startY, dx, dy }
        : { type: 'move', dx, dy, ids: active.ids });
    } else if (active.type === 'scale') {
      if (Math.hypot(dx, dy) >= 3) moved.current = true;
      if (moved.current) {
        if (active.textFrame) {
          const [localX, localY] = localFrameDelta(active.textFrame, dx / scaleX, dy / scaleY);
          const frame = resizedTextFrame(active.textFrame, active.handle, localX, localY);
          schedulePreview({ type: 'resize-text', bounds: frameBounds(active.textFrame, frame) });
          return;
        }
        const result = computeScaleMatrix(active.handle, active.bounds, currentX, currentY, event.shiftKey);
        schedulePreview({ type: 'scale', ...result, ids: active.ids });
      }
    } else {
      const result = computeRotateMatrix(active.bounds, active.startAngle, currentX, currentY, event.shiftKey);
      if (Math.abs(result.angleRadians) >= 0.02) moved.current = true;
      if (moved.current) schedulePreview({ type: 'rotate', angleDegrees: result.angleDegrees, matrix: result.matrix, ids: active.ids });
    }
  };
  const finishSelection = (event: SelectionPointerStart, layer: HTMLDivElement) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    // The final coordinates also cover a move coalesced with pointerup.
    updateSelection(event, layer);
    const rect = layer.getBoundingClientRect();
    const [currentX, currentY] = selectionLayerPoint(event.clientX, event.clientY, rect, render);
    const dx = currentX - active.startX, dy = currentY - active.startY;
    gesture.current = null;
    clearPreview();
    if (layer.hasPointerCapture(event.pointerId)) layer.releasePointerCapture(event.pointerId);
    if (disabled) return;
    if (active.type === 'box') {
      if (!moved.current) {
        if (active.clickId) onSelect(active.clickId, active.additive);
        else if (!active.additive) onBoxSelect([]);
      } else {
        const left = Math.min(active.startX, active.startX + dx) / scaleX;
        const top = Math.min(active.startY, active.startY + dy) / scaleY;
        const box = { x: left, y: top, width: Math.abs(dx) / scaleX, height: Math.abs(dy) / scaleY };
        const ids = objects.filter(object => containsRect(box, object.bounds, 1 / scaleX)).flatMap(idsFor);
        onBoxSelect(normalizeSelection(page, active.additive ? [...new Set([...selectedIds, ...ids])] : ids));
      }
    } else if (active.type === 'move') {
      if (moved.current) { onBoxSelect(active.ids); void onMove(active.ids, dx / scaleX, dy / scaleY); }
      else onSelect(active.clickId, active.additive);
    } else if (active.type === 'scale') {
      if (moved.current && active.textFrame && onResizeText) {
        const [localX, localY] = localFrameDelta(active.textFrame, dx / scaleX, dy / scaleY);
        void onResizeText(active.textFrame.objectIds, resizedTextFrame(active.textFrame, active.handle, localX, localY));
      } else if (moved.current && onTransform && !textOnly) {
        void onTransform(active.ids, computeScaleMatrix(active.handle, active.bounds, currentX, currentY, event.shiftKey).matrix);
      }
    } else if (moved.current && onTransform) {
      void onTransform(active.ids, computeRotateMatrix(active.bounds, active.startAngle, currentX, currentY, event.shiftKey).matrix);
    }
  };
  const beginSelection = (event: SelectionPointerStart, layer: HTMLDivElement, capture = true) => {
    if (disabled || event.button !== 0) return;
    const rect = layer.getBoundingClientRect();
    const [startX, startY] = selectionLayerPoint(event.clientX, event.clientY, rect, render);
    const object = hitAt(event.clientX, event.clientY);
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const box = !object || !canTransform || event.altKey || additive ||
      isContainerInterior(object, objects, startX / scaleX, startY / scaleY, 6 / Math.max(scaleX, scaleY));
    gesture.current = box
      ? { type: 'box', pointerId: event.pointerId, startX, startY, additive, ...(object ? { clickId: object.id } : {}) }
      : { type: 'move', pointerId: event.pointerId, startX, startY, additive, clickId: object.id,
          ids: idsFor(object).some(id => selectedIds.includes(id)) ? selectedIds : idsFor(object) };
    moved.current = false;
    if (capture) layer.setPointerCapture(event.pointerId);
  };
  const activationStart = useContext(ObjectSelectionStartContext);
  useLayoutEffect(() => {
    const intent = activationStart?.current, layer = layerRef.current;
    if (!intent || intent.tool !== 'edit' || !layer || disabled) return;
    activationStart.current = null; activationStart.onConsumed();
    resumePointerIntent(intent, {
      start: (event, capture) => beginSelection(event, layer, capture),
      move: event => updateSelection(event, layer),
      end: event => finishSelection(event, layer),
    });
  }, [activationStart, page, disabled]);

  const handleHandlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    handle: ScaleHandle | 'rotate',
  ) => {
    event.stopPropagation();
    if (disabled || !canTransform || event.button !== 0 || !bounds || (handle !== 'rotate' && !resizeEnabled)) return;
    const layer = layerRef.current;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    const [startX, startY] = selectionLayerPoint(event.clientX, event.clientY, rect, render);

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
        textFrame,
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
        if (textOnly) {
          if (!textFrame || !onResizeText) return;
          const dx = textFrame.width * (factor - 1) * (scaleHandle.includes('w') ? -1 : 1);
          const dy = textFrame.height * (factor - 1) * (scaleHandle.includes('n') ? -1 : 1);
          void onResizeText(textFrame.objectIds, resizedTextFrame(textFrame, scaleHandle, dx, dy));
          return;
        }
        matrix = keyboardScaleMatrix(scaleHandle, bounds, factor);
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
    } else if (preview.type === 'resize-text') {
      selectionBoxTransform = { left: preview.bounds.x * scaleX, top: preview.bounds.y * scaleY,
        width: Math.max(preview.bounds.width * scaleX, 4), height: Math.max(preview.bounds.height * scaleY, 4) };
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
        } else if (object?.textBlock) {
          const rect = event.currentTarget.getBoundingClientRect();
          const [localX, localY] = selectionLayerPoint(event.clientX, event.clientY, rect, render);
          const x = localX / scaleX, y = localY / scaleY;
          const ids = new Set(object.textBlock.sourceObjectIds);
          const sources = page.objects.filter(item => item.id === object.id || ids.has(item.id));
          let nearest: { id: string; hit: TextHit } | undefined, distance = Infinity;
          for (const source of sources) {
            if (!source.textBlock) continue;
            const hit = hitText(textClusters(source.textBlock), x, y);
            if (!hit) continue;
            const b = hit.bounds, score = (x - b.x - b.width / 2) ** 2 + (y - b.y - b.height / 2) ** 2;
            if (score < distance) { nearest = { id: source.id, hit }; distance = score; }
          }
          onEditText(nearest?.id ?? object.id, nearest?.hit);
        }
      }}
      onPointerDown={event => beginSelection(event, event.currentTarget)}
      onPointerLeave={() => setHoveredId(null)}
      onPointerMove={event => updateSelection(event, event.currentTarget)}
      onPointerUp={event => finishSelection(event, event.currentTarget)}
      onPointerCancel={() => {
        gesture.current = null;
        clearPreview();
        moved.current = false;
      }}
    >
      <div className="object-hitboxes" style={{ width: page.widthPt, height: page.heightPt,
        transform: `scale(${scaleX}, ${scaleY})` }}>{hitboxes}</div>

      {hoveredBounds && !disabled && <div className={`object-text-hover${hoveredObject?.textBlock ? '' : ' object-shape-hover'}`} aria-hidden="true" style={{
        zIndex: objects.length, left: hoveredBounds.x * scaleX, top: hoveredBounds.y * scaleY,
        width: Math.max(hoveredBounds.width * scaleX, hoveredObject?.textBlock ? 0 : 6),
        height: Math.max(hoveredBounds.height * scaleY, hoveredObject?.textBlock ? 0 : 6),
      }} />}

      {bounds && selectedObjects.length > 0 && (
        <div
          className={`selection-box${textOnly ? ' selection-box-text' : ''}`}
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
