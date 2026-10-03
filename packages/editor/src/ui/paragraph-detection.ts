import type { EditableObject, PageModel, Rect, StyledTextRun, TextStyle } from '@pdf-editor/contracts';
import { unionBounds } from './text-geometry.js';

export type ParagraphCandidate = {
  objects: EditableObject[]; text: string; runs: StyledTextRun[]; bounds: Rect; style: TextStyle;
  lineHeight: number; firstLineIndent: number; confidence: 'high' | 'low'; sourceRanges: Record<string, [number, number]>;
};
type Line = { objects: EditableObject[]; bounds: Rect; size: number; baseline: number };
const cache = new WeakMap<PageModel, Map<string, ParagraphCandidate>>();
const geometry = new WeakMap<EditableObject, EditableObject>();
function withTextGeometry(object: EditableObject): EditableObject {
  const cached = geometry.get(object);
  if (cached) return cached;
  const characters = object.textBlock?.characters;
  const result = characters?.length ? { ...object, bounds: unionBounds(characters.map(character => character.bounds)) } : object;
  geometry.set(object, result);
  return result;
}
const textOf = (object: EditableObject) => object.textBlock!.runs.map(run => run.text).join('');
const styleOf = (object: EditableObject) => object.textBlock!.runs[0]!.style;
const sizeOf = (object: EditableObject) => styleOf(object).fontSize ?? object.bounds.height;
const right = (bounds: Rect) => bounds.x + bounds.width;
const bottom = (bounds: Rect) => bounds.y + bounds.height;
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const listStart = /^\s*(?:[•●▪◦‣–—]|\(?\d{1,3}[.)、]|[a-zA-Z][.)])\s*/u;

function eligible(object: EditableObject): boolean {
  const block = object.textBlock, [a, b, c, d] = object.transform;
  return Boolean(block && !block.isParagraph && !block.isOcr && block.editability !== 'geometry-only' &&
    !object.locator.containerPath.length && block.runs.length && textOf(object).length &&
    (textOf(object).trim() || block.characters?.some(character => character.bounds.width > 0)) &&
    !/[\r\n]|\p{Script=Arabic}|\p{Script=Hebrew}/u.test(textOf(object)) &&
    Math.abs(b) <= Math.abs(a) * 0.02 && Math.abs(c) <= Math.abs(d) * 0.02 && a > 0 && Math.abs(d) > 0);
}

function separated(page: PageModel, a: Rect, b: Rect, horizontal: boolean, size: number): boolean {
  const corridor = horizontal
    ? { x: right(a), y: Math.max(a.y, b.y), width: Math.max(0, b.x - right(a)), height: Math.min(a.height, b.height) }
    : { x: Math.max(a.x, b.x), y: bottom(a), width: Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)), height: Math.max(0, b.y - bottom(a)) };
  return page.objects.some(object => object.type === 'path' && object.bounds.width + object.bounds.height > size &&
    object.bounds.x <= right(corridor) && right(object.bounds) >= corridor.x &&
    object.bounds.y <= bottom(corridor) && bottom(object.bounds) >= corridor.y &&
    (horizontal ? object.bounds.width < size * 0.4 : object.bounds.height < size * 0.4));
}

function buildLines(page: PageModel): Line[] {
  const rows: Line[] = [];
  const objects = page.objects.filter(eligible).map(withTextGeometry).toSorted((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  for (const object of objects) {
    const size = sizeOf(object), baseline = bottom(object.bounds);
    let row: Line | undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      const candidate = rows[i]!;
      if (object.bounds.y - candidate.bounds.y > Math.max(candidate.size, size) * 1.5) break;
      if (Math.abs(candidate.baseline - baseline) <= Math.max(size, candidate.size) * 0.32 &&
          Math.max(size, candidate.size) / Math.min(size, candidate.size) < 1.6) { row = candidate; break; }
    }
    if (row) {
      row.objects.push(object); row.bounds = unionBounds([row.bounds, object.bounds]);
      row.size = median(row.objects.map(sizeOf)); row.baseline = median(row.objects.map(item => bottom(item.bounds)));
    } else rows.push({ objects: [object], bounds: object.bounds, size, baseline });
  }
  const lines: Line[] = [];
  for (const row of rows) {
    let current: EditableObject[] = [];
    const finish = () => {
      if (current.length) lines.push({ objects: current, bounds: unionBounds(current.map(item => item.bounds)),
        size: median(current.map(sizeOf)), baseline: median(current.map(item => bottom(item.bounds))) });
      current = [];
    };
    for (const object of row.objects.toSorted((a, b) => a.bounds.x - b.bounds.x)) {
      const previous = current.at(-1);
      if (previous && (object.bounds.x - right(previous.bounds) > row.size * 1.8 ||
          separated(page, previous.bounds, object.bounds, true, row.size))) finish();
      current.push(object);
    }
    finish();
  }
  return lines.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}

function appendRun(runs: StyledTextRun[], run: StyledTextRun): void {
  const previous = runs.at(-1);
  if (previous && JSON.stringify(previous.style) === JSON.stringify(run.style)) {
    previous.text += run.text;
    previous.sourceObjectIds = [...new Set([...previous.sourceObjectIds, ...run.sourceObjectIds])];
  } else runs.push({ text: run.text, style: { ...run.style }, sourceObjectIds: [...run.sourceObjectIds] });
}

function separator(before: string, after: string): string {
  if (!before || !after || /\s$/u.test(before) || /^\s/u.test(after)) return '';
  if (cjk.test(before.slice(-1)) || cjk.test(after[0]!) || /^[,.;:!?，。；：！？、）】》]/u.test(after)) return '';
  return ' ';
}

function candidateFor(page: PageModel, lines: Line[]): ParagraphCandidate {
  const objects = lines.flatMap(line => line.objects), runs: StyledTextRun[] = [];
  let precedingLine = '', length = 0;
  const sourceRanges: Record<string, [number, number]> = {};
  for (const line of lines) {
    let lineText = '', previous: EditableObject | undefined;
    for (const object of line.objects) {
      const value = textOf(object);
      const gap = previous ? object.bounds.x - right(previous.bounds) : 0;
      const glue = previous ? (gap > line.size * 0.16 ? separator(lineText, value) : '') : separator(precedingLine, value);
      if (glue && runs.length) runs.at(-1)!.text += glue;
      length += glue.length;
      sourceRanges[object.id] = [length, length + value.length];
      length += value.length;
      for (const run of object.textBlock!.runs) appendRun(runs, run);
      lineText += glue + value; previous = object;
    }
    precedingLine = lineText;
  }
  const bounds = unionBounds(objects.map(object => object.bounds));
  const size = median(lines.map(line => line.size));
  const lineHeight = lines.length > 1 ? median(lines.slice(1).map((line, i) => (line.baseline - lines[i]!.baseline) / size)) : 1.2;
  const bodyLeft = lines.length > 1 ? median(lines.slice(1).map(line => line.bounds.x)) : bounds.x;
  const firstLineIndent = lines[0]!.bounds.x - bodyLeft;
  const selected = new Set(objects.map(object => object.id));
  const availableBottom = Math.min(page.heightPt, ...page.objects.filter(object => !selected.has(object.id) &&
    object.bounds.y >= bottom(bounds) && object.bounds.x < right(bounds) && right(object.bounds) > bounds.x).map(object => object.bounds.y));
  const style = { ...styleOf(objects[0]!) };
  return { objects, runs, text: runs.map(run => run.text).join(''), style, sourceRanges,
    bounds: { x: Math.min(bounds.x, bodyLeft), y: bounds.y,
      width: Math.min(page.widthPt - bounds.x, bounds.width + size * 0.25),
      height: Math.min(availableBottom - bounds.y, Math.max(bounds.height + size, lines.length * size * lineHeight)) },
    lineHeight: Math.round(lineHeight * 1000) / 1000, firstLineIndent,
    confidence: lines.length > 1 || objects.length > 1 ? 'high' : 'low' };
}

// Spatial reading order is independent of PDF drawing order. Detection never
// mutates source objects; materialization is part of the first edit transaction.
export function detectParagraphs(page: PageModel): ParagraphCandidate[] {
  const existing = cache.get(page);
  if (existing) return [...new Set(existing.values())];
  const lines = buildLines(page), used = new Set<Line>(), groups: ParagraphCandidate[] = [];
  for (const first of lines) {
    if (used.has(first)) continue;
    const group = [first]; used.add(first);
    let previous = first, expectedStep = 0;
    for (;;) {
      let best: Line | undefined, bestScore = Infinity;
      for (const next of lines) {
        if (used.has(next)) continue;
        const step = next.baseline - previous.baseline, size = Math.max(previous.size, next.size);
        if (step < size * 0.7 || step > size * 1.95 ||
            Math.abs(previous.size - next.size) > size * 0.13 ||
            (expectedStep > 0 && step > expectedStep * 1.25)) continue;
        const indent = next.bounds.x - previous.bounds.x;
        if (Math.abs(indent) > size * (group.length === 1 ? 3 : 0.7) ||
            Math.min(right(previous.bounds), right(next.bounds)) - Math.max(previous.bounds.x, next.bounds.x) < size ||
            separated(page, previous.bounds, next.bounds, false, size)) continue;
        const value = next.objects.map(textOf).join('');
        if (listStart.test(value) || (group.length > 1 && indent > size * 0.7)) continue;
        const typicalWidth = Math.max(...group.map(line => line.bounds.width), next.bounds.width);
        const previousText = previous.objects.map(textOf).join('');
        const heading = previous.objects.every(object => object.textBlock!.runs.every(run => (run.style.weight ?? 400) >= 600));
        const body = next.objects.some(object => object.textBlock!.runs.some(run => (run.style.weight ?? 400) < 600));
        if ((heading && body && previous.bounds.width < next.bounds.width * 0.8) ||
            (indent > size * 0.7 && !listStart.test(previousText))) continue;
        if (previous.bounds.width < typicalWidth * 0.72 && /[.!?。！？：:]\s*$/u.test(previousText)) continue;
        const score = step + Math.abs(indent) * 0.25;
        if (score < bestScore) { best = next; bestScore = score; }
      }
      if (!best) break;
      expectedStep = expectedStep || best.baseline - previous.baseline;
      group.push(best); used.add(best); previous = best;
    }
    groups.push(candidateFor(page, group));
  }
  const index = new Map<string, ParagraphCandidate>();
  for (const group of groups) for (const object of group.objects) index.set(object.id, group);
  cache.set(page, index);
  return groups;
}

export function detectParagraph(page: PageModel, seedId: string, single = false): ParagraphCandidate | null {
  detectParagraphs(page);
  const candidate = cache.get(page)!.get(seedId);
  if (!candidate || (!single && candidate.objects.length < 2)) return null;
  if (!single) return candidate;
  const object = withTextGeometry(page.objects.find(item => item.id === seedId)!);
  return candidateFor(page, [{ objects: [object], bounds: object.bounds, size: sizeOf(object), baseline: bottom(object.bounds) }]);
}
