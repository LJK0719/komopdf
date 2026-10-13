import { describe, expect, it } from 'vitest';
import type { EditableObject, TextBlock } from '@pdf-editor/contracts';
import type { ParagraphCandidate } from '../src/ui/paragraph-detection.js';
import { inlineTextClusters, sourceLineRange } from '../src/ui/inline-text-geometry.js';
import { caretAt, hitText } from '../src/ui/text-geometry.js';

function object(id: string, text: string, x: number, y = 40): EditableObject {
  const bounds = { x, y, width: text.length * 10, height: 12 };
  const block: TextBlock = { id: `${id}-text`, pageId: 'p', bounds, transform: [0.75, 0, 0, -0.75, x, y],
    sourceObjectIds: [id], editability: 'direct', runs: [{ text, style: { fontId: 'pdf:SimSun', fontSize: 16 }, sourceObjectIds: [id] }],
    characters: [...text].map((_, i) => ({ range: [i, i + 1], bounds: { x: x + i * 10, y, width: 8, height: 12 }, angle: 0, rtl: false })) };
  return { id, pageId: 'p', type: 'text', bounds, transform: block.transform, textBlock: block, locator: { pageId: 'p', objectIndex: 0, containerPath: [] } };
}

describe('inline source selection geometry', () => {
  it('merges every source object, with inferred spaces and logical offsets, without scaling page coordinates again', () => {
    const first = object('a', '中文', 20), last = object('b', '末尾', 60);
    first.textBlock!.inferredSpaces = [1];
    const runs = [{ text: '中 文末尾', style: {}, sourceObjectIds: ['a', 'b'] }];
    const block = { ...first.textBlock!, runs };
    const paragraph = { objects: [first, last], sourceRanges: { a: [0, 3], b: [3, 5] } } as unknown as ParagraphCandidate;
    const clusters = inlineTextClusters(block, paragraph);
    expect(clusters.map(cluster => cluster.range)).toEqual([[0, 1], [2, 3], [3, 4], [4, 5]]);
    expect(clusters.map(cluster => cluster.bounds.x)).toEqual([20, 30, 60, 70]);
    expect(hitText(clusters, 71, 45)?.offset).toBe(4);
    expect(hitText(clusters, 77, 45)?.offset).toBe(5);
    expect(caretAt(clusters, 5)?.bounds.x).toBe(78);
  });
  it('uses source rows rather than browser wraps for Home and End, retaining line-end affinity', () => {
    const first = object('a', '前行', 20), last = object('b', '末行', 20, 60);
    const runs = [{ text: '前行末行', style: {}, sourceObjectIds: ['a', 'b'] }];
    const paragraph = { objects: [first, last], sourceRanges: { a: [0, 2], b: [2, 4] } } as unknown as ParagraphCandidate;
    const clusters = inlineTextClusters({ ...first.textBlock!, runs }, paragraph);
    expect(sourceLineRange(clusters, 1)).toEqual([0, 2]);
    expect(sourceLineRange(clusters, 3)).toEqual([2, 4]);
    const firstEnd = hitText(clusters, 37, 45)!;
    expect(firstEnd.offset).toBe(2);
    expect(sourceLineRange(clusters, 2, firstEnd.bounds)).toEqual([0, 2]);
  });
  it('reuses plain block geometry and leaves unavailable geometry empty', () => {
    const block = object('a', '测试', 20).textBlock!;
    expect(inlineTextClusters(block, null)).toBe(inlineTextClusters(block, null));
    expect(inlineTextClusters({ ...block, characters: [] }, null)).toEqual([]);
  });
});
