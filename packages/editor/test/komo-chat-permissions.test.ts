import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineAdapter } from '@pdf-editor/contracts';
import type { EditorAiContext } from '../src/ui/EditorShell.js';
import { KomoChatPanel } from '../src/ui/KomoChatPanel.js';
import { CHAT_COPY_RESTRICTED } from '../src/ui/komo-chat-context.js';
import { komoMessages } from '../src/ui/komo-messages.js';
import { setUiLocale, type UiLocale } from '../src/ui/i18n.js';

function context(copy: boolean): EditorAiContext {
  return { document: { id: 'restricted', revision: 0, savedRevision: 0, pageOrder: ['p1'], sourceIds: ['source'],
    permissions: { copy, modify: false, annotate: false, fillForms: false, encrypted: true, signed: false }, capabilities: [] },
    page: null, selectedIds: [], name: 'restricted.pdf', disabled: false,
    engine: { extract: vi.fn(), describePage: vi.fn(), render: vi.fn() } as unknown as EngineAdapter,
    onCommitted: async () => {}, openDocument: async () => null, saveDocument: async () => null };
}

afterEach(() => setUiLocale('en'));
describe('komo copy permission UI', () => {
  it.each(['en', 'zh-CN'] as UiLocale[])('explains the restriction in %s without presenting sharing or sending controls', locale => {
    setUiLocale(locale);
    const input = context(false);
    const html = renderToStaticMarkup(createElement(KomoChatPanel, { context: input }));
    const message = locale === 'en' ? CHAT_COPY_RESTRICTED : komoMessages[CHAT_COPY_RESTRICTED];
    expect(html).toContain(renderToStaticMarkup(createElement('p', { role: 'status' }, message)));
    expect(html).toContain('role="status"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain('id="komo-question"');
    expect(input.engine.extract).not.toHaveBeenCalled();
    expect(input.engine.render).not.toHaveBeenCalled();
  });

  it('keeps Q&A available for an encrypted document when copying is allowed', () => {
    const html = renderToStaticMarkup(createElement(KomoChatPanel, { context: context(true) }));
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('id="komo-question"');
    expect(html).not.toContain('copy-enabled version');
  });
});
