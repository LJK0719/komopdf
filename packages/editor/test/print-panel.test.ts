import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, HostAdapter } from '@pdf-editor/contracts';
import { printCurrentPdf } from '../src/ui/PrintPanel.js';

afterEach(() => vi.unstubAllGlobals());

describe('printCurrentPdf', () => {
  it('prints PDF bytes from the current revision without confirming a save', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]).buffer;
    const engine = { save: vi.fn().mockResolvedValue({ kind: 'bytes', docId: 'doc-1', savedRevision: 7, bytes }) } as unknown as EngineAdapter;
    const printWindow = new EventTarget() as EventTarget & { focus: ReturnType<typeof vi.fn>; print: ReturnType<typeof vi.fn> };
    printWindow.focus = vi.fn();
    printWindow.print = vi.fn();
    const frame = new EventTarget() as EventTarget & {
      title: string; style: { cssText: string }; src: string; contentWindow: typeof printWindow; remove: ReturnType<typeof vi.fn>;
    };
    frame.style = { cssText: '' };
    frame.contentWindow = printWindow;
    frame.remove = vi.fn();
    const appendChild = vi.fn(() => frame.dispatchEvent(new Event('load')));
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:print-pdf');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', { createElement: vi.fn(() => frame), body: { appendChild } });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    await printCurrentPdf(engine, 'doc-1');

    expect(engine.save).toHaveBeenCalledExactlyOnceWith({ docId: 'doc-1', protection: 'preserve' });
    expect(frame.src).toBe('blob:print-pdf');
    expect(printWindow.print).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('application/pdf');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(bytes));

    printWindow.dispatchEvent(new Event('afterprint'));
    expect(frame.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:print-pdf');
  });

  it('refuses a native-file result instead of printing an empty page', async () => {
    const engine = { save: vi.fn().mockResolvedValue({ kind: 'native-file', docId: 'doc-1', savedRevision: 7, handle: 'file' }) } as unknown as EngineAdapter;
    await expect(printCurrentPdf(engine, 'doc-1')).rejects.toThrow('requires PDF bytes');
  });

  it('submits the complete native PDF to the desktop host without confirming active save', async () => {
    const result = { kind: 'native-file', docId: 'doc-1', savedRevision: 3, handle: 'print-handle' };
    const engine = { save: vi.fn().mockResolvedValue(result), confirmSave: vi.fn() } as unknown as EngineAdapter;
    const host = { capabilities: { platform: 'windows' }, printDocument: vi.fn().mockResolvedValue(undefined) } as unknown as HostAdapter;
    await expect(printCurrentPdf(engine, 'doc-1', host, ['p1', 'p2'])).resolves.toBe('queued');
    expect(engine.save).toHaveBeenCalledExactlyOnceWith({ docId: 'doc-1', protection: 'preserve' });
    expect(host.printDocument).toHaveBeenCalledExactlyOnceWith(result, ['p1', 'p2']);
    expect(engine.confirmSave).not.toHaveBeenCalled();
  });

  it('uses a local decrypted print copy for an unlocked protected PDF on macOS', async () => {
    const result = { kind: 'native-file', docId: 'doc-1', savedRevision: 3, handle: 'decrypted-print' };
    const engine = { save: vi.fn().mockResolvedValue(result), confirmSave: vi.fn() } as unknown as EngineAdapter;
    const host = { capabilities: { platform: 'macos' }, printDocument: vi.fn().mockResolvedValue(undefined) } as unknown as HostAdapter;
    await expect(printCurrentPdf(engine, 'doc-1', host, ['p1'], true)).resolves.toBe('queued');
    expect(engine.save).toHaveBeenCalledExactlyOnceWith({ docId: 'doc-1', protection: 'remove' });
    expect(host.printDocument).toHaveBeenCalledExactlyOnceWith(result, ['p1']);
    expect(engine.confirmSave).not.toHaveBeenCalled();
  });
});
