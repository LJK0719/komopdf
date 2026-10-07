import { useLayoutEffect, useRef, useState } from 'react';

export const AI_PANEL_DEFAULT_WIDTH = 400;
export const AI_PANEL_MIN_WIDTH = 320;
export const AI_PANEL_MAX_WIDTH = 720;
const CANVAS_MIN_WIDTH = 320;
const OVERLAY_GUTTER = 16;
const STORAGE_KEY = 'komopdf.ui.ai-panel-width.v1';

type PanelSpace = {
  workspace: number;
  navigation: number;
  rail: number;
  utility: number;
  narrow: boolean;
};

export function panelResizeBounds({ workspace, navigation, rail, utility, narrow }: PanelSpace) {
  const available = Math.max(0, workspace - navigation - utility);
  const overlay = narrow || available - rail < AI_PANEL_MIN_WIDTH + CANVAS_MIN_WIDTH;
  const max = Math.max(0, Math.floor(Math.min(AI_PANEL_MAX_WIDTH,
    available - (overlay ? OVERLAY_GUTTER : rail + CANVAS_MIN_WIDTH))));
  return { min: Math.min(AI_PANEL_MIN_WIDTH, max), max, overlay };
}

export function clampPanelWidth(width: number, bounds: { min: number; max: number }) {
  return Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
}

export function parsePanelWidth(saved: string | null) {
  const width = saved?.trim() ? Number(saved) : NaN;
  return Number.isFinite(width) && width >= AI_PANEL_MIN_WIDTH && width <= AI_PANEL_MAX_WIDTH
    ? width : AI_PANEL_DEFAULT_WIDTH;
}

/** Resize the outer grid/overlay without rendering the document tree on pointermove. */
export function usePanelResize(enabled: boolean, railVisible: boolean) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const preferredWidth = useRef<number | null>(null);
  // Only drag boundaries enter React state, to pause the caller's fit-zoom observer.
  const [resizing, setResizing] = useState(false);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const separator = separatorRef.current;
    if (!enabled || !workspace || !separator) return;
    const ownerWindow = workspace.ownerDocument.defaultView!;
    if (preferredWidth.current === null) {
      try { preferredWidth.current = parsePanelWidth(ownerWindow.localStorage.getItem(STORAGE_KEY)); }
      catch { preferredWidth.current = AI_PANEL_DEFAULT_WIDTH; }
    }
    const navigation = workspace.querySelector<HTMLElement>('.navigation-tools')!;
    const rail = workspace.querySelector<HTMLElement>('.page-rail')!;
    const utility = workspace.querySelector<HTMLElement>('.utility-tools')!;
    let bounds = panelResizeBounds({ workspace: 0, navigation: 0, rail: 0, utility: 0, narrow: true });
    let width = AI_PANEL_DEFAULT_WIDTH;
    let drag: { pointerId: number; x: number; width: number; preference: number; moved: boolean } | null = null;

    const apply = (requested: number) => {
      width = clampPanelWidth(requested, bounds);
      workspace.style.setProperty('--ai-panel-size', `${width}px`);
      separator.setAttribute('aria-valuemin', String(Math.round(bounds.min)));
      separator.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
      separator.setAttribute('aria-valuenow', String(width));
    };
    const measure = () => {
      bounds = panelResizeBounds({
        workspace: workspace.getBoundingClientRect().width,
        navigation: navigation.getBoundingClientRect().width,
        rail: rail.hidden ? 0 : rail.getBoundingClientRect().width,
        utility: utility.getBoundingClientRect().width,
        narrow: ownerWindow.matchMedia('(max-width: 760px)').matches,
      });
      workspace.dataset.aiOverlay = String(bounds.overlay);
      // Window/layout changes only clamp the display; never replace the user's preference.
      apply(preferredWidth.current!);
    };
    const persist = () => {
      try { ownerWindow.localStorage.setItem(STORAGE_KEY, String(preferredWidth.current)); }
      catch { /* Width preferences are optional in private browsing. */ }
    };
    const finish = (commit: boolean) => {
      if (!drag) return;
      const completed = drag;
      drag = null;
      workspace.classList.remove('is-resizing-ai-panel');
      setResizing(false);
      if (commit && completed.moved) persist();
      if (!commit) { preferredWidth.current = completed.preference; apply(completed.preference); }
      if (separator.hasPointerCapture(completed.pointerId)) separator.releasePointerCapture(completed.pointerId);
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || drag) return;
      event.preventDefault();
      separator.focus({ preventScroll: true });
      separator.setPointerCapture(event.pointerId);
      drag = { pointerId: event.pointerId, x: event.clientX, width, preference: preferredWidth.current!, moved: false };
      workspace.classList.add('is-resizing-ai-panel');
      setResizing(true);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId || (!drag.moved && event.clientX === drag.x)) return;
      event.preventDefault();
      drag.moved = true;
      preferredWidth.current = Math.max(AI_PANEL_MIN_WIDTH, clampPanelWidth(drag.width + drag.x - event.clientX, bounds));
      apply(preferredWidth.current);
    };
    const pointerUp = (event: PointerEvent) => { if (event.pointerId === drag?.pointerId) finish(true); };
    const pointerCancel = (event: PointerEvent) => { if (event.pointerId === drag?.pointerId) finish(false); };
    const reset = () => {
      finish(false);
      preferredWidth.current = AI_PANEL_DEFAULT_WIDTH;
      apply(AI_PANEL_DEFAULT_WIDTH);
      persist();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Home') { reset(); return; }
      finish(false);
      const step = event.shiftKey ? 40 : 16;
      preferredWidth.current = Math.max(AI_PANEL_MIN_WIDTH, clampPanelWidth(width + (event.key === 'ArrowLeft' ? step : -step), bounds));
      apply(preferredWidth.current);
      persist();
    };

    measure();
    const observer = new ResizeObserver(measure);
    for (const node of [workspace, navigation, rail, utility]) observer.observe(node);
    ownerWindow.addEventListener('resize', measure);
    separator.addEventListener('pointerdown', pointerDown);
    separator.addEventListener('pointermove', pointerMove);
    separator.addEventListener('pointerup', pointerUp);
    separator.addEventListener('pointercancel', pointerCancel);
    separator.addEventListener('lostpointercapture', pointerCancel);
    separator.addEventListener('dblclick', reset);
    separator.addEventListener('keydown', keyDown);
    return () => {
      finish(false);
      observer.disconnect();
      ownerWindow.removeEventListener('resize', measure);
      separator.removeEventListener('pointerdown', pointerDown);
      separator.removeEventListener('pointermove', pointerMove);
      separator.removeEventListener('pointerup', pointerUp);
      separator.removeEventListener('pointercancel', pointerCancel);
      separator.removeEventListener('lostpointercapture', pointerCancel);
      separator.removeEventListener('dblclick', reset);
      separator.removeEventListener('keydown', keyDown);
      workspace.style.removeProperty('--ai-panel-size');
      delete workspace.dataset.aiOverlay;
    };
  }, [enabled, railVisible]);

  return { workspaceRef, separatorRef, resizing };
}
