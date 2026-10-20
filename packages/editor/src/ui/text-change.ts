import type { StyledTextRun, TextBlock, TextRange, TextStyle } from '@pdf-editor/contracts';

/** Compare styles in the final text coordinates without replacing untouched fonts. */
export function textStyleChanges(before: StyledTextRun[], after: StyledTextRun[]): { range: TextRange; style: TextStyle }[] {
  const original = before.filter(run => run.text), desired = after.filter(run => run.text);
  const changes: { range: TextRange; style: TextStyle }[] = [];
  let left = 0, right = 0, start = 0, leftEnd = original[0]?.text.length ?? 0, rightEnd = desired[0]?.text.length ?? 0;
  while (left < original.length && right < desired.length) {
    const end = Math.min(leftEnd, rightEnd), a = original[left]!.style, b = desired[right]!.style;
    const style: TextStyle = {};
    if (b.fontId && b.fontId !== a.fontId) style.fontId = b.fontId;
    if (b.fontSize !== undefined && b.fontSize !== a.fontSize) style.fontSize = b.fontSize;
    if ((b.characterSpacing ?? 0) !== (a.characterSpacing ?? 0)) style.characterSpacing = b.characterSpacing ?? 0;
    if (Boolean(b.underline) !== Boolean(a.underline)) style.underline = Boolean(b.underline);
    if (JSON.stringify(b.color ?? [0, 0, 0]) !== JSON.stringify(a.color ?? [0, 0, 0])) style.color = b.color ?? [0, 0, 0];
    if (Object.keys(style).length) {
      const previous = changes.at(-1);
      if (previous && previous.range[1] === start && JSON.stringify(previous.style) === JSON.stringify(style)) previous.range[1] = end;
      else changes.push({ range: [start, end], style });
    }
    start = end;
    if (leftEnd === end) leftEnd += original[++left]?.text.length ?? 0;
    if (rightEnd === end) rightEnd += desired[++right]?.text.length ?? 0;
  }
  return changes;
}

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
