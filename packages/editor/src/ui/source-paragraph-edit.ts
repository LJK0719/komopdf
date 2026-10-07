import type { EditCommand, PageModel, StyledTextRun, TextStyle } from '@pdf-editor/contracts';
import { findSelectionFontInfo, getFontItalic, getFontWeight, resolveFormattingFont } from './font-face-matcher.js';
import type { EditorFont } from './font-resources.js';
import { detectParagraph, type ParagraphCandidate } from './paragraph-detection.js';
import { sourceTextOffset } from './source-text.js';

export function resolveParagraphRunFont(run: StyledTextRun, fonts: readonly EditorFont[]): string {
  const loaded = fonts.find(font => font.id === run.style.fontId);
  const block = { runs: [run] } as Parameters<typeof findSelectionFontInfo>[0];
  const info = findSelectionFontInfo(block, [0, run.text.length], fonts);
  const weight = run.style.weight ?? info?.weight ?? 400;
  const italic = run.style.italic ?? info?.italic ?? false;
  const match = resolveFormattingFont(fonts, { family: info?.family ?? (/\p{Script=Han}/u.test(run.text) ? 'Noto Sans CJK SC' : 'Liberation Sans'),
    weight, italic, text: run.text });
  if (loaded && loaded.family === match.family && getFontWeight(loaded) === weight && getFontItalic(loaded) === italic) return loaded.id;
  return match.id;
}

export function applyParagraphFormats(runs: StyledTextRun[], formats: { range: [number, number]; style: TextStyle }[]): StyledTextRun[] {
  const result: StyledTextRun[] = [];
  let start = 0;
  for (const run of runs) {
    const end = start + run.text.length;
    const cuts = [...new Set([start, end, ...formats.flatMap(format => format.range).filter(offset => offset > start && offset < end)])].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const from = cuts[i]!, to = cuts[i + 1]!;
      const style = { ...run.style };
      for (const format of formats) if (format.range[0] <= from && format.range[1] >= to) Object.assign(style, format.style);
      result.push({ ...run, text: run.text.slice(from - start, to - start), style });
    }
    start = end;
  }
  return result;
}

export function paragraphProperties(style: TextStyle): TextStyle {
  const { lineHeight, alignment, firstLineIndent, lineSpacing, spaceBefore, spaceAfter } = style;
  return Object.fromEntries(Object.entries({ lineHeight, alignment, firstLineIndent, lineSpacing, spaceBefore, spaceAfter }).filter(([, value]) => value !== undefined));
}

export function canFormatSourceParagraph(page: PageModel, paragraph: ParagraphCandidate, style: TextStyle): boolean {
  if (style.alignment === 'justify' || style.spaceBefore !== undefined || style.spaceAfter !== undefined) return false;
  const commands = sourceParagraphLayout(page, paragraph, style);
  if (!commands.length) return true;
  const translations = new Map<string, { x: number; y: number }>();
  for (const command of commands) if (command.type === 'objects.transform')
    for (const id of command.objectIds) translations.set(id, { x: command.matrix[4], y: command.matrix[5] });
  const frame = paragraph.bounds, content = paragraph.contentBounds;
  for (const line of paragraph.lines) {
    const move = translations.get(line.objects[0]!.id) ?? { x: 0, y: 0 };
    const x = line.bounds.x + move.x, y = line.bounds.y + move.y;
    if (x < Math.max(0, content.x) - 0.001 || x + line.bounds.width > Math.min(page.widthPt, content.x + content.width) + 0.001 ||
        y < Math.max(0, frame.y) - 0.001 || y + line.bounds.height > Math.min(page.heightPt, frame.y + frame.height) + 0.001) return false;
  }
  // Reuse the actual detector instead of widening its paragraph/column guards.
  // Layout that loses this exact source group needs a durable native paragraph.
  const projected: PageModel = { ...page, objects: page.objects.map(object => {
    const move = translations.get(object.id);
    if (!move) return object;
    const shift = (bounds: typeof object.bounds) => ({ ...bounds, x: bounds.x + move.x, y: bounds.y + move.y });
    return { ...object, bounds: shift(object.bounds), ...(object.textBlock ? { textBlock: { ...object.textBlock,
      bounds: shift(object.textBlock.bounds), ...(object.textBlock.characters ? { characters: object.textBlock.characters.map(character => ({ ...character, bounds: shift(character.bounds) })) } : {}) } } : {}) };
  }) };
  const detected = detectParagraph(projected, paragraph.objects[0]!.id, paragraph.objects.length === 1);
  return Boolean(detected && detected.objects.length === paragraph.objects.length &&
    detected.objects.every(object => paragraph.sourceRanges[object.id] !== undefined));
}

// Paragraph-only layout changes translate existing lines. No glyph text, font,
// TJ/Tw spacing or mixed run is regenerated just to center/right-align a PDF.
export function sourceParagraphLayout(page: PageModel, paragraph: ParagraphCandidate, style: TextStyle): EditCommand[] {
  const commands: EditCommand[] = [];
  const alignment = style.alignment ?? paragraph.style.alignment ?? 'left';
  const indent = style.firstLineIndent ?? paragraph.firstLineIndent;
  const repositionX = style.alignment !== undefined || style.firstLineIndent !== undefined;
  const repositionY = style.lineHeight !== undefined || style.lineSpacing !== undefined;
  const first = paragraph.lines[0]!;
  let baseline = first.baseline;
  for (const [index, line] of paragraph.lines.entries()) {
    if (index) {
      const size = Math.max(line.size, paragraph.lines[index - 1]!.size);
      baseline += style.lineSpacing || size * (style.lineHeight ?? paragraph.lineHeight);
    }
    const inset = index === 0 ? Math.max(0, indent) : Math.max(0, -indent);
    const box = paragraph.contentBounds;
    const x = box.x + inset + (alignment === 'center' ? (box.width - inset - line.bounds.width) / 2
      : alignment === 'right' ? box.width - inset - line.bounds.width : 0);
    const dx = repositionX ? x - line.bounds.x : 0;
    const dy = repositionY ? baseline - line.baseline : 0;
    if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001)
      commands.push({ type: 'objects.transform', pageId: page.id, objectIds: line.objects.map(object => object.id), matrix: [1, 0, 0, 1, dx, dy] });
  }
  return commands;
}

export function sourceParagraphStyles(page: PageModel, paragraph: ParagraphCandidate, runs: StyledTextRun[], fonts: readonly EditorFont[]): EditCommand[] {
  const commands: EditCommand[] = [];
  const spans: { start: number; end: number; run: StyledTextRun }[] = [];
  let offset = 0;
  for (const run of runs) { spans.push({ start: offset, end: offset + run.text.length, run }); offset += run.text.length; }
  for (const object of paragraph.objects) {
    const source = page.objects.find(item => item.id === object.id)!.textBlock!;
    const original = object.textBlock!.runs[0]!;
    const info = findSelectionFontInfo(object.textBlock!, [0, original.text.length], fonts);
    const [start, end] = paragraph.sourceRanges[object.id]!;
    // Descending ranges keep the original ID on the remaining prefix when the
    // native core splits a source object into independently styled pieces.
    for (const span of spans.toReversed()) {
      const from = Math.max(start, span.start), to = Math.min(end, span.end);
      if (from >= to) continue;
      const range: [number, number] = [sourceTextOffset(source, from - start), sourceTextOffset(source, to - start)];
      if (range[0] === range[1]) continue;
      const desired = span.run.style, before = original.style, style: TextStyle = {};
      const weight = desired.weight ?? info?.weight ?? 400, italic = desired.italic ?? info?.italic ?? false;
      if (desired.fontId !== before.fontId || weight !== (before.weight ?? info?.weight ?? 400) || italic !== (before.italic ?? info?.italic ?? false))
        style.fontId = resolveParagraphRunFont({ ...span.run, text: span.run.text.slice(from - span.start, to - span.start) }, fonts);
      const scale = Math.abs(object.transform[3]);
      if (desired.fontSize !== undefined && desired.fontSize !== before.fontSize) style.fontSize = desired.fontSize / scale;
      if ((desired.characterSpacing ?? 0) !== (before.characterSpacing ?? 0)) style.characterSpacing = (desired.characterSpacing ?? 0) / scale;
      if (Boolean(desired.underline) !== Boolean(before.underline)) style.underline = Boolean(desired.underline);
      if (JSON.stringify(desired.color ?? [0, 0, 0]) !== JSON.stringify(before.color ?? [0, 0, 0])) style.color = desired.color ?? [0, 0, 0];
      if (Object.keys(style).length) commands.push({ type: 'text.style', pageId: page.id, blockIds: [source.id], range, style });
    }
  }
  return commands;
}
