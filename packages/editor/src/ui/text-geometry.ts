import { graphemeBoundaries, type Rect, type TextBlock, type TextCharacter, type TextRange } from '@pdf-editor/contracts';

export type TextCluster = TextCharacter & { text: string };
export type TextHit = { offset: number; bounds: Rect; angle: number };
const cache = new WeakMap<TextBlock, TextCluster[]>();

export function textClusters(block: TextBlock): TextCluster[] {
  const cached = cache.get(block);
  if (cached) return cached;
  const text = block.runs.map(run => run.text).join('');
  const boundaries = [...graphemeBoundaries(text)].sort((a, b) => a - b);
  const characters = block.characters ?? [];
  const clusters: TextCluster[] = [];
  let cursor = 0;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const start = boundaries[i]!, end = boundaries[i + 1]!;
    while (cursor < characters.length && characters[cursor]!.range[1] <= start) cursor++;
    const parts: TextCharacter[] = [];
    for (let j = cursor; j < characters.length && characters[j]!.range[0] < end; j++) parts.push(characters[j]!);
    if (!parts.length) continue;
    const bounds = unionBounds(parts.map(part => part.bounds)), previous = clusters.at(-1);
    if (previous && previous.range[1] === start && !/\s/u.test(previous.text + text.slice(start, end)) &&
        Math.abs(previous.angle - parts[0]!.angle) < 0.001 &&
        (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(previous.bounds[key] - bounds[key]) < 0.01)) {
      previous.range[1] = end; previous.text += text.slice(start, end);
    } else clusters.push({ range: [start, end], text: text.slice(start, end), bounds,
      angle: parts[0]!.angle, rtl: parts.some(part => part.rtl) });
  }
  cache.set(block, clusters);
  return clusters;
}

export function unionBounds(rects: Rect[]): Rect {
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x,
    height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}

export function clusterCaret(cluster: TextCluster, after: boolean): TextHit {
  const { bounds, angle, rtl } = cluster;
  const vertical = Math.abs(Math.sin(angle)) > Math.SQRT1_2;
  const reverse = (vertical ? Math.sin(angle) < 0 : Math.cos(angle) < 0) !== rtl;
  const far = after !== reverse;
  return { offset: cluster.range[after ? 1 : 0], angle,
    bounds: vertical
      ? { x: bounds.x, y: bounds.y + (far ? bounds.height : 0), width: bounds.width, height: 0 }
      : { x: bounds.x + (far ? bounds.width : 0), y: bounds.y, width: 0, height: bounds.height } };
}

export function hitText(clusters: TextCluster[], x: number, y: number): TextHit | null {
  let nearest: TextCluster | undefined, distance = Infinity;
  for (const cluster of clusters) {
    const b = cluster.bounds;
    const dx = Math.max(b.x - x, 0, x - b.x - b.width);
    const dy = Math.max(b.y - y, 0, y - b.y - b.height);
    const score = dx * dx + dy * dy;
    if (score < distance) { distance = score; nearest = cluster; }
  }
  if (!nearest) return null;
  const before = clusterCaret(nearest, false), after = clusterCaret(nearest, true);
  const distanceTo = ({ bounds: b }: TextHit) => (x - b.x - b.width / 2) ** 2 + (y - b.y - b.height / 2) ** 2;
  return distanceTo(after) < distanceTo(before) ? after : before;
}

export function mergeTextRects(rects: Rect[], vertical = false): Rect[] {
  const along = vertical ? 'y' : 'x', across = vertical ? 'x' : 'y';
  const length = vertical ? 'height' : 'width', thickness = vertical ? 'width' : 'height';
  const merged: Rect[] = [];
  for (const rect of rects.filter(rect => rect.width > 0 && rect.height > 0).toSorted((a, b) => a[across] - b[across] || a[along] - b[along])) {
    const previous = merged.at(-1);
    const overlap = previous ? Math.min(previous[across] + previous[thickness], rect[across] + rect[thickness]) - Math.max(previous[across], rect[across]) : 0;
    const gap = previous ? Math.max(0, rect[along] - previous[along] - previous[length], previous[along] - rect[along] - rect[length]) : Infinity;
    if (previous && overlap >= Math.min(previous[thickness], rect[thickness]) * 0.5 && gap <= Math.min(previous[thickness], rect[thickness]) * 0.8)
      merged[merged.length - 1] = unionBounds([previous, rect]);
    else merged.push({ ...rect });
  }
  return merged;
}

export function selectionRects(clusters: TextCluster[], range: TextRange): Rect[] {
  const selected = clusters.filter(cluster => cluster.range[0] < range[1] && cluster.range[1] > range[0]);
  return mergeTextRects(selected.map(cluster => cluster.bounds), Boolean(selected[0] && Math.abs(Math.sin(selected[0].angle)) > Math.SQRT1_2));
}

export function caretAt(clusters: TextCluster[], offset: number): TextHit | null {
  const next = clusters.find(cluster => cluster.range[0] >= offset);
  if (next) return clusterCaret(next, false);
  const last = clusters.at(-1);
  return last ? clusterCaret(last, true) : null;
}

export function domTextPoint(root: Node, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode(), last: Node = root;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (offset <= length) return { node, offset };
    offset -= length; last = node; node = walker.nextNode();
  }
  return { node: last, offset: last.nodeType === Node.TEXT_NODE ? last.textContent?.length ?? 0 : 0 };
}
