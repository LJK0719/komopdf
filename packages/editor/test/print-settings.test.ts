import { describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, HostAdapter } from '@pdf-editor/contracts';
import { selectPrintPages } from '../src/ui/print-settings.js';
import { printCurrentPdf } from '../src/ui/PrintPanel.js';

const pages = ['a', 'b', 'c', 'd'];
describe('print settings', () => {
  it('selects all, current, and unique physical pages in document order', () => {
    expect(selectPrintPages('all', '', pages, 'b')).toEqual(pages);
    expect(selectPrintPages('current', '', pages, 'c')).toEqual(['c']);
    expect(selectPrintPages('range', '4,2-3,2', pages, 'b')).toEqual(['b', 'c', 'd']);
    expect(selectPrintPages('range', '3–1', pages, 'b')).toEqual(['a', 'b', 'c']);
  });
  it('rejects an empty or invalid range instead of silently printing everything', () => {
    expect(() => selectPrintPages('range', '', pages, 'a')).toThrow('Enter the pages');
    expect(() => selectPrintPages('range', '0,7', pages, 'a')).toThrow('outside');
    expect(() => selectPrintPages('current', '', pages, 'missing')).toThrow('outside');
  });
  it('sends only the selected page ids and copy count without marking the PDF saved', async () => {
    const result = { kind: 'native-file', docId: 'doc', savedRevision: 2, handle: 'snapshot' };
    const engine = { save: vi.fn().mockResolvedValue(result), confirmSave: vi.fn() } as unknown as EngineAdapter;
    const host = { capabilities: { platform: 'windows' }, printDocument: vi.fn().mockResolvedValue(undefined) } as unknown as HostAdapter;
    await printCurrentPdf(engine, 'doc', host, ['b', 'd'], false, 2);
    expect(host.printDocument).toHaveBeenCalledWith(result, ['b', 'd'], { copies: 2 });
    expect(engine.confirmSave).not.toHaveBeenCalled();
  });
  it('rejects invalid copies and empty selections before preparing a snapshot', async () => {
    const engine = { save: vi.fn() } as unknown as EngineAdapter;
    const host = { capabilities: { platform: 'windows' }, printDocument: vi.fn() } as unknown as HostAdapter;
    await expect(printCurrentPdf(engine, 'doc', host, ['a'], false, 0)).rejects.toThrow('1 and 99');
    await expect(printCurrentPdf(engine, 'doc', host, [], false, 1)).rejects.toThrow('pages');
    expect(engine.save).not.toHaveBeenCalled();
  });
});
