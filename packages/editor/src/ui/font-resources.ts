import { useEffect, useMemo, useState } from 'react';
import type { EngineAdapter, HostAdapter, RegisteredFontInfo } from '@pdf-editor/contracts';

export type EditorFont = {
  id: string;
  family: string;
  style: string;
  format: 'ttf' | 'otf';
  weight?: number;
  italic?: boolean;
  editableEmbedding?: boolean;
  url?: string;
  label?: string;
  aliases?: string[];
  postscriptName?: string;
  systemId?: string;
  faceIndex?: number;
  registered?: boolean;
  supported?: boolean;
};
const browserFaces = new Map<string, Promise<string>>();

export function loadFontPreview(font: EditorFont): Promise<string> {
  if (!font.url || typeof FontFace === 'undefined') return Promise.resolve(font.family);
  let loaded = browserFaces.get(font.id);
  if (!loaded) {
    const family = `komopdf-${font.id}`;
    const face = new FontFace(family, `url(${JSON.stringify(font.url)})`, { weight: String(font.weight ?? 400), style: font.italic ? 'italic' : 'normal' });
    loaded = face.load().then(ready => { document.fonts.add(ready); return family; });
    browserFaces.set(font.id, loaded);
  }
  return loaded;
}

const importedFonts = new WeakMap<EngineAdapter, EditorFont[]>();
const listeners = new WeakMap<EngineAdapter, Set<() => void>>();

export function addImportedFont(engine: EngineAdapter, font: RegisteredFontInfo | EditorFont): void {
  const current = importedFonts.get(engine) ?? [];
  importedFonts.set(engine, [...current.filter(item => item.id !== font.id), font]);
  listeners.get(engine)?.forEach(notify => notify());
}

const systemHosts = new WeakMap<EngineAdapter, HostAdapter>();
const systemCatalogs = new WeakMap<EngineAdapter, Promise<void>>();
const systemRegistrations = new WeakMap<EngineAdapter, Map<string, Promise<EditorFont>>>();

export function loadSystemFontCatalog(engine: EngineAdapter, host: HostAdapter): Promise<void> {
  if (!host.capabilities.nativeFiles || !host.listSystemFonts || !host.getSystemFont) return Promise.resolve();
  systemHosts.set(engine, host);
  let pending = systemCatalogs.get(engine);
  if (!pending) {
    pending = host.listSystemFonts().then(entries => {
      const current = importedFonts.get(engine) ?? [];
      const fonts: EditorFont[] = entries.filter(entry => entry.family && entry.format).map(entry => ({
        id: entry.id, systemId: entry.id, family: entry.family!, style: entry.style ?? 'Regular', format: entry.format!,
        label: entry.label, aliases: entry.aliases ?? [], postscriptName: entry.postscriptName ?? '',
        faceIndex: entry.faceIndex ?? 0, weight: entry.weight ?? 400, italic: entry.italic ?? false,
        editableEmbedding: entry.editableEmbedding ?? true, supported: entry.supported ?? true, registered: false,
      }));
      importedFonts.set(engine, [...current, ...fonts.filter(font => !current.some(item => item.id === font.id))]);
      listeners.get(engine)?.forEach(notify => notify());
    });
    systemCatalogs.set(engine, pending);
  }
  return pending;
}

export async function ensureEditorFont(engine: EngineAdapter, font: EditorFont): Promise<EditorFont> {
  if (!font.systemId || font.registered || importedFonts.get(engine)?.find(item => item.id === font.id)?.registered) return font;
  if (font.supported === false || font.editableEmbedding === false) throw new Error(`This font cannot be embedded for editing: ${font.family}`);
  const host = systemHosts.get(engine);
  if (!host?.getSystemFont || !engine.registerFont) throw new Error('System font access is unavailable.');
  const registrations = systemRegistrations.get(engine) ?? new Map<string, Promise<EditorFont>>();
  systemRegistrations.set(engine, registrations);
  let pending = registrations.get(font.id);
  if (!pending) {
    pending = host.getSystemFont(font.systemId).then(async selection => {
      const registered = await engine.registerFont!({ id: font.id, source: selection.source, faceIndex: font.faceIndex ?? selection.faceIndex ?? 0 });
      const ready = { ...font, ...registered, registered: true };
      addImportedFont(engine, ready);
      return ready;
    });
    registrations.set(font.id, pending);
  }
  return pending;
}

export async function prepareEditorFonts(engine: EngineAdapter, fonts: readonly EditorFont[], ids: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(ids)].map(async id => {
    const font = fonts.find(item => item.id === id);
    if (font) await ensureEditorFont(engine, font);
  }));
}

export type WebFontResource = {
  id: string;
  family: string;
  style: string;
  format: 'ttf' | 'otf';
  url: string;
  sha256: string;
  weight?: number;
  italic?: boolean;
  licenseUrl?: string;
  faceIndex?: number;
};

let fontResourcesPromise: Promise<WebFontResource[]> | null = null;
let fontResourceBase: string | null = null;

/** Desktop serves the same on-disk fonts used by its native engine. */
export function setFontResourceBaseUrl(base: string): void {
  fontResourceBase = base.endsWith('/') ? base : base + '/';
  fontResourcesPromise = null;
  browserFaces.clear();
}

export function loadFontResources(): Promise<WebFontResource[]> {
  fontResourcesPromise ??= fetchFontResources();
  return fontResourcesPromise;
}

export function useFontResources(engine?: EngineAdapter, host?: HostAdapter): { fonts: EditorFont[]; error: string } {
  const [fonts, setFonts] = useState<WebFontResource[]>([]);
  const [local, setLocal] = useState<EditorFont[]>(() => engine ? importedFonts.get(engine) ?? [] : []);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!engine || !host) return;
    let active = true;
    void loadSystemFontCatalog(engine, host).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : 'System font list unavailable'); });
    return () => { active = false; };
  }, [engine, host]);
  useEffect(() => {
    setLocal(engine ? importedFonts.get(engine) ?? [] : []);
    if (!engine) return;
    const subscribers = listeners.get(engine) ?? new Set<() => void>();
    listeners.set(engine, subscribers);
    const update = () => setLocal(importedFonts.get(engine) ?? []);
    subscribers.add(update);
    return () => { subscribers.delete(update); };
  }, [engine]);

  useEffect(() => {
    let active = true;
    void loadFontResources().then(
      (resources) => { if (active) setFonts(resources); },
      (caught) => { if (active) setError(caught instanceof Error ? caught.message : 'Font list unavailable'); },
    );
    return () => { active = false; };
  }, []);

  const combined = useMemo(() => [...fonts, ...local], [fonts, local]);
  return { fonts: combined, error };
}

async function fetchFontResources(): Promise<WebFontResource[]> {
  const base = fontResourceBase ?? new URL('/fonts/', globalThis.location.href).href;
  const manifestUrl = new URL('font-resources.json', base);
  const response = await fetch(manifestUrl, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Font list unavailable (HTTP ${response.status})`);
  const value: unknown = await response.json();
  if (!Array.isArray(value) || value.some((item) => !isFontResource(item))) {
    throw new Error('Font manifest has an invalid format');
  }
  const ids = new Set<string>();
  for (const item of value) {
    if (ids.has(item.id)) throw new Error('Font manifest contains duplicate IDs');
    ids.add(item.id);
  }
  return fontResourceBase ? value.map(item => ({ ...item,
    url: new URL(item.url.split('/').at(-1)!, base).href,
    ...(item.licenseUrl ? { licenseUrl: new URL(item.licenseUrl.split('/').at(-1)!, base).href } : {}),
  })) : value;
}

function isFontResource(value: unknown): value is WebFontResource {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['id', 'family', 'style', 'format', 'url', 'sha256', 'weight', 'italic', 'licenseUrl', 'faceIndex'].includes(key))
    && (item.faceIndex === undefined || (typeof item.faceIndex === 'number' && Number.isInteger(item.faceIndex) && item.faceIndex >= 0 && item.faceIndex <= 0xffff_ffff))
    && (item.weight === undefined || (typeof item.weight === 'number' && Number.isInteger(item.weight) && item.weight >= 100 && item.weight <= 900))
    && (item.italic === undefined || typeof item.italic === 'boolean')
    && (item.licenseUrl === undefined || typeof item.licenseUrl === 'string')
    && typeof item.id === 'string' && item.id.length > 0
    && typeof item.family === 'string' && item.family.length > 0
    && typeof item.style === 'string' && item.style.length > 0
    && (item.format === 'ttf' || item.format === 'otf')
    && typeof item.url === 'string' && item.url.length > 0
    && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256);
}

export {
  type FontFaceCriteria,
  type FontFaceMatchResult,
  type SelectionFontInfo,
  STANDARD_WEIGHT_OPTIONS,
  getFontWeight,
  getFontItalic,
  isFontEmbeddable,
  getAvailableFontFamilies,
  getAvailableWeightsForFamily,
  familySupportsItalic,
  resolveExactFontFace,
  findSelectionFontInfo,
} from './font-face-matcher.js';
