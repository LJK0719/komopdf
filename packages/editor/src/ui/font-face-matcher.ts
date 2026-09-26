import type { EditorFont } from './font-resources.js';
import type { TextBlock, TextRange, StyledTextRun } from '@pdf-editor/contracts';

export type FontFaceCriteria = {
  family: string;
  weight: number;
  italic: boolean;
};

export type FontFaceMatchResult =
  | { success: true; font: EditorFont }
  | { success: false; reason: string };

export type SelectionFontInfo = {
  family: string;
  weight: number;
  italic: boolean;
  fontId?: string;
};

export const STANDARD_WEIGHT_OPTIONS = [
  { value: 100, label: 'Thin (100)' },
  { value: 200, label: 'Extra Light (200)' },
  { value: 300, label: 'Light (300)' },
  { value: 400, label: 'Regular (400)' },
  { value: 500, label: 'Medium (500)' },
  { value: 600, label: 'Semi Bold (600)' },
  { value: 700, label: 'Bold (700)' },
  { value: 800, label: 'Extra Bold (800)' },
  { value: 900, label: 'Black (900)' },
] as const;

/**
 * Extracts normalized numeric weight (100–900) from an EditorFont.
 * Falls back to style name keywords if numeric weight is omitted.
 */
export function getFontWeight(font: EditorFont): number {
  if (typeof font.weight === 'number' && Number.isInteger(font.weight) && font.weight >= 100 && font.weight <= 900) {
    return font.weight;
  }
  const s = (font.style || '').toLowerCase();
  if (s.includes('black') || s.includes('heavy')) return 900;
  if (s.includes('extra bold') || s.includes('extrabold')) return 800;
  if (s.includes('semi bold') || s.includes('semibold') || s.includes('demi bold') || s.includes('demibold')) return 600;
  if (s.includes('bold')) return 700;
  if (s.includes('medium')) return 500;
  if (s.includes('thin')) return 100;
  if (s.includes('extra light') || s.includes('extralight')) return 200;
  if (s.includes('light')) return 300;
  return 400;
}

/**
 * Extracts posture (italic boolean) from an EditorFont.
 * Falls back to style name keywords if boolean is omitted.
 */
export function getFontItalic(font: EditorFont): boolean {
  if (typeof font.italic === 'boolean') {
    return font.italic;
  }
  const s = (font.style || '').toLowerCase();
  return s.includes('italic') || s.includes('oblique');
}

/**
 * Checks whether an EditorFont is permitted for editable embedding in PDF.
 */
export function isFontEmbeddable(font: EditorFont): boolean {
  return font.editableEmbedding !== false;
}

/**
 * Returns distinct font families available in the provided font list.
 */
export function getAvailableFontFamilies(fonts: readonly EditorFont[]): string[] {
  const families: string[] = [];
  for (const f of fonts) {
    if (!families.includes(f.family)) {
      families.push(f.family);
    }
  }
  return families;
}

/**
 * Returns sorted unique weights available for a specific family and optional posture.
 */
export function getAvailableWeightsForFamily(
  fonts: readonly EditorFont[],
  family: string,
  italic?: boolean,
): number[] {
  const norm = family.trim().toLowerCase();
  const weights: number[] = [];
  for (const f of fonts) {
    if (f.family.trim().toLowerCase() !== norm) continue;
    if (italic !== undefined && getFontItalic(f) !== italic) continue;
    const w = getFontWeight(f);
    if (!weights.includes(w)) weights.push(w);
  }
  return weights.sort((a, b) => a - b);
}

/**
 * Checks if a font family has at least one italic face registered.
 */
export function familySupportsItalic(
  fonts: readonly EditorFont[],
  family: string,
  weight?: number,
): boolean {
  const norm = family.trim().toLowerCase();
  return fonts.some(f => {
    if (f.family.trim().toLowerCase() !== norm) return false;
    if (weight !== undefined && getFontWeight(f) !== weight) return false;
    return getFontItalic(f);
  });
}

/**
 * Resolves an exact registered font face matching the target family, weight, and posture.
 *
 * Rejects with a clear reason if:
 * 1. Family is not registered in document font resources.
 * 2. No exact face exists for the target weight + italic combination.
 * Automatic substitution is handled by resolveFormattingFont; font flags are metadata only.
 */
export function resolveExactFontFace(
  fonts: readonly EditorFont[],
  criteria: FontFaceCriteria,
): FontFaceMatchResult {
  const normFamily = criteria.family.trim().toLowerCase();
  const familyFonts = fonts.filter(f => f.family.trim().toLowerCase() === normFamily);

  if (familyFonts.length === 0) {
    return {
      success: false,
      reason: `Font family "${criteria.family}" is not registered in the document font resources.`,
    };
  }

  const matches = familyFonts.filter(f => getFontWeight(f) === criteria.weight && getFontItalic(f) === criteria.italic);
  const match = matches[0];

  if (!match) {
    const postureLabel = criteria.italic ? 'italic' : 'normal';
    return {
      success: false,
      reason: `No exact weight ${criteria.weight} ${postureLabel} face registered for "${criteria.family}".`,
    };
  }

  return { success: true, font: match };
}

/**
 * Inspects the text block's styled runs across the given selection range to detect
 * the active registered font family, weight, and posture.
 * Returns null if the selection spans unregistered fonts or mixed font families.
 */
export function findSelectionFontInfo(
  block: TextBlock,
  range: TextRange,
  fonts: readonly EditorFont[],
): SelectionFontInfo | null {
  const [start, end] = range;
  let currentOffset = 0;
  const overlappingRuns: StyledTextRun[] = [];

  for (const run of block.runs) {
    const runStart = currentOffset;
    const runEnd = currentOffset + run.text.length;
    currentOffset = runEnd;

    const overlaps = start === end
      ? (start >= runStart && start <= runEnd)
      : (Math.max(start, runStart) < Math.min(end, runEnd));

    if (overlaps && run.text.length > 0) {
      overlappingRuns.push(run);
    }
  }

  if (overlappingRuns.length === 0) return null;

  const detectedFamilies: string[] = [];
  const detectedWeights: number[] = [];
  const detectedItalics: boolean[] = [];
  let detectedFontId: string | undefined = undefined;

  for (const run of overlappingRuns) {
    let font: EditorFont | undefined = undefined;
    if (run.style.fontId) {
      font = fonts.find(f => f.id === run.style.fontId);
    }
    if (!font && run.style.fontId?.startsWith('pdf:')) {
      const name = run.style.fontId.slice(4).replace(/^[A-Z]{6}\+/, '');
      const parsed = sourceFontFamily(name);
      const family = fonts.find(item => normalizeFamily(item.family) === normalizeFamily(parsed))?.family ?? parsed;
      font = { id: run.style.fontId, family, style: name, format: 'ttf',
        weight: run.style.weight ?? getFontWeight({ id: name, family, style: name, format: 'ttf' }),
        italic: run.style.italic ?? /italic|oblique/i.test(name) };
    }
    if (!font) return null;
    if (!detectedFamilies.includes(font.family)) {
      detectedFamilies.push(font.family);
    }
    detectedWeights.push(getFontWeight(font));
    detectedItalics.push(getFontItalic(font));
    detectedFontId = font.id;
  }

  if (detectedFamilies.length !== 1 || new Set(detectedWeights).size !== 1 || new Set(detectedItalics).size !== 1) return null;

  return {
    family: detectedFamilies[0]!,
    weight: detectedWeights[0] ?? 400,
    italic: detectedItalics[0] ?? false,
    ...(detectedFontId ? { fontId: detectedFontId } : {}),
  };
}

const normalizeFamily = (name: string) => name.replace(/\s*\(technical preview\)$/i, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function sourceFontFamily(name: string): string {
  const clean = name.replace(/^[A-Z]{6}\+/, '').replace(/(?:PS)?MT$/i, '')
    .replace(/[-,](?:bolditalic|boldoblique|bold|italic|oblique|regular|roman|light|medium|semibold).*$/i, '');
  const known: Record<string, string> = {
    arial: 'Arial', timesnewroman: 'Times New Roman', timesnewromanps: 'Times New Roman',
    couriernew: 'Courier New', couriernewps: 'Courier New', helvetica: 'Helvetica', times: 'Times',
    microsoftyahei: 'Microsoft YaHei', microsoftyaheiui: 'Microsoft YaHei', simsun: 'SimSun',
    simhei: 'SimHei', kaiti: 'KaiTi', fangsong: 'FangSong', pingfangsc: 'PingFang SC',
  };
  return known[normalizeFamily(clean)] ?? clean;
}

/** Resolve the user's style intent, with script-safe family substitution when needed. */
export function resolveFormattingFont(fonts: readonly EditorFont[], criteria: FontFaceCriteria & { text: string }): EditorFont {
  if (!fonts.length) throw new Error('Font library is still loading.');
  const source = normalizeFamily(criteria.family);
  const cjk = /\p{Script=Han}/u.test(criteria.text);
  const serif = /serif|times|cambria|caladea|simsun|song|宋|仿|fang|kai|楷|wenkai/i.test(criteria.family) && !/sans/i.test(criteria.family);
  const mono = /mono|courier|consolas|cousine|code/i.test(criteria.family);
  const preferred = [criteria.family];
  if (/arial|helvetica/i.test(criteria.family)) preferred.push('Arimo', 'Liberation Sans');
  if (/times/i.test(criteria.family)) preferred.push('Liberation Serif', 'Noto Serif');
  if (/calibri/i.test(criteria.family)) preferred.push('Carlito');
  if (/cambria/i.test(criteria.family)) preferred.push('Caladea');
  if (/fangsong|仿宋/i.test(criteria.family)) preferred.push('Zhuque Fangsong');
  if (/kaiti|楷/i.test(criteria.family)) preferred.push('LXGW WenKai');
  if (cjk) preferred.push(serif ? 'Noto Serif CJK SC' : 'Noto Sans CJK SC');
  else preferred.push(mono ? 'Liberation Mono' : serif ? 'Liberation Serif' : 'Liberation Sans');
  const familyRank = (font: EditorFont) => {
    const normalized = normalizeFamily(font.family);
    const index = preferred.findIndex(name => normalizeFamily(name) === normalized);
    return index >= 0 ? index : preferred.length + 1;
  };
  // Do not route Chinese text to a Latin-only alias such as Arimo.
  const candidates = fonts.filter(font => !cjk || normalizeFamily(font.family) === source || /cjk|wenkai|zhuque|zcool|mashan|longcang|zhimang/i.test(font.family));
  const pool = candidates.length ? candidates : [...fonts];
  const matchingStyle = pool.filter(font => getFontItalic(font) === criteria.italic && (getFontWeight(font) >= 600) === (criteria.weight >= 600));
  const choices = matchingStyle.length ? matchingStyle : pool.filter(font => getFontItalic(font) === criteria.italic);
  return [...(choices.length ? choices : pool)].sort((a, b) =>
    familyRank(a) - familyRank(b) || Math.abs(getFontWeight(a) - criteria.weight) - Math.abs(getFontWeight(b) - criteria.weight))[0]!;
}
