import { describe, expect, it } from 'vitest';
import { UI_LOCALES } from '../src/ui/locales.js';
import { loadUiMessages, createUiTranslator } from '../src/ui/i18n-resources.js';
import { messages as source } from '../src/ui/messages.js';

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort();
}

describe('published language catalogs', () => {
  it.each(UI_LOCALES.filter(locale => locale.id !== 'en'))('$id covers the existing UI without losing interpolation parameters', async ({ id }) => {
    const messages = await loadUiMessages(id);
    const missing = Object.keys(source).filter(key => !messages[key]?.trim());
    expect(missing).toEqual([]);
    const mismatched = Object.entries(messages)
      .filter(([key, value]) => JSON.stringify(placeholders(key.replace(/_(?:zero|one|two|few|many|other)$/, ''))) !== JSON.stringify(placeholders(value)))
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
    expect(createUiTranslator(id, messages)('Save')).not.toBe('Save');
  });

  it('handles Russian one/few/many forms', async () => {
    const t = createUiTranslator('ru', await loadUiMessages('ru'));
    const one = t('{count} pages', { count: 1 });
    const few = t('{count} pages', { count: 2 });
    const many = t('{count} pages', { count: 5 });
    expect(one).toContain('1');
    expect(few).toContain('2');
    expect(many).toContain('5');
    expect(one.replace('1', '')).not.toBe(few.replace('2', ''));
    expect(few.replace('2', '')).not.toBe(many.replace('5', ''));
  });
});
