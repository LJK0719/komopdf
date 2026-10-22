import type { DocumentInfo, EngineAdapter, PageModel, TextRange } from '@pdf-editor/contracts';
import { readingRegions } from './reading-order.js';
import { logicalTextBlock, sourceTextOffset } from './source-text.js';
import { findSearchRanges, type SearchOptions, type SearchRange } from './search-matching.js';
import { textActionTarget } from './text-actions.js';
import { prepareTextActionApplication } from './text-action-application.js';

export type SearchSource = { objectId: string; blockId: string; range: TextRange };
export type PdfSearchMatch = {
  pageId: string; pageNumber: number; blockId: string; range: SearchRange;
  sources: SearchSource[]; excerpt: string; excerptRange: SearchRange; isOcr: boolean; replaceable: boolean;
};

function normalized(text: string) {
  let value = '', offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const character of text) {
    const start = offset; offset += character.length;
    if (/[­​﻿]/u.test(character)) continue;
    const part = /\s/u.test(character) ? ' ' : character.normalize('NFKC');
    if (part === ' ' && value.endsWith(' ')) { ends[ends.length - 1] = offset; continue; }
    value += part;
    for (let i = 0; i < part.length; i++) { starts.push(start); ends.push(offset); }
  }
  return { text: value, starts, ends };
}

export function searchPage(page: PageModel, pageNumber: number, query: string, options: SearchOptions = {}): PdfSearchMatch[] {
  const needle = normalized(query).text.trim();
  if (!needle) return [];
  // Readable text is searchable even when it cannot be materialized for editing.
  const readingPage = { ...page, objects: page.objects.map(object => object.textBlock ? { ...object,
    locator: { ...object.locator, containerPath: [] }, textBlock: { ...object.textBlock, isOcr: false,
      editability: 'direct' as const } } : object) };
  const sourceById = new Map(page.objects.map(object => [object.id, object]));
  const matches: PdfSearchMatch[] = [];
  for (const region of readingRegions(readingPage)) {
    const text = region.objects.length === 1 ? logicalTextBlock(region.objects[0]!.textBlock!).runs.map(run => run.text).join('') : region.text;
    const logical = normalized(text);
    for (const hit of findSearchRanges(logical.text, needle, options)) {
      const start = logical.starts[hit.start]!, end = logical.ends[hit.end - 1]!;
      const sources: SearchSource[] = [];
      for (const object of region.objects) {
        const block = sourceById.get(object.id)!.textBlock!;
        const offset = region.sourceRanges[object.id]![0];
        const length = logicalTextBlock(block).runs.reduce((sum, run) => sum + run.text.length, 0);
        if (start >= offset + length || end <= offset) continue;
        const range: TextRange = [sourceTextOffset(block, Math.max(0, start - offset)), sourceTextOffset(block, Math.min(length, end - offset))];
        if (range[1] > range[0]) sources.push({ objectId: object.id, blockId: block.id, range });
      }
      if (!sources.length) continue;
      const excerptStart = Math.max(0, hit.start - 35), excerptEnd = hit.end + 65;
      matches.push({ pageId: page.id, pageNumber, blockId: sources[0]!.blockId, range: { start, end }, sources,
        excerpt: logical.text.slice(excerptStart, excerptEnd), excerptRange: { start: hit.start - excerptStart, end: hit.end - excerptStart },
        isOcr: sources.some(source => sourceById.get(source.objectId)?.textBlock?.isOcr),
        replaceable: (hit.start === 0 || logical.starts[hit.start - 1] !== logical.starts[hit.start])
          && (hit.end === logical.text.length || logical.ends[hit.end - 1] !== logical.ends[hit.end])
          && sources.every(source => sourceById.get(source.objectId)?.textBlock?.editability !== 'geometry-only') });
    }
  }
  return matches;
}

export async function prepareSearchReplacement(engine: EngineAdapter, document: DocumentInfo, match: PdfSearchMatch, text: string) {
  const page = await engine.describePage(document.id, match.pageId);
  const targets = match.sources.map(source => {
    const object = page.objects.find(object => object.id === source.objectId && object.textBlock?.id === source.blockId);
    const target = object && textActionTarget(object, match.pageNumber, source.range);
    if (!target) throw new Error('The source text changed. Select it again before applying.');
    return target;
  });
  const id = targets[0]!.id;
  const prepared = await prepareTextActionApplication({ engine, document, targets,
    units: [{ id, text: '', targetIds: targets.map(target => target.id) }], texts: { [id]: text }, style: {} });
  if (!prepared.transaction) throw new Error('Text does not fit. Shorten it or use a smaller font size.');
  return { ...prepared.transaction, source: 'manual' as const };
}
