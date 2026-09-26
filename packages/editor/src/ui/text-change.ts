import type { TextBlock, TextRange } from '@pdf-editor/contracts';

export function textChange(before: string, after: string): { range: TextRange; text: string } {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const old = [...segmenter.segment(before)], next = [...segmenter.segment(after)];
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix]!.segment === next[prefix]!.segment) prefix++;
  while (suffix < old.length - prefix && suffix < next.length - prefix &&
    old[old.length - suffix - 1]!.segment === next[next.length - suffix - 1]!.segment) suffix++;
  const start = old[prefix]?.index ?? before.length;
  const end = old[old.length - suffix]?.index ?? before.length;
  const newEnd = next[next.length - suffix]?.index ?? after.length;
  return { range: [start, end], text: after.slice(start, newEnd) };
}

export function changedBlock(block: TextBlock, text: string): TextBlock {
  const original = block.runs.map(run => run.text).join('');
  const change = textChange(original, text);
  const runs: TextBlock['runs'] = [];
  const appendSlice = (start: number, end: number) => {
    let offset = 0;
    for (const run of block.runs) {
      const value = run.text.slice(Math.max(0, start - offset), Math.max(0, Math.min(run.text.length, end - offset)));
      if (value) runs.push({ ...run, text: value });
      offset += run.text.length;
    }
  };
  appendSlice(0, change.range[0]);
  if (change.text) {
    let offset = 0;
    const source = block.runs.find(run => { offset += run.text.length; return offset > change.range[0]; }) ?? block.runs.at(-1)!;
    runs.push({ ...source, text: change.text });
  }
  appendSlice(change.range[1], original.length);
  return { ...block, runs };
}
