import { describe, expect, it } from 'vitest';
import { languageSwitchHref } from './navigation';

describe('explicit site language navigation', () => {
  it.each(['/sign-in/', '/account/'])('removes an old language hint when choosing English on %s', path => {
    const search = '?lang=ja&desktop=attempt&state=keep&desktop_callback=komopdf%3A%2F%2Freturn&returnTo=%2Faccount%2F%3Fprofile%3D1';
    const target = new URL(languageSwitchHref(path, 'en', search, '#callback'), 'https://komopdf.com');
    expect(target.pathname).toBe(path);
    expect(target.searchParams.has('lang')).toBe(false);
    expect(target.searchParams.get('desktop')).toBe('attempt');
    expect(target.searchParams.get('state')).toBe('keep');
    expect(target.searchParams.get('desktop_callback')).toBe('komopdf://return');
    expect(target.searchParams.get('returnTo')).toBe('/account/?profile=1');
    expect(target.hash).toBe('#callback');
  });
  it('uses the existing localized-path helper for every explicit locale', () => {
    expect(languageSwitchHref('/ja/help/', 'fr', '?context=keep', '#guide')).toBe('/fr/help/?context=keep#guide');
  });
});
