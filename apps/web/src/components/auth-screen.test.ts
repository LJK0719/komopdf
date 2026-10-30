import { describe, expect, it } from 'vitest';
import { needsDesktopAccountChoice, withoutAccountChoice } from './auth-screen';

describe('explicit desktop account selection', () => {
  it('does not interrupt the ordinary desktop or web sign-in return', () => {
    expect(needsDesktopAccountChoice(null)).toBe(false);
    expect(needsDesktopAccountChoice(new URLSearchParams('desktop=current-attempt&lang=en'))).toBe(false);
    expect(needsDesktopAccountChoice(new URLSearchParams('returnTo=%2Faccount%2F'))).toBe(false);
  });
  it('requires an explicit switch marker on the existing desktop sign-in attempt', () => {
    expect(needsDesktopAccountChoice(new URLSearchParams('desktop=current-attempt&switchAccount=1'))).toBe(true);
    expect(needsDesktopAccountChoice(new URLSearchParams('switchAccount=1'))).toBe(false);
    expect(needsDesktopAccountChoice(new URLSearchParams('desktop=current-attempt&switchAccount=0'))).toBe(false);
  });
  it('consumes only the chooser marker and preserves the original attempt and return parameters', () => {
    const original = new URLSearchParams('desktop=current-attempt&switchAccount=1&lang=zh-CN&returnTo=%2Faccount%2F');
    const selected = withoutAccountChoice(original);
    expect(needsDesktopAccountChoice(selected)).toBe(false);
    expect(selected.get('desktop')).toBe('current-attempt');
    expect(selected.get('lang')).toBe('zh-CN');
    expect(selected.get('returnTo')).toBe('/account/');
    expect(original.get('switchAccount')).toBe('1');
  });
  it('keeps the existing callback destination unchanged when no chooser was requested', () => {
    const ordinary = new URLSearchParams('desktop=current-attempt&lang=en');
    expect(withoutAccountChoice(ordinary).toString()).toBe(ordinary.toString());
  });
});
