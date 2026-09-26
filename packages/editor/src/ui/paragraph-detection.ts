import type { EditableObject, PageModel, Rect, TextStyle } from '@pdf-editor/contracts';

export type ParagraphCandidate = { objects: EditableObject[]; text: string; bounds: Rect; style: TextStyle; lineHeight: number };
const textOf = (object: EditableObject) => object.textBlock!.runs.map(run => run.text).join('');
const styleOf = (object: EditableObject) => object.textBlock!.runs[0]!.style;
const close = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

function eligible(object: EditableObject): boolean {
  const block = object.textBlock;
  const [a, b, c, d] = object.transform;
  return Boolean(block && !block.isParagraph && !block.isOcr && block.editability !== 'geometry-only' &&
    !object.locator.containerPath.length && block.runs.length === 1 && textOf(object).trim() &&
    !/[\r\n]|\p{Script=Arabic}|\p{Script=Hebrew}/u.test(textOf(object)) && Math.abs(b) < 0.01 && Math.abs(c) < 0.01 &&
    close(a, 1, 0.02) && close(Math.abs(d), 1, 0.02));
}

function sameStyle(a: EditableObject, b: EditableObject): boolean {
  const x = styleOf(a), y = styleOf(b);
  return x.fontId === y.fontId && close(x.fontSize ?? 12, y.fontSize ?? 12, 0.1) &&
    close(x.characterSpacing ?? 0, y.characterSpacing ?? 0, 0.15) &&
    x.weight === y.weight && x.italic === y.italic && Boolean(x.underline) === Boolean(y.underline) &&
    JSON.stringify(x.color ?? [0, 0, 0]) === JSON.stringify(y.color ?? [0, 0, 0]);
}

// Deliberately local: adjacent content, one column, matching type, no table rules.
// Detection never edits the PDF. Conversion happens only on the user's command.
export function detectParagraph(page: PageModel, seedId: string, single = false): ParagraphCandidate | null {
  const seed = page.objects.find(object => object.id === seedId);
  if (!seed || !eligible(seed)) return null;
  const ordered = page.objects.filter(object => !object.locator.containerPath.length)
    .sort((a, b) => a.locator.objectIndex - b.locator.objectIndex);
  const start = ordered.indexOf(seed);
  let first = start, last = start;
  const size = styleOf(seed).fontSize ?? 12;
  const linked = (a: EditableObject, b: EditableObject) => {
    if (!eligible(a) || !eligible(b) || !sameStyle(seed, a) || !sameStyle(seed, b) ||
      b.locator.objectIndex !== a.locator.objectIndex + 1) return false;
    const dx = b.bounds.x - a.bounds.x - a.bounds.width;
    const dy = b.bounds.y - a.bounds.y;
    const sameLine = Math.abs(dy) < size * 0.3 && dx >= -size * 0.15 && dx <= size * 0.8;
    const nextLine = dy >= size * 0.75 && dy <= size * 1.9 &&
      Math.abs(b.bounds.x - a.bounds.x) <= size * 1.5;
    if (!sameLine && !nextLine) return false;
    const corridor = sameLine
      ? { x: a.bounds.x + a.bounds.width, y: Math.min(a.bounds.y, b.bounds.y), width: Math.max(0, dx), height: size }
      : { x: Math.max(a.bounds.x, b.bounds.x), y: a.bounds.y + a.bounds.height,
          width: Math.min(a.bounds.width, b.bounds.width), height: Math.max(0, b.bounds.y - a.bounds.y - a.bounds.height) };
    return !page.objects.some(object => object.type === 'path' && object.bounds.width + object.bounds.height > size &&
      object.bounds.x < corridor.x + corridor.width && object.bounds.x + object.bounds.width > corridor.x &&
      object.bounds.y <= corridor.y + corridor.height && object.bounds.y + object.bounds.height >= corridor.y &&
      (sameLine ? object.bounds.width < size * 0.4 : object.bounds.height < size * 0.4));
  };
  if (!single) {
    while (first > 0 && linked(ordered[first - 1]!, ordered[first]!)) first--;
    while (last + 1 < ordered.length && linked(ordered[last]!, ordered[last + 1]!)) last++;
  }
  const objects = ordered.slice(first, last + 1);
  if (!single && objects.length < 2) return null;
  const lines: { y: number; text: string; right: number }[] = [];
  for (const object of objects) {
    const previous = lines.at(-1);
    const value = textOf(object);
    if (previous && Math.abs(previous.y - object.bounds.y) < size * 0.3) {
      const gap = object.bounds.x - previous.right;
      previous.text += gap > size * 0.2 && !/\s$/u.test(previous.text) && !/^\s/u.test(value) &&
        !/\p{Script=Han}$/u.test(previous.text) && !/^\p{Script=Han}/u.test(value) ? ' ' + value : value;
      previous.right = object.bounds.x + object.bounds.width;
    } else lines.push({ y: object.bounds.y, text: value, right: object.bounds.x + object.bounds.width });
  }
  const steps = lines.slice(1).map((line, i) => (line.y - lines[i]!.y) / size).sort((a, b) => a - b);
  const lineHeight = Math.round((steps[Math.floor(steps.length / 2)] ?? 1) * 100) / 100;
  const x = Math.min(...objects.map(object => object.bounds.x));
  const y = Math.min(...objects.map(object => object.bounds.y));
  const right = Math.max(...objects.map(object => object.bounds.x + object.bounds.width));
  const bottom = Math.max(...objects.map(object => object.bounds.y + object.bounds.height));
  const next = page.objects.filter(object => !objects.includes(object) && object.bounds.y >= bottom &&
    object.bounds.x < right && object.bounds.x + object.bounds.width > x).map(object => object.bounds.y);
  const available = Math.min(page.heightPt, ...next) - y;
  // Leave modest line-height room, but never extend through the next content.
  const height = Math.min(available, Math.max(bottom - y + size * 1.5, lines.length * size * lineHeight + size));
  return { objects, text: lines.map(line => line.text).join('\n'),
    bounds: { x, y, width: Math.min(page.widthPt - x, right - x + size * 0.8), height },
    style: styleOf(seed), lineHeight };
}
