import type { DocumentInfo, EditableObject, Rect, TextAction, TextRange, TextStyle } from '@pdf-editor/contracts';

export const TEXT_ACTION_LABELS: Record<TextAction, string> = {
  translate: 'AI translate', explain: 'Explain selection', summarize: 'Summarize selection',
  proofread: 'Proofread selection', rewrite: 'Rewrite selection', shorten: 'Shorten selection',
};
export type TextActionTarget = {
  id: string; pageId: string; pageNumber: number; objectId: string; blockId: string;
  range: TextRange; text: string; blockText: string; rects: Rect[]; style: TextStyle;
};
export type TextActionSelection = {
  id: string; documentId: string; revision: number; name: string; action: TextAction;
  targets: TextActionTarget[];
  draft?: { current(): boolean; replace(text: string): boolean };
};
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
export function textActionSelection(document: DocumentInfo, name: string, targets: TextActionTarget[], action: TextAction = 'translate'): TextActionSelection {
  return { id: crypto.randomUUID(), documentId: document.id, revision: document.revision, name, action, targets };
}
export function selectionMaterial(selection: TextActionSelection, generatedText?: string, languages?: { sourceLanguage: string; targetLanguage: string }): AiMaterial {
  return { id: crypto.randomUUID(), documentId: selection.documentId, revision: selection.revision, name: selection.name,
    kind: selection.draft ? 'text' : 'selection', text: selection.targets.map(target => target.text).join('\n'), action: selection.action,
    ...(generatedText ? { generatedText } : {}), ...(languages ?? {}),
    locations: selection.targets.map(target => ({ pageId: target.pageId, pageNumber: target.pageNumber,
      ...(selection.draft ? {} : { blockId: target.blockId, range: target.range }), text: target.text })) };
}

export function splitTextActionTargets(targets: readonly TextActionTarget[], limit = 2000): { id: string; targetId: string; text: string }[] {
  return targets.flatMap(target => {
    const chunks: { id: string; targetId: string; text: string }[] = [];
    let part = '';
    const push = () => { if (part) chunks.push({ id: `${target.id}:${chunks.length}`, targetId: target.id, text: part }); part = ''; };
    const append = (text: string) => { if (part.length + text.length > limit) push(); part += text; };
    for (const item of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(target.text)) {
      if (item.segment.length <= limit) append(item.segment);
      else for (const word of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(item.segment)) {
        if (word.segment.length <= limit) append(word.segment);
        else for (const character of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word.segment)) append(character.segment);
      }
    }
    push();
    return chunks;
  });
}
