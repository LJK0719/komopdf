import type { DocumentInfo, EditCommand, EditTransaction, EngineAdapter, PageModel, TextStyle } from '@pdf-editor/contracts';
import { detectParagraph } from './paragraph-detection.js';
import { paragraphInputRange } from './source-text.js';
import type { TextActionTarget, TextActionUnit } from './text-actions.js';

/** Preserve source glyphs first; replace each readable selection exactly once. */
export async function prepareTextActionApplication(options: {
  engine: EngineAdapter; document: DocumentInfo; targets: TextActionTarget[];
  units: TextActionUnit[]; texts: Record<string, string>; style: TextStyle;
}) {
  const { engine, document, targets, units, texts, style } = options;
  const pages = new Map<string, PageModel>();
  const converted = new Map<string, { blockId: string; offset: number }>();
  const conversions: EditCommand[] = [];
  const replacements: Extract<EditCommand, { type: 'text.replace' }>[] = [];
  const layout: Record<string, string> = {};
  const targetById = new Map(targets.map(target => [target.id, target]));
  const keyOf = (target: TextActionTarget) => `${target.pageId}:${target.blockId}`;
  for (const unit of units) {
    const members = unit.targetIds.map(id => targetById.get(id)!);
    for (const target of members) {
      let page = pages.get(target.pageId);
      if (!page) { page = await engine.describePage(document.id, target.pageId); pages.set(target.pageId, page); }
      const source = page.objects.find(object => object.textBlock?.id === target.blockId)?.textBlock;
      if (!source) throw new Error('The source text changed. Select it again before applying.');
      const sourceText = source.runs.map(run => run.text).join('');
      const partial = target.range[0] !== 0 || target.range[1] !== sourceText.length;
      if (!source.isParagraph && (members.length > 1 || (partial && Object.keys(style).length)) && !converted.has(keyOf(target))) {
        if (!document.capabilities.includes('text.reflow')) throw new Error('This text cannot use a different font until it is converted to an editable paragraph.');
        const paragraph = detectParagraph(page, target.objectId) ?? detectParagraph(page, target.objectId, true);
        if (!paragraph) throw new Error('This text cannot use a different font until it is converted to an editable paragraph.');
        const objectId = crypto.randomUUID();
        conversions.push({ type: 'text.reflow', pageId: page.id, objectId, preserveSource: true,
          blockIds: paragraph.objects.map(object => object.textBlock!.id), text: paragraph.text, bounds: paragraph.bounds,
          style: { fontSize: paragraph.style.fontSize ?? source.runs[0]?.style.fontSize ?? 12,
            lineHeight: paragraph.lineHeight, alignment: paragraph.style.alignment ?? 'left',
            firstLineIndent: paragraph.firstLineIndent, lineSpacing: paragraph.style.lineSpacing ?? 0,
            spaceBefore: paragraph.style.spaceBefore ?? 0, spaceAfter: paragraph.style.spaceAfter ?? 0 } });
        for (const object of paragraph.objects) converted.set(`${page.id}:${object.textBlock!.id}`, {
          blockId: `${objectId}:text`, offset: paragraph.sourceRanges[object.id]![0],
        });
      }
    }
  }
  for (const unit of units) {
    const members = unit.targetIds.map(id => targetById.get(id)!);
    const first = members[0]!;
    const mapped = converted.get(keyOf(first));
    const replacement = texts[unit.id] ?? '';
    if (mapped) {
      let start = Infinity, end = -Infinity;
      for (const target of members) {
        const position = converted.get(keyOf(target));
        if (!position || position.blockId !== mapped.blockId || target.pageId !== first.pageId) throw new Error('The source text changed. Select it again before applying.');
        const source = pages.get(target.pageId)!.objects.find(object => object.textBlock?.id === target.blockId)!.textBlock!;
        const range = paragraphInputRange(source, target.range, position.offset, false);
        start = Math.min(start, range[0]); end = Math.max(end, range[1]);
      }
      replacements.push({ type: 'text.replace', pageId: first.pageId, blockId: mapped.blockId, range: [start, end], text: replacement, style });
      layout[unit.id] = 'Layout checked';
    } else {
      if (members.length !== 1) throw new Error('The source text changed. Select it again before applying.');
      const measured = await engine.previewText({ docId: document.id, pageId: first.pageId, blockId: first.blockId,
        range: first.range, text: replacement, ...(Object.keys(style).length ? { style } : {}) });
      layout[unit.id] = measured.overflow ? 'The result exceeds the text box. Adjust the text, font size, or text box.' : 'Layout fits';
      replacements.push({ type: 'text.replace', pageId: first.pageId, blockId: first.blockId, range: first.range,
        text: replacement, ...(Object.keys(style).length ? { style } : {}) });
    }
  }
  if (Object.values(layout).some(value => !['Layout fits', 'Layout checked'].includes(value))) return { transaction: null, layout, addedPages: 0 };
  replacements.sort((a, b) => a.pageId.localeCompare(b.pageId) || a.blockId.localeCompare(b.blockId) || b.range[0] - a.range[0]);
  const transaction: EditTransaction = { id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision,
    source: 'ai', commands: [...conversions, ...replacements] };
  const preview = await engine.previewTransaction(transaction);
  return { transaction, layout, addedPages: Math.max(0, preview.pageOrder.length - document.pageOrder.length) };
}
