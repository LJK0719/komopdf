import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_PANEL_DEFAULT_WIDTH, clampPanelWidth, panelResizeBounds, parsePanelWidth } from '../src/ui/usePanelResize.js';

const desktop = { workspace: 1440, navigation: 42, rail: 156, utility: 42, narrow: false };

describe('AI panel width', () => {
  it('defaults to 400px and stays within 320–720px on a wide workspace', () => {
    const bounds = panelResizeBounds(desktop);
    expect(bounds).toEqual({ min: 320, max: 720, overlay: false });
    expect(clampPanelWidth(AI_PANEL_DEFAULT_WIDTH, bounds)).toBe(400);
    expect(clampPanelWidth(100, bounds)).toBe(320);
    expect(clampPanelWidth(1000, bounds)).toBe(720);
  });

  it('deducts actual navigation, rail and utility widths and reserves a 320px canvas', () => {
    const bounds = panelResizeBounds({ ...desktop, workspace: 900, rail: 120 });
    expect(bounds).toEqual({ min: 320, max: 376, overlay: false });
    expect(900 - 42 - 120 - 42 - clampPanelWidth(720, bounds)).toBe(320);
    expect(panelResizeBounds({ ...desktop, workspace: 1000, rail: 0 }).max).toBe(596);
    expect(panelResizeBounds({ ...desktop, workspace: 1000 }).max).toBe(440);
  });

  it('deducts the wider Files rail, including when there is no active PDF', () => {
    const bounds = panelResizeBounds({ ...desktop, workspace: 1100, rail: 244 });
    expect(bounds).toEqual({ min: 320, max: 452, overlay: false });
    expect(1100 - 42 - 244 - 42 - clampPanelWidth(720, bounds)).toBe(320);
    expect(panelResizeBounds({ ...desktop, workspace: 900, rail: 244 }).overlay).toBe(true);
    expect(panelResizeBounds({ ...desktop, workspace: 900, rail: 0 }).overlay).toBe(false);
  });

  it('uses an overlay when the workspace cannot fit both panel and canvas, even on a wide host', () => {
    expect(panelResizeBounds({ ...desktop, workspace: 600 })).toEqual({ min: 320, max: 500, overlay: true });
    expect(panelResizeBounds({ ...desktop, workspace: 880 })).toEqual({ min: 320, max: 320, overlay: false });
    expect(panelResizeBounds({ ...desktop, workspace: 879 }).overlay).toBe(true);
  });

  it('limits narrow overlays to workspace width, ignoring the floating rail and leaving a drag gutter', () => {
    const bounds = panelResizeBounds({ workspace: 320, navigation: 36, rail: 136, utility: 36, narrow: true });
    expect(bounds).toEqual({ min: 232, max: 232, overlay: true });
    expect(clampPanelWidth(400, bounds) + 36 + 36 + 16).toBe(320);
    expect(panelResizeBounds({ ...desktop, workspace: 760, navigation: 36, utility: 36, narrow: true }).max).toBe(672);
    expect(panelResizeBounds({ ...desktop, workspace: 50, narrow: true }).max).toBe(0);
  });

  it('floors fractional space so the applied pixel width cannot overflow', () => {
    const bounds = panelResizeBounds({ ...desktop, workspace: 1000.4 });
    expect(bounds.max).toBe(440);
    expect(clampPanelWidth(720, bounds)).toBeLessThanOrEqual(bounds.max);
  });

  it('clamps the display on shrink without losing the saved preference on expansion', () => {
    const preference = parsePanelWidth('640');
    expect(clampPanelWidth(preference, panelResizeBounds({ ...desktop, workspace: 900, rail: 120 }))).toBe(376);
    expect(clampPanelWidth(preference, panelResizeBounds(desktop))).toBe(640);
    expect(preference).toBe(640);
  });

  it('accepts valid saved preferences and falls back for absent or invalid storage', () => {
    for (const saved of ['320', '400', '720', ' 512 ']) expect(parsePanelWidth(saved)).toBe(Number(saved));
    for (const saved of [null, '', ' ', 'broken', 'NaN', 'Infinity', '0', '319', '721']) {
      expect(parsePanelWidth(saved)).toBe(400);
    }
  });

  it('keeps transient resizing out of React state and cleans capture, cancel and listeners on unmount', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/usePanelResize.ts'), 'utf-8');
    const pointerMove = source.slice(source.indexOf('const pointerMove ='), source.indexOf('const pointerUp ='));
    expect(pointerMove).not.toContain('setResizing');
    expect(pointerMove).toContain('apply(preferredWidth.current)');
    expect(source).toContain('separator.setPointerCapture(event.pointerId)');
    expect(source).toContain('separator.releasePointerCapture(completed.pointerId)');
    expect(source).toContain("separator.addEventListener('pointercancel', pointerCancel)");
    expect(source).toContain("separator.addEventListener('lostpointercapture', pointerCancel)");
    expect(source).toContain("separator.removeEventListener('pointercancel', pointerCancel)");
    expect(source).toContain("separator.removeEventListener('lostpointercapture', pointerCancel)");
    expect(source).toContain('preferredWidth.current = completed.preference');
    expect(source).toContain('observer.disconnect()');
    expect(source).toContain("workspace.classList.remove('is-resizing-ai-panel')");
    expect(source).toContain("workspace.style.removeProperty('--ai-panel-size')");
    const measure = source.slice(source.indexOf('const measure ='), source.indexOf('const persist ='));
    expect(measure).not.toContain('preferredWidth.current =');
    expect(measure).not.toContain('setItem');
  });
});
