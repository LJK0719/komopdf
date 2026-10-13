import { describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, HostAdapter } from '@pdf-editor/contracts';
import { ensureEditorFont, loadSystemFontCatalog, type EditorFont } from '../src/ui/font-resources.js';

const song: EditorFont = { id: 'system-font-song', systemId: 'system-font-song', family: 'SimSun',
  style: 'Regular', format: 'ttf', aliases: ['宋体'], faceIndex: 1, weight: 400, italic: false,
  editableEmbedding: true, registered: false };

function adapters() {
  const listSystemFonts = vi.fn(async () => [{ ...song, label: '宋体 / SimSun · Regular' }]);
  const getSystemFont = vi.fn(async () => ({ name: 'simsun.ttc', faceIndex: 1, source: { kind: 'native-file' as const, handle: 'authorized' } }));
  const registerFont = vi.fn(async () => ({ id: song.id, index: 1, faceIndex: 1, family: song.family,
    style: song.style, format: 'ttf' as const, weight: 400, italic: false, fsType: 0, editableEmbedding: true }));
  const host = { capabilities: { nativeFiles: true, systemFonts: true, platform: 'windows' }, listSystemFonts, getSystemFont } as unknown as HostAdapter;
  const engine = { registerFont } as unknown as EngineAdapter;
  return { engine, host, listSystemFonts, getSystemFont, registerFont };
}

describe('automatic system font catalog', () => {
  it('loads names once without copying or registering every installed font', async () => {
    const { engine, host, listSystemFonts, getSystemFont, registerFont } = adapters();
    await Promise.all([loadSystemFontCatalog(engine, host), loadSystemFontCatalog(engine, host)]);
    expect(listSystemFonts).toHaveBeenCalledTimes(1);
    expect(getSystemFont).not.toHaveBeenCalled();
    expect(registerFont).not.toHaveBeenCalled();
  });

  it('registers the actual collection face only on first use and shares concurrent requests', async () => {
    const { engine, host, getSystemFont, registerFont } = adapters();
    await loadSystemFontCatalog(engine, host);
    const [a, b] = await Promise.all([ensureEditorFont(engine, song), ensureEditorFont(engine, song)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ id: song.id, aliases: ['宋体'], registered: true });
    expect(registerFont).toHaveBeenCalledWith({ id: song.id, faceIndex: 1, source: { kind: 'native-file', handle: 'authorized' } });
    await ensureEditorFont(engine, song);
    expect(registerFont).toHaveBeenCalledTimes(1);
    expect(getSystemFont).toHaveBeenCalledTimes(1);
  });

  it('does not silently choose another font for an embedding-restricted face', async () => {
    const { engine, host, registerFont } = adapters();
    await loadSystemFontCatalog(engine, host);
    await expect(ensureEditorFont(engine, { ...song, editableEmbedding: false })).rejects.toThrow(/cannot be embedded/);
    expect(registerFont).not.toHaveBeenCalled();
  });

  it('does not ask browsers for local-font permission automatically', async () => {
    const { engine, host, listSystemFonts } = adapters();
    await loadSystemFontCatalog(engine, { ...host, capabilities: { nativeFiles: false, systemFonts: true, platform: 'web' } });
    expect(listSystemFonts).not.toHaveBeenCalled();
  });
});
