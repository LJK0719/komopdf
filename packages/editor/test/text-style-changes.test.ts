import { describe, expect, it } from 'vitest';
import type { StyledTextRun, TextBlock, TextStyle } from '@pdf-editor/contracts';
import { changedBlock, textStyleChanges } from '../src/ui/text-change.js';

const run = (text: string, style: TextStyle = { fontId: 'pdf:Helvetica', fontSize: 18 }): StyledTextRun => ({ text, style, sourceObjectIds: [] });

describe('local paragraph style changes', () => {
  it('does not resolve or replace unchanged source fonts when runs are split', () => {
    expect(textStyleChanges([run('Alpha beta')], [run('Alpha'), run(' beta')])).toEqual([]);
  });
  it('changes only the selected font range', () => {
    expect(textStyleChanges([run('Alpha beta')], [run('Alpha', { fontId: 'bold', fontSize: 18 }), run(' beta')]))
      .toEqual([{ range: [0, 5], style: { fontId: 'bold' } }]);
  });
  it('sends local size and color without a source font identifier', () => {
    expect(textStyleChanges([run('ABCD')], [run('AB'), run('CD', { fontId: 'pdf:Helvetica', fontSize: 24, color: [1, 0, 0] })]))
      .toEqual([{ range: [2, 4], style: { fontSize: 24, color: [1, 0, 0] } }]);
  });
  it('compares inserted text with the inherited source style in final coordinates', () => {
    const block = { runs: [run('Alpha beta')] } as TextBlock;
    const baseline = changedBlock(block, 'Alpha Xbeta');
    expect(textStyleChanges(baseline.runs, [run('Alpha '), run('X', { fontId: 'bold', fontSize: 18 }), run('beta')]))
      .toEqual([{ range: [6, 7], style: { fontId: 'bold' } }]);
  });
  it('merges adjoining equal changes and keeps explicit reset values', () => {
    const before = [run('AB', { fontId: 'pdf:Helvetica', underline: true, characterSpacing: 2 })];
    const after = [run('A', { fontId: 'pdf:Helvetica' }), run('B', { fontId: 'pdf:Helvetica' })];
    expect(textStyleChanges(before, after)).toEqual([{ range: [0, 2], style: { characterSpacing: 0, underline: false } }]);
  });
});
