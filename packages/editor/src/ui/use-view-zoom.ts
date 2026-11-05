import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { calculateFitZoom, clampViewZoom, type ReadingZoomPoint, type ViewZoomMode, type ViewZoomSize, type ViewZoomViewport } from './view-zoom.js';

export type { ViewZoomMode, ViewZoomSize } from './view-zoom.js';

type ViewZoomOptions = {
  root: RefObject<HTMLElement | null>;
  documentKey: string | undefined;
  pageKey: string | undefined;
  size: ViewZoomSize | null;
  zoom: number;
  busy: boolean;
  enabled: boolean;
  onZoom(zoom: number, point?: ReadingZoomPoint): void | Promise<void>;
  onGestureZoom?(zoom: number, point?: ReadingZoomPoint): void | Promise<void>;
};

/** Reading-only zoom state; bitmap refinement never delays the logical view. */
export function useViewZoom(options: ViewZoomOptions) {
  const { root, documentKey, pageKey, size, zoom, busy, enabled } = options;
  const [selection, setSelection] = useState<{ documentKey: string | undefined; mode: ViewZoomMode }>({ documentKey, mode: 'manual' });
  const mode = selection.documentKey === documentKey ? selection.mode : 'manual';
  const [viewport, setViewport] = useState<ViewZoomViewport | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const attempted = useRef<{ documentKey: string; pageKey: string | undefined; mode: ViewZoomMode; scale: number } | null>(null);

  useLayoutEffect(() => {
    const stage = root.current;
    if (!stage || !enabled || !documentKey) { setViewport(null); return; }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const pages = stage.querySelector<HTMLElement>('.document-pages');
      if (!pages) { setViewport(null); return; }
      const style = getComputedStyle(pages);
      const px = (value: string) => Number.parseFloat(value) || 0;
      const next = {
        width: stage.clientWidth, height: stage.clientHeight,
        paddingX: px(style.paddingLeft) + px(style.paddingRight),
        paddingY: px(style.paddingTop) + px(style.paddingBottom),
        columnGap: px(style.columnGap),
      };
      setViewport(previous => previous && previous.width === next.width && previous.height === next.height
        && previous.paddingX === next.paddingX && previous.paddingY === next.paddingY && previous.columnGap === next.columnGap ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(measure); });
    observer.observe(stage);
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [root, documentKey, enabled, size?.columns]);

  useLayoutEffect(() => {
    if (!enabled || busy || !documentKey || mode === 'manual' || !size || !viewport) return;
    const scale = calculateFitZoom(mode, size, viewport);
    if (scale === null || Math.abs(scale - zoom) < 0.0001) return;
    const previous = attempted.current;
    if (previous?.documentKey === documentKey && previous.pageKey === pageKey && previous.mode === mode && previous.scale === scale) return;
    attempted.current = { documentKey, pageKey, mode, scale };
    void latest.current.onZoom(scale);
  }, [enabled, busy, documentKey, pageKey, mode, selection, size?.widthPt, size?.heightPt, size?.columns, viewport, zoom]);

  const selectMode = useCallback((next: ViewZoomMode) => {
    attempted.current = null;
    const documentKey = latest.current.documentKey;
    setSelection(previous => previous.documentKey === documentKey && previous.mode === next ? previous : { documentKey, mode: next });
  }, []);
  const exitFitMode = useCallback(() => selectMode('manual'), [selectMode]);
  const manualZoom = useCallback((scale: number, point?: ReadingZoomPoint) => {
    if (!Number.isFinite(scale) || scale <= 0) return;
    exitFitMode();
    return latest.current.onZoom(clampViewZoom(scale), point);
  }, [exitFitMode]);
  const gestureZoom = useCallback((scale: number, point?: ReadingZoomPoint) => {
    if (!Number.isFinite(scale) || scale <= 0) return;
    exitFitMode();
    const current = latest.current;
    return (current.onGestureZoom ?? current.onZoom)(clampViewZoom(scale), point);
  }, [exitFitMode]);
  const fitWidth = useCallback(() => selectMode('fit-width'), [selectMode]);
  const fitPage = useCallback(() => selectMode('fit-page'), [selectMode]);

  return { mode, fitWidth, fitPage, manualZoom, gestureZoom, exitFitMode };
}
