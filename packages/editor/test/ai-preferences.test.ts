import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiPreferenceKey, preferredAiLanguage, saveAiLanguage } from '../src/ui/ai-preferences.js';

describe('account-scoped AI defaults', () => {
  let data: Map<string, string>;
  beforeEach(() => { data = new Map(); vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) }); });
  afterEach(() => vi.unstubAllGlobals());
  it('persists each account and guest separately, including a later changed target', () => {
    saveAiLanguage('alice', 'fr'); saveAiLanguage('bob', 'ja'); saveAiLanguage(null, 'zh');
    expect(preferredAiLanguage('en', 'alice')).toBe('fr'); expect(preferredAiLanguage('en', 'bob')).toBe('ja');
    expect(preferredAiLanguage('en', null)).toBe('zh');
    saveAiLanguage('alice', 'de'); expect(preferredAiLanguage('en', 'alice')).toBe('de'); expect(preferredAiLanguage('en', 'bob')).toBe('ja');
  });
  it('does not read or write guest settings while the account is still loading', () => {
    saveAiLanguage(null, 'fr'); saveAiLanguage(undefined, 'ja');
    expect(preferredAiLanguage('zh-CN', undefined)).toBe('zh'); expect(preferredAiLanguage('en', null)).toBe('fr');
    expect(data.size).toBe(1);
  });
  it('keeps legacy values guest-only and ignores invalid stored languages', () => {
    data.set('komopdf.ai.target-language.v1', 'ko');
    expect(preferredAiLanguage('en', null)).toBe('ko'); expect(preferredAiLanguage('en', 'alice')).toBe('en');
    data.set(aiPreferenceKey('alice'), '{"targetLanguage":"invalid"}'); expect(preferredAiLanguage('zh-CN', 'alice')).toBe('zh');
    saveAiLanguage('alice', 'invalid'); expect(data.get(aiPreferenceKey('alice'))).toBe('{"targetLanguage":"invalid"}');
  });
});
