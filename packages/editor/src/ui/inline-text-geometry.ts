import type { Rect, TextBlock, TextCharacter } from '@pdf-editor/contracts';
import type { ParagraphCandidate } from './paragraph-detection.js';
import { logicalTextBlock } from './source-text.js';
import { caretAt, textClusters, type TextCluster } from './text-geometry.js';

export function inlineTextClusters(block: TextBlock, paragraph: ParagraphCandidate | null): TextCluster[] {
  if (!paragraph) return textClusters(block);
  const characters: TextCharacter[] = [];
  for (const object of paragraph.objects) {
    const offset = paragraph.sourceRanges[object.id]?.[0] ?? 0;
    for (const character of logicalTextBlock(object.textBlock!).characters ?? []) {
      characters.push({ ...character, range: [offset + character.range[0], offset + character.range[1]] });
    }
  }
  return textClusters({ ...block, characters });
}

// Source lines can differ from the invisible input's browser wrapping.
export function sourceLineRange(clusters: TextCluster[], offset: number, affinity?: Rect): [number, number] | null {
  const bounds = affinity ?? caretAt(clusters, offset)?.bounds;
  if (!bounds) return null;
  const y = bounds.y + bounds.height / 2;
  const line = clusters.filter(cluster => y >= cluster.bounds.y && y <= cluster.bounds.y + cluster.bounds.height);
  if (!line.length) return null;
  return [Math.min(...line.map(cluster => cluster.range[0])), Math.max(...line.map(cluster => cluster.range[1]))];
}
