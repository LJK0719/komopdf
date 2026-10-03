import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Tooltip, ViewControls } from '../src/ui/EditorChrome.js';
import { calculateFitZoom, captureReadingZoomAnchor, readingZoomScrollDelta, formatZoomPercent, parseZoomPercent } from '../src/ui/view-zoom.js';

const viewport = { width: 1056, height: 870, paddingX: 56, paddingY: 70, columnGap: 18 };
const portrait = { widthPt: 600, heightPt: 800 };

describe('reading zoom percentages', () => {
  it('accepts arbitrary decimal percentages and optional percent signs', () => {
    expect(parseZoomPercent('133.75')).toBe(1.3375);
    expect(parseZoomPercent(' 87.5 % ')).toBe(0.875);
    expect(parseZoomPercent('100%')).toBe(1);
    expect(formatZoomPercent(1.3375)).toBe('133.75%');
    expect(formatZoomPercent(1)).toBe('100%');
  });

  it('keeps the existing 25–400% limits', () => {
    expect(parseZoomPercent('1')).toBe(0.25);
    expect(parseZoomPercent('900%')).toBe(4);
    expect(parseZoomPercent('25')).toBe(0.25);
    expect(parseZoomPercent('400')).toBe(4);
  });

  it('rejects incomplete and invalid input so the control can restore the current value', () => {
    for (const text of ['', ' ', '%', '.', '0', '-50', 'abc', '100%%', '1e3', 'Infinity', 'NaN', '50px']) {
      expect(parseZoomPercent(text), text).toBeNull();
    }
  });
});

describe('reading fit modes', () => {
  it('fits width without constraining height, or fits the complete page', () => {
    expect(calculateFitZoom('fit-width', portrait, viewport)).toBeCloseTo(999 / 600);
    expect(calculateFitZoom('fit-page', portrait, viewport)).toBe(1);
  });

  it('recalculates for narrower sidebars/windows and different page dimensions', () => {
    expect(calculateFitZoom('fit-width', portrait, { ...viewport, width: 756 })).toBeCloseTo(699 / 600);
    expect(calculateFitZoom('fit-page', portrait, { ...viewport, height: 470 })).toBe(0.5);
    expect(calculateFitZoom('fit-page', { widthPt: 1200, heightPt: 600 }, viewport)).toBeCloseTo(999 / 1200);
  });

  it('uses actual facing-page dimensions and an unscaled gap, including a final single page', () => {
    const facing = { widthPt: 600 + 800, heightPt: 800, columns: 2 as const };
    const scale = calculateFitZoom('fit-width', facing, viewport)!;
    expect(scale).toBeCloseTo((1000 - 18 - 2) / 1400);
    expect(Math.ceil(600 * scale) + Math.ceil(800 * scale) + viewport.columnGap + viewport.paddingX).toBeLessThanOrEqual(viewport.width);
    expect(calculateFitZoom('fit-width', { ...portrait, columns: 1 }, viewport)).toBeCloseTo(999 / 600);
  });

  it('respects zoom bounds and ignores unavailable viewport/page dimensions', () => {
    expect(calculateFitZoom('fit-page', { widthPt: 10, heightPt: 10 }, viewport)).toBe(4);
    expect(calculateFitZoom('fit-page', { widthPt: 10000, heightPt: 10000 }, viewport)).toBe(0.25);
    expect(calculateFitZoom('fit-page', portrait, { ...viewport, width: 0 })).toBeNull();
    expect(calculateFitZoom('fit-page', portrait, { ...viewport, height: 0 })).toBeNull();
    expect(calculateFitZoom('fit-page', { widthPt: 0, heightPt: 800 }, viewport)).toBeNull();
  });
});

describe('reading zoom anchors', () => {
  const viewport = { left: 40, top: 220 };
  const scrolledPage = { left: -160, top: -280 };

  it('keeps the visible PDF point while zooming into a scrolled page on both axes', () => {
    const anchor = captureReadingZoomAnchor(scrolledPage, viewport, 1);
    expect(anchor).toEqual({ xPt: 200, yPt: 500, offsetX: 0, offsetY: 0 });
    expect(readingZoomScrollDelta(anchor, scrolledPage, viewport, 2)).toEqual({ left: 200, top: 500 });
  });

  it('scales the reading point down and accounts for preceding pages changing height', () => {
    const anchor = captureReadingZoomAnchor(scrolledPage, viewport, 2);
    const movedPage = { left: -80, top: -130 };
    const delta = readingZoomScrollDelta(anchor, movedPage, viewport, 1);
    expect(delta).toEqual({ left: -20, top: -100 });
    expect((viewport.top - (movedPage.top - delta.top))).toBe(anchor.yPt);
  });

  it('keeps the page margin when the beginning of the page is visible', () => {
    const anchor = captureReadingZoomAnchor({ left: 100, top: 244 }, viewport, 1.25);
    expect(anchor).toEqual({ xPt: 0, yPt: 0, offsetX: 60, offsetY: 24 });
    expect(readingZoomScrollDelta(anchor, { left: 80, top: 256 }, viewport, 2)).toEqual({ left: -20, top: 12 });
  });
});

describe('view controls compatibility', () => {
  const props = { page: 1, pages: 3, zoom: 1.3375, busy: false, onPage: vi.fn(), onZoom: vi.fn(), onFit: vi.fn() };
  const render = (extra = {}) => renderToStaticMarkup(createElement(Tooltip.Provider, null, createElement(ViewControls, { ...props, ...extra })));

  it('keeps the original props usable and exposes an editable percentage with presets', () => {
    const html = render();
    expect(html).toContain('type="text"');
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('value="133.75%"');
    expect(html).toContain('<datalist');
    expect(html).not.toContain('aria-label="Fit width"');
  });

  it('exposes both fit actions and marks the selected fit mode', () => {
    const html = render({ onFitWidth: vi.fn(), zoomMode: 'fit-width' });
    expect(html).toMatch(/aria-label="Fit width"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/aria-label="Fit page"[^>]*aria-pressed="false"/);
  });
});
