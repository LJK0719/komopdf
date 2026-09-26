import { afterEach, describe, expect, it } from 'vitest';
import { setUiLocale, translate } from '../src/ui/i18n.js';

afterEach(() => setUiLocale('en'));

describe('UI language', () => {
  it('switches between English and Simplified Chinese', () => {
    setUiLocale('zh-CN');
    expect(translate('Save')).toBe('保存');
    expect(translate('Organize pages')).toBe('整理页面');
    setUiLocale('en');
    expect(translate('Save')).toBe('Save');
  });

  it('interpolates labels without changing user-provided values', () => {
    setUiLocale('zh-CN');
    expect(translate('Open page {page}', { page: 12 })).toBe('打开第 12 页');
    expect(translate('My quarterly report.pdf')).toBe('My quarterly report.pdf');
  });
});
