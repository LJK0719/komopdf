import type { DocumentInfo, EditCommand, EditTransaction, EngineAdapter, PageModel, TextStyle } from '@pdf-editor/contracts';
import { detectParagraph } from './paragraph-detection.js';
import { paragraphInputRange } from './source-text.js';
import type { TextActionTarget } from './text-actions.js';

/** Use the same source-preserving paragraph path as manual mixed-font editing. */
export async function prepareTextActionApplication(options: {
  engine: EngineAdapter; document: DocumentInfo; targets: TextActionTarget[];
  texts: Record<string, string>; style: TextStyle;
}) {
  const { engine, document, targets, texts, style } = options;
  const pages = new Map<string, PageModel>();
  const converted = new Map<string, { blockId: string; offset: number }>();
  const conversions: EditCommand[] = [];
  const replacements: Extract<EditCommand, { type: 'text.replace' }>[] = [];
  const layout: Record<string, string> = {};
  const convertedTargets = new Set<string>();
  for (const target of targets) {
    let page = pages.get(target.pageId);
    if (!page) { page = await engine.describePage(document.id, target.pageId); pages.set(target.pageId, page); }
    const source = page.objects.find(object => object.textBlock?.id === target.blockId)?.textBlock;
    if (!source) throw new Error('The source text changed. Select it again before applying.');
    const sourceText = source.runs.map(run => run.text).join('');
    const partial = target.range[0] !== 0 || target.range[1] !== sourceText.length;
    const key = `${target.pageId}:${target.blockId}`;
    if (!source.isParagraph && partial && Object.keys(style).length && !converted.has(key)) {
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
  for (const target of targets) {
    const source = pages.get(target.pageId)!.objects.find(object => object.textBlock?.id === target.blockId)!.textBlock!;
    const mapped = converted.get(`${target.pageId}:${target.blockId}`);
    const replacement = texts[target.id] ?? '';
    if (mapped) {
      convertedTargets.add(target.id);
      replacements.push({ type: 'text.replace', pageId: target.pageId, blockId: mapped.blockId,
        range: paragraphInputRange(source, target.range, mapped.offset, false), text: replacement, style });
    } else {
      const measured = await engine.previewText({ docId: document.id, pageId: target.pageId, blockId: target.blockId,
        range: target.range, text: replacement, ...(Object.keys(style).length ? { style } : {}) });
      layout[target.id] = measured.overflow ? 'The result exceeds the text box. Adjust the text, font size, or text box.' : 'Layout fits';
      replacements.push({ type: 'text.replace', pageId: target.pageId, blockId: target.blockId, range: target.range,
        text: replacement, ...(Object.keys(style).length ? { style } : {}) });
    }
  }
  if (Object.values(layout).some(value => value !== 'Layout fits')) return { transaction: null, layout, addedPages: 0 };
  replacements.sort((a, b) => a.pageId.localeCompare(b.pageId) || a.blockId.localeCompare(b.blockId) || b.range[0] - a.range[0]);
  const transaction: EditTransaction = { id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision,
    source: 'ai', commands: [...conversions, ...replacements] };
  const preview = await engine.previewTransaction(transaction);
  for (const id of convertedTargets) layout[id] = 'Layout checked';
  return { transaction, layout, addedPages: Math.max(0, preview.pageOrder.length - document.pageOrder.length) };
}
