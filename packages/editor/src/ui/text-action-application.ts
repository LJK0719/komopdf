import type { DocumentInfo, EditCommand, EditTransaction, EngineAdapter, PageModel, TextStyle } from '@pdf-editor/contracts';
import { detectParagraph } from './paragraph-detection.js';
import { paragraphInputRange } from './source-text.js';
import type { TextActionTarget, TextActionUnit } from './text-actions.js';

/** Model input is continuous; source ranges remain exact and independently addressable. */
export async function prepareTextActionApplication(options: {
  engine: EngineAdapter; document: DocumentInfo; targets: TextActionTarget[];
  units: TextActionUnit[]; texts: Record<string, string>; style: TextStyle;
}) {
  const { engine, document, targets, units, texts, style } = options;
  const pages = new Map<string, PageModel>();
  const converted = new Map<string, { blockId: string; offset: number; text: string }>();
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
      const partial = target.range[0] !== 0 || target.range[1] !== source.runs.reduce((length, run) => length + run.text.length, 0);
      if (!source.isParagraph && !source.isOcr && (members.length > 1 || (partial && Object.keys(style).length)) && !converted.has(keyOf(target))) {
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
          blockId: `${objectId}:text`, offset: paragraph.sourceRanges[object.id]![0], text: paragraph.text,
        });
      }
    }
  }
  for (const unit of units) {
    const spans: { pageId: string; blockId: string; start: number; end: number; text: string; converted: boolean }[] = [];
    for (const id of unit.targetIds) {
      const target = targetById.get(id)!;
      const source = pages.get(target.pageId)!.objects.find(object => object.textBlock?.id === target.blockId)!.textBlock!;
      const mapped = converted.get(keyOf(target));
      const range = mapped ? paragraphInputRange(source, target.range, mapped.offset, false) : target.range;
      const blockId = mapped?.blockId ?? target.blockId;
      const fullText = mapped?.text ?? source.runs.map(run => run.text).join('');
      const previous = spans.at(-1);
      if (previous && previous.pageId === target.pageId && previous.blockId === blockId && range[0] >= previous.end
        && !fullText.slice(previous.end, range[0]).trim()) previous.end = range[1];
      else spans.push({ pageId: target.pageId, blockId, start: range[0], end: range[1], text: fullText, converted: Boolean(mapped) });
    }
    layout[unit.id] = 'Layout checked';
    for (const [index, span] of spans.entries()) {
      const text = index === 0 ? texts[unit.id] ?? '' : '';
      const range: [number, number] = [span.start, span.end];
      if (!span.converted) {
        const measured = await engine.previewText({ docId: document.id, pageId: span.pageId, blockId: span.blockId,
          range, text, ...(index === 0 && Object.keys(style).length ? { style } : {}) });
        if (measured.overflow) layout[unit.id] = 'The result exceeds the text box. Adjust the text, font size, or text box.';
      }
      replacements.push({ type: 'text.replace', pageId: span.pageId, blockId: span.blockId, range, text,
        ...(index === 0 && Object.keys(style).length ? { style } : {}) });
    }
  }
  if (Object.values(layout).some(value => value !== 'Layout checked')) return { transaction: null, layout, addedPages: 0 };
  replacements.sort((a, b) => a.pageId.localeCompare(b.pageId) || a.blockId.localeCompare(b.blockId) || b.range[0] - a.range[0]);
  const transaction: EditTransaction = { id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision,
    source: 'ai', commands: [...conversions, ...replacements] };
  const preview = await engine.previewTransaction(transaction);
  return { transaction, layout, addedPages: Math.max(0, preview.pageOrder.length - document.pageOrder.length) };
}
