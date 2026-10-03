import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPreparedFonts } from './stage-fonts.mjs';

test('desktop keeps offline CJK and Latin fallback without optional web fonts', () => {
  const records = [
    { id: 'noto-sans-cjk-sc-regular', family: 'Noto Sans CJK SC' },
    { id: 'noto-sans-cjk-sc-bold', family: 'Noto Sans CJK SC' },
    { id: 'liberation-sans-regular', family: 'Liberation Sans' },
    { id: 'liberation-serif-bold', family: 'Liberation Serif' },
    { id: 'liberation-mono-italic', family: 'Liberation Mono' },
    { id: 'lxgw-wenkai-regular', family: 'LXGW WenKai' },
  ];
  assert.equal(selectPreparedFonts(records), records);
  assert.deepEqual(selectPreparedFonts(records, 'desktop'), records.slice(0, 5));
  assert.throws(() => selectPreparedFonts(records, 'invalid'), /Unknown font profile/);
});
