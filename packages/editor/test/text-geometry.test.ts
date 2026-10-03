import { describe, expect, it } from 'vitest';
import type { TextBlock } from '@pdf-editor/contracts';
import { caretAt, hitText, selectionRects, textClusters } from '../src/ui/text-geometry.js';

function block(text = 'A中B'): TextBlock {
  return { id: 'text', pageId: 'p', sourceObjectIds: ['o'], bounds: { x: 20, y: 30, width: 40, height: 12 },
    transform: [1, 0, 0, -1, 0, 0], editability: 'direct', runs: [{ text, style: {}, sourceObjectIds: ['o'] }],
    characters: Array.from({ length: text.length }, (_, i) => ({ range: [i, i + 1],
      bounds: { x: 20 + i * 10, y: 30, width: 10, height: 12 }, angle: 0, rtl: false })) };
}
describe('PDF text geometry', () => {
  it('places the last-character right half and right margin after the final character', () => {
    const clusters = textClusters(block());
    expect(hitText(clusters, 42, 35)?.offset).toBe(2);
    expect(hitText(clusters, 48, 35)?.offset).toBe(3);
    expect(hitText(clusters, 55, 35)?.offset).toBe(3);
    expect(caretAt(clusters, 3)?.bounds.x).toBe(50);
    expect(selectionRects(clusters, [0, 3])).toEqual([{ x: 20, y: 30, width: 30, height: 12 }]);
  });
  it('does not place a caret inside emoji or a combining character', () => {
    const clusters = textClusters(block('👋🏻Á'));
    expect(clusters.map(cluster => cluster.range)).toEqual([[0, 4], [4, 6]]);
    expect(hitText(clusters, 42, 35)?.offset).toBe(4);
  });
  it('keeps shared ligature geometry together rather than losing its last character', () => {
    const value = block('fi'); value.characters![1]!.bounds = { ...value.characters![0]!.bounds };
    const clusters = textClusters(value);
    expect(clusters.map(cluster => cluster.range)).toEqual([[0, 2]]);
    expect(hitText(clusters, 29, 35)?.offset).toBe(2);
  });
  it('uses visual direction for RTL and rotated baselines', () => {
    const rtl = block('א'); rtl.characters![0]!.rtl = true;
    expect(hitText(textClusters(rtl), 21, 35)?.offset).toBe(1);
    expect(hitText(textClusters(rtl), 29, 35)?.offset).toBe(0);
    const vertical = block('A'); vertical.characters![0]!.angle = Math.PI / 2;
    expect(hitText(textClusters(vertical), 25, 41)?.offset).toBe(1);
  });
  it('keeps explicit newlines in logical ranges without creating false glyph boxes', () => {
    const value = block('A\nB');
    value.characters = [value.characters![0]!, { ...value.characters![2]!, bounds: { x: 20, y: 50, width: 10, height: 12 } }];
    const clusters = textClusters(value);
    expect(clusters.map(cluster => cluster.text)).toEqual(['A', 'B']);
    expect(hitText(clusters, 29, 55)?.offset).toBe(3);
    expect(selectionRects(clusters, [0, 3])).toHaveLength(2);
  });
});
