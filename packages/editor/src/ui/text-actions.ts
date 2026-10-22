import type { DocumentInfo, EditableObject, PageModel, Rect, TextAction, TextRange, TextStyle } from '@pdf-editor/contracts';
import { readingRegions } from './reading-order.js';
import { logicalTextBlock, logicalTextRange } from './source-text.js';

export const TEXT_ACTION_LABELS: Record<TextAction, string> = {
  translate: 'AI translate', explain: 'Explain selection', summarize: 'Summarize selection',
  proofread: 'Proofread selection', rewrite: 'Rewrite selection', shorten: 'Shorten selection',
};
export type TextActionTarget = {
  id: string; pageId: string; pageNumber: number; objectId: string; blockId: string;
  range: TextRange; text: string; blockText: string; rects: Rect[]; style: TextStyle;
};
export type TextActionUnit = { id: string; text: string; targetIds: string[] };
export type TextActionSelection = {
  id: string; documentId: string; revision: number; name: string; action: TextAction;
  targets: TextActionTarget[]; units?: TextActionUnit[];
  anchor?: { left: number; top: number; right: number; bottom: number };
  draft?: { current(): boolean; replace(text: string): boolean };
};
export function normalizeActionText(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}
export function selectionUnits(selection: TextActionSelection): TextActionUnit[] {
  const parts = selection.units ?? selection.targets.map(target => ({ id: target.id, text: target.text, targetIds: [target.id] }));
  if (!parts.length) return [];
  return [{ id: parts[0]!.id, text: normalizeActionText(parts.map(part => part.text).join('\n')),
    targetIds: parts.flatMap(part => part.targetIds) }];
}

/** Model input follows readable paragraphs, not the PDF's glyph/object boundaries. */
export function textActionUnits(page: PageModel, targets: readonly TextActionTarget[]): TextActionUnit[] {
  const pending = new Map(targets.filter(target => target.pageId === page.id).map(target => [target.objectId, target]));
  const units: TextActionUnit[] = [];
  for (const region of readingRegions(page)) {
    const regionText = region.objects.length === 1
      ? logicalTextBlock(region.objects[0]!.textBlock!).runs.map(run => run.text).join('') : region.text;
    let group: { start: number; end: number; targets: TextActionTarget[] } | null = null;
    const flush = () => {
      if (group) units.push({ id: group.targets[0]!.id, text: group.targets.length === 1 ? group.targets[0]!.text : regionText.slice(group.start, group.end), targetIds: group.targets.map(target => target.id) });
      group = null;
    };
    for (const object of region.objects) {
      const target = pending.get(object.id);
      if (!target) continue;
      pending.delete(object.id);
      const local = logicalTextRange(object.textBlock!, target.range);
      const offset = region.sourceRanges[object.id]![0];
      const start = offset + local[0], end = offset + local[1];
      if (group && (start < group.end || regionText.slice(group.end, start).trim())) flush();
      if (group) { group.end = end; group.targets.push(target); }
      else group = { start, end, targets: [target] };
    }
    flush();
  }
  for (const target of pending.values()) units.push({ id: target.id, text: target.text, targetIds: [target.id] });
  return units;
}
export type AiMaterial = {
  id: string; documentId: string; revision: number; name: string;
  kind: 'selection' | 'document' | 'text'; text: string;
  generatedText?: string; action?: TextAction; sourceLanguage?: string; targetLanguage?: string;
  locations: { pageId: string; pageNumber: number; blockId?: string; range?: TextRange; text?: string }[];
};
export type AiHandoff = { id: string; materials: AiMaterial[]; question?: string };

export function textActionTarget(object: EditableObject, pageNumber: number, range?: TextRange, text?: string, rects?: Rect[]): TextActionTarget | null {
  const block = object.textBlock;
  if (!block) return null;
  const blockText = block.runs.map(run => run.text).join('');
  const selected = range ?? [0, blockText.length];
  const value = text ?? blockText.slice(...selected);
  if (!value.trim()) return null;
  return { id: crypto.randomUUID(), pageId: object.pageId, pageNumber, objectId: object.id, blockId: block.id,
    range: [...selected], text: value, blockText, rects: rects ?? [object.bounds], style: { ...block.runs[0]?.style } };
}
export function textActionSelection(document: DocumentInfo, name: string, targets: TextActionTarget[], action: TextAction = 'translate', pages: readonly PageModel[] = []): TextActionSelection {
  const units = pages.length ? pages.flatMap(page => textActionUnits(page, targets)) : undefined;
  const range = globalThis.window?.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
  const rect = range?.getBoundingClientRect();
  return { id: crypto.randomUUID(), documentId: document.id, revision: document.revision, name, action, targets,
    ...(units ? { units } : {}), ...(rect && rect.width > 0 ? { anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } } : {}) };
}
export function selectionMaterial(selection: TextActionSelection, generatedText?: string, languages?: { sourceLanguage: string; targetLanguage: string }): AiMaterial {
  return { id: crypto.randomUUID(), documentId: selection.documentId, revision: selection.revision, name: selection.name,
    kind: selection.draft ? 'text' : 'selection', text: selectionUnits(selection).map(unit => unit.text).join('\n\n'), action: selection.action,
    ...(generatedText ? { generatedText } : {}), ...(languages ?? {}),
    locations: selection.targets.map(target => ({ pageId: target.pageId, pageNumber: target.pageNumber,
      ...(selection.draft ? {} : { blockId: target.blockId, range: target.range }), text: target.text })) };
}
