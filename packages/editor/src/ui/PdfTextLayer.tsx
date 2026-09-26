import { useRef, useState } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { Rect, TextRange } from '@pdf-editor/contracts';
import type { LoadedDocument } from './EditorShell.js';
import { useI18n } from './i18n.js';

export type TextSelectionTarget = { objectId: string; blockId: string; range: TextRange; text: string; rects: Rect[] };
export type ReadingAction = 'highlight' | 'underline';
type Props = {
  document: LoadedDocument; zoom: number; disabled: boolean;
  onEdit(document: LoadedDocument, objectId: string, range: TextRange): void;
  onInsert(document: LoadedDocument, point: { x: number; y: number }): void;
  onAnnotate(document: LoadedDocument, targets: TextSelectionTarget[], action: ReadingAction): Promise<void>;
  onError(message: string): void;
};

export function PdfTextLayer({ document: shown, zoom, disabled, onEdit, onInsert, onAnnotate, onError }: Props) {
  const { t } = useI18n();
  const layer = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<TextSelectionTarget[]>([]);
  const [caret, setCaret] = useState<{ x: number; y: number; height: number } | null>(null);
  const [point, setPoint] = useState({ x: 36, y: 36 });
  const contextTargets = useRef<TextSelectionTarget[]>([]);
  const menuOpen = useRef(false);
  const text = targets.map(target => target.text).join('\n');
  const canEdit = shown.info.permissions.modify && shown.info.capabilities.includes('text.replace');
  const readSelection = (): TextSelectionTarget[] => {
    const selection = window.getSelection();
    if (!layer.current || !selection?.rangeCount) return [];
    const range = selection.getRangeAt(0);
    if (!layer.current.contains(range.startContainer) || !layer.current.contains(range.endContainer)) return [];
    const root = layer.current.getBoundingClientRect();
    const result: TextSelectionTarget[] = [];
    for (const span of layer.current.querySelectorAll<HTMLElement>('[data-text-object]')) {
      if (!range.intersectsNode(span)) continue;
      const object = shown.page.objects.find(item => item.id === span.dataset.textObject);
      if (!object?.textBlock) continue;
      const value = object.textBlock.runs.map(run => run.text).join('');
      const textOffset = (node: Node, offset: number) => {
        const prefix = window.document.createRange(); prefix.selectNodeContents(span); prefix.setEnd(node, offset);
        return prefix.toString().length;
      };
      const start = span.contains(range.startContainer) ? textOffset(range.startContainer, range.startOffset) : 0;
      const end = span.contains(range.endContainer) ? textOffset(range.endContainer, range.endOffset) : value.length;
      const part = window.document.createRange();
      part.selectNodeContents(span);
      if (span.firstChild) { part.setStart(span.firstChild, Math.min(start, value.length)); part.setEnd(span.firstChild, Math.min(end, value.length)); }
      const rects = [...part.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({
        x: Math.max(0, (rect.left - root.left) / zoom), y: Math.max(0, (rect.top - root.top) / zoom),
        width: Math.min(rect.width / zoom, shown.page.widthPt - (rect.left - root.left) / zoom), height: rect.height / zoom,
      }));
      result.push({ objectId: object.id, blockId: object.textBlock.id, range: [start, end], text: value.slice(start, end), rects });
    }
    return result;
  };
  const showSelection = () => {
    const next = readSelection(); setTargets(next);
    const selection = window.getSelection();
    if (selection?.isCollapsed && next.length && layer.current) {
      const rect = selection.getRangeAt(0).getClientRects()[0];
      const root = layer.current.getBoundingClientRect();
      setCaret(rect ? { x: rect.left - root.left, y: rect.top - root.top, height: rect.height } : null);
    } else setCaret(null);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch { onError(t('Clipboard access was denied. Use Ctrl/Cmd+C to copy selected text.')); }
  };
  return <ContextMenu.Root onOpenChange={open => { menuOpen.current = open; }}>
    <ContextMenu.Trigger render={<div />} ref={layer} className="pdf-text-layer" aria-label={t('Select text')} tabIndex={0}
      onPointerUp={showSelection}
      onKeyUp={event => { if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') showSelection(); }}
      onBlur={event => { if (!menuOpen.current && !(event.relatedTarget instanceof Element && event.relatedTarget.closest('[role="menu"]'))) setCaret(null); }}
      onContextMenu={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPoint({ x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom });
        const id = (event.target as HTMLElement).closest<HTMLElement>('[data-text-object]')?.dataset.textObject;
        let next = readSelection();
        if (!next.length || (id && !next.some(target => target.objectId === id))) {
          const object = shown.page.objects.find(item => item.id === id);
          if (object?.textBlock) {
            const value = object.textBlock.runs.map(run => run.text).join('');
            next = [{ objectId: object.id, blockId: object.textBlock.id, range: [0, value.length], text: value, rects: [object.bounds] }];
          } else next = [];
        }
        contextTargets.current = next; setTargets(next);
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' && targets.length === 1 && canEdit && !disabled) { event.preventDefault(); onEdit(shown, targets[0]!.objectId, targets[0]!.range); }
      }}>
      {shown.page.objects.filter(item => item.textBlock).map(item => {
        const block = item.textBlock!;
        const style = block.runs[0]?.style;
        return <span key={item.id} data-text-object={item.id} style={{ left: item.bounds.x * zoom, top: item.bounds.y * zoom,
          width: item.bounds.width * zoom, height: item.bounds.height * zoom,
          fontSize: (style?.fontSize ?? 12) * zoom }}>{block.runs.map(run => run.text).join('')}</span>;
      })}
      {caret && <i className="reading-caret" aria-hidden="true" style={{ left: caret.x, top: caret.y, height: caret.height }} />}
    </ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Positioner><ContextMenu.Popup className="ui-menu">
      {targets.length > 0 && <>
        <ContextMenu.Item className="ui-menu-item" disabled={!text || disabled} onClick={() => void copy()}>{t('Copy text')}<kbd>Ctrl/Cmd C</kbd></ContextMenu.Item>
        {targets.length === 1 && <ContextMenu.Item className="ui-menu-item" disabled={!canEdit || disabled} onClick={() => onEdit(shown, targets[0]!.objectId, targets[0]!.range)}>{t(text ? 'Edit selected text' : 'Insert text at cursor')}</ContextMenu.Item>}
        <ContextMenu.Item className="ui-menu-item" disabled={!text || disabled || !shown.info.permissions.annotate || !shown.info.capabilities.includes('annotation.add')}
          onClick={() => void onAnnotate(shown, contextTargets.current, 'highlight')}>{t('Highlight selection')}</ContextMenu.Item>
        <ContextMenu.Item className="ui-menu-item" disabled={!text || disabled || !canEdit || !shown.info.capabilities.includes('text.style')}
          onClick={() => void onAnnotate(shown, contextTargets.current, 'underline')}>{t('Underline text')}</ContextMenu.Item>
        <ContextMenu.Separator className="ui-menu-separator" />
      </>}
      <ContextMenu.Item className="ui-menu-item" disabled={disabled || !shown.info.permissions.modify || !shown.info.capabilities.includes('text.insert')} onClick={() => onInsert(shown, point)}>{t('Add text here')}</ContextMenu.Item>
    </ContextMenu.Popup></ContextMenu.Positioner></ContextMenu.Portal>
  </ContextMenu.Root>;
}
