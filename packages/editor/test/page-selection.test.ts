import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, HostAdapter } from '@pdf-editor/contracts';
import type { LoadedDocument } from '../src/ui/EditorShell.js';
import { usePageTools } from '../src/ui/PageOrganizer.js';
import { movePages, selectPages } from '../src/ui/page-selection.js';

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], effects: [] as Array<() => void> }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[index], (value: unknown) => {
      hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useEffect(effect: () => void, dependencies: unknown[]) {
    const index = hooks.cursor++, previous = hooks.values[index] as unknown[] | undefined;
    if (!previous || dependencies.some((value, position) => !Object.is(value, previous[position]))) {
      hooks.values[index] = dependencies; hooks.effects.push(effect);
    }
  },
}));
vi.mock('../src/ui/i18n.js', () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock('../src/ui/page-import.js', () => ({ usePageImport: () => ({ openImport: vi.fn() }) }));

type PageToolsOptions = Parameters<typeof usePageTools>[0];
function renderTools(options: PageToolsOptions) {
  hooks.cursor = 0;
  usePageTools(options);
  for (const effect of hooks.effects.splice(0)) effect();
  hooks.cursor = 0;
  return usePageTools(options);
}
function createOptions(pageId = 'a'): PageToolsOptions {
  return {
    document: { name: 'test.pdf', info: { id: 'doc-1', revision: 0, pageOrder: order,
      permissions: { modify: true, copy: true }, capabilities: ['pages.insert', 'pages.import'] },
      page: { id: pageId, widthPt: 612, heightPt: 792 } } as LoadedDocument,
    engine: {
      extractPages: vi.fn().mockResolvedValue({ kind: 'bytes', docId: 'doc-1', sourceRevision: 0, bytes: new ArrayBuffer(4) }),
      registerResource: vi.fn().mockResolvedValue({ id: 'copied-pages', kind: 'pdf' }),
    } as unknown as EngineAdapter,
    host: { saveDocument: vi.fn().mockResolvedValue({ status: 'written' }) } as unknown as HostAdapter,
    disabled: false, execute: vi.fn().mockResolvedValue(true), onBusy: vi.fn(), onError: vi.fn(), onNotice: vi.fn(),
  };
}

const order = ['a', 'b', 'c', 'd', 'e'];
describe('page selection', () => {
  it('replaces a single selection and toggles Ctrl / Cmd selections in document order', () => {
    expect(selectPages(order, ['b'], 'b', 'd', {})).toEqual(['d']);
    expect(selectPages(order, ['d'], 'd', 'a', { ctrlKey: true })).toEqual(['a', 'd']);
    expect(selectPages(order, ['a', 'd'], 'd', 'a', { metaKey: true })).toEqual(['d']);
  });
  it('extends forward or backward from the unchanged anchor', () => {
    expect(selectPages(order, ['d'], 'd', 'b', { shiftKey: true })).toEqual(['b', 'c', 'd']);
    expect(selectPages(order, ['b', 'c', 'd'], 'd', 'c', { shiftKey: true })).toEqual(['c', 'd']);
    expect(selectPages(order, ['a'], 'c', 'e', { shiftKey: true, metaKey: true })).toEqual(['a', 'c', 'd', 'e']);
  });
  it('moves multiple pages in original order and ignores a drop onto the selection', () => {
    expect(movePages(order, ['a', 'c'], 'e', true)).toEqual(['b', 'd', 'e', 'a', 'c']);
    expect(movePages(order, ['d', 'e'], 'b', false)).toEqual(['a', 'd', 'e', 'b', 'c']);
    expect(movePages(order, ['a', 'c'], 'c', true)).toEqual(order);
  });
});

describe('page tools navigation and extraction', () => {
  beforeEach(() => { hooks.cursor = 0; hooks.values = []; hooks.effects = []; });

  it('uses the newly read page for extraction and blank-page insertion', async () => {
    const options = createOptions();
    expect(renderTools(options).ids).toEqual(['a']);
    options.document = { ...options.document!, page: { ...options.document!.page, id: 'c' } };
    const tools = renderTools(options);
    expect(tools.ids).toEqual(['c']);
    expect(tools.focus).toBe('c');
    await tools.run('extractPages');
    expect(options.engine.extractPages).toHaveBeenCalledWith({ docId: 'doc-1', pageIds: ['c'] });
    await tools.run('blankPage');
    expect(options.execute).toHaveBeenCalledWith([expect.objectContaining({ type: 'pages.insert', afterPageId: 'c' })]);
  });

  it('preserves explicit multiple-page selection while the read page stays unchanged', () => {
    const options = createOptions();
    renderTools(options).select('c', { ctrlKey: true });
    expect(renderTools(options).ids).toEqual(['a', 'c']);
    options.document = { ...options.document!, info: { ...options.document!.info, revision: 1 } };
    const tools = renderTools(options);
    expect(tools.ids).toEqual(['a', 'c']);
    expect(tools.focus).toBe('c');
  });

  it('retains copied pages when navigating within the document', async () => {
    const options = createOptions();
    await renderTools(options).run('copyPages');
    options.document = { ...options.document!, page: { ...options.document!.page, id: 'c' } };
    const tools = renderTools(options);
    expect(tools.can('pastePages')).toBe(true);
    await tools.run('pastePages');
    expect(options.execute).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'pages.import', resourceId: 'copied-pages', afterPageId: 'c' }),
    ], new Set(['copied-pages']));
  });

  it('reports cancellation rather than success when extraction saving is cancelled', async () => {
    const options = createOptions();
    vi.mocked(options.host.saveDocument).mockResolvedValue({ status: 'cancelled' });
    await renderTools(options).run('extractPages');
    expect(options.onNotice).toHaveBeenCalledExactlyOnceWith('Export cancelled');
    expect(options.onBusy).toHaveBeenLastCalledWith(false);
    expect(options.onError).not.toHaveBeenCalled();
  });

  it.each([
    ['written', 'Selected pages exported.'],
    ['download-started', 'Selected pages download started.'],
  ] as const)('retains the %s extraction result', async (status, notice) => {
    const options = createOptions();
    vi.mocked(options.host.saveDocument).mockResolvedValue({ status });
    await renderTools(options).run('extractPages');
    expect(options.onNotice).toHaveBeenCalledExactlyOnceWith(notice);
  });
});
