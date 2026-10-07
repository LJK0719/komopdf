import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { Rect, TextRange } from '@pdf-editor/contracts';
import type { LoadedDocument } from './EditorShell.js';
import { useI18n } from './i18n.js';
import { caretAt, domTextPoint, hitText, mergeTextRects, selectionRects, textClusters } from './text-geometry.js';
import { readingRegions, type ReadingRegion } from './reading-order.js';
import { logicalTextBlock, logicalTextRange, sourceTextOffset } from './source-text.js';

export type TextSelectionTarget = { objectId: string; blockId: string; range: TextRange; logicalRange?: TextRange; text: string; rects: Rect[] };
export type ReadingAction = 'highlight' | 'underline';
type Props = {
  document: LoadedDocument; zoom: number; disabled: boolean;
  onEdit(document: LoadedDocument, objectId: string, range: TextRange, rangeIsLogical?: boolean): void;
  onInsert(document: LoadedDocument, point: { x: number; y: number }): void;
  onAnnotate(document: LoadedDocument, targets: TextSelectionTarget[], action: ReadingAction): Promise<void>;
  onError(message: string): void;
};
type DomPoint = { node: Node; offset: number };
const pageHitTests = new WeakMap<Element, (x: number, y: number) => DomPoint | null>();

// Editor ranges are logical offsets relative to the seed's paragraph position.
// Native annotation/style targets keep their separate per-object source ranges.
export function paragraphEditRange(region: ReadingRegion, targets: readonly TextSelectionTarget[]): TextRange | null {
  const first = targets[0];
  const seed = first && region.objects.find(object => object.id === first.objectId)?.textBlock;
  const origin = first && region.sourceRanges[first.objectId]?.[0];
  if (!seed || origin === undefined) return null;
  let start = Infinity, end = -Infinity;
  for (const target of targets) {
    const block = region.objects.find(object => object.id === target.objectId)?.textBlock;
    const range = region.sourceRanges[target.objectId];
    if (!range || !block || block.editability === 'geometry-only') return null;
    const logical = target.logicalRange ?? logicalTextRange(block, target.range);
    start = Math.min(start, range[0] + logical[0]);
    end = Math.max(end, range[0] + logical[1]);
  }
  return [start - origin, end - origin];
}

export function PdfTextLayer({ document: shown, zoom, disabled, onEdit, onInsert, onAnnotate, onError }: Props) {
  const { t } = useI18n();
  const layer = useRef<HTMLDivElement>(null);
  const anchor = useRef<DomPoint | null>(null);
  const affinity = useRef<{ objectId: string; offset: number; bounds: Rect } | null>(null);
  const [targets, setTargets] = useState<TextSelectionTarget[]>([]);
  const [localSelection, setLocalSelection] = useState(true);
  const contextText = useRef('');
  const [caret, setCaret] = useState<Rect | null>(null);
  const [point, setPoint] = useState({ x: 36, y: 36 });
  const contextTargets = useRef<TextSelectionTarget[]>([]);
  const menuOpen = useRef(false);
  const canEdit = shown.info.permissions.modify && shown.info.capabilities.includes('text.replace');
  const { objects, prefixes, byId, sourceById } = useMemo(() => {
    const regions = readingRegions(shown.page), prefixes = new Map<string, string>();
    regions.forEach((region, index) => {
      let end = 0;
      region.objects.forEach((object, position) => {
        const range = region.sourceRanges[object.id]!;
        prefixes.set(object.id, (index > 0 && position === 0 ? '\n\n' : '') + region.text.slice(end, range[0]));
        end = range[1];
      });
    });
    const sources = regions.flatMap(region => region.objects);
    const objects = sources.map(object => ({ ...object, textBlock: logicalTextBlock(object.textBlock!) }));
    return { objects, prefixes, byId: new Map(objects.map(object => [object.id, object])),
      sourceById: new Map(sources.map(object => [object.id, object.textBlock!])) };
  }, [shown.page]);
  const text = targets.map(target => target.text).join('\n');
  const editTarget = (() => {
    const first = targets[0];
    if (!first || !localSelection) return null;
    const region = readingRegions(shown.page).find(region => region.sourceRanges[first.objectId]);
    if (!region) return null;
    const range = paragraphEditRange(region, targets);
    return range ? { objectId: first.objectId, range } : null;
  })();

  const readSelection = (): TextSelectionTarget[] => {
    const selection = window.getSelection();
    if (!layer.current || !selection?.rangeCount) return [];
    const range = selection.getRangeAt(0);
    const result: TextSelectionTarget[] = [];
    for (const span of layer.current.querySelectorAll<HTMLElement>('[data-text-object]')) {
      if (!range.intersectsNode(span)) continue;
      const object = byId.get(span.dataset.textObject ?? '');
      if (!object?.textBlock) continue;
      const block = object.textBlock, value = block.runs.map(run => run.text).join('');
      const textOffset = (node: Node, offset: number) => {
        const prefix = window.document.createRange(); prefix.selectNodeContents(span); prefix.setEnd(node, offset);
        return prefix.toString().length;
      };
      const start = span.contains(range.startContainer) ? textOffset(range.startContainer, range.startOffset) : 0;
      const end = span.contains(range.endContainer) ? textOffset(range.endContainer, range.endOffset) : value.length;
      const clusters = textClusters(block);
      let rects = selectionRects(clusters, [start, end]);
      if (!clusters.length && start !== end) {
        const part = window.document.createRange(), a = domTextPoint(span, start), b = domTextPoint(span, end);
        part.setStart(a.node, a.offset); part.setEnd(b.node, b.offset);
        const root = layer.current.getBoundingClientRect();
        rects = [...part.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({
          x: (rect.left - root.left) / zoom, y: (rect.top - root.top) / zoom, width: rect.width / zoom, height: rect.height / zoom,
        }));
      }
      const source = sourceById.get(object.id)!;
      result.push({ objectId: object.id, blockId: block.id, range: [sourceTextOffset(source, start), sourceTextOffset(source, end)], logicalRange: [start, end], text: value.slice(start, end), rects });
    }
    return result;
  };
  const showSelection = () => {
    const next = readSelection(); setTargets(next);
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    setLocalSelection(Boolean(range && layer.current?.contains(range.startContainer) && layer.current.contains(range.endContainer)));
    if (selection?.isCollapsed && next.length && layer.current && layer.current.contains(selection.focusNode)) {
      const target = next[0]!, block = byId.get(target.objectId)?.textBlock;
      const source = sourceById.get(target.objectId);
      const offset = target.logicalRange?.[0] ?? (source ? logicalTextRange(source, target.range)[0] : target.range[0]);
      const hit = block && caretAt(textClusters(block), offset);
      if (affinity.current?.objectId === target.objectId && affinity.current.offset === offset) setCaret(affinity.current.bounds);
      else if (hit) setCaret(hit.bounds);
      else {
        const rect = selection.getRangeAt(0).getClientRects()[0], root = layer.current.getBoundingClientRect();
        setCaret(rect ? { x: (rect.left - root.left) / zoom, y: (rect.top - root.top) / zoom, width: 0, height: rect.height / zoom } : null);
      }
    } else setCaret(null);
  };
  const latest = useRef(showSelection); latest.current = showSelection;
  useEffect(() => {
    let frame = 0;
    const change = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => latest.current()); };
    window.document.addEventListener('selectionchange', change);
    return () => { cancelAnimationFrame(frame); window.document.removeEventListener('selectionchange', change); };
  }, []);
  useLayoutEffect(() => {
    const root = layer.current;
    if (!root) return;
    setCaret(null); setTargets([]); anchor.current = null; affinity.current = null;
    pageHitTests.set(root, (clientX, clientY) => {
      const rect = root.getBoundingClientRect(), x = (clientX - rect.left) / zoom, y = (clientY - rect.top) / zoom;
      let best: { objectId: string; offset: number; bounds: Rect } | null = null, distance = Infinity;
      for (const object of objects) {
        const hit = hitText(textClusters(object.textBlock!), x, y);
        if (!hit) continue;
        const b = hit.bounds;
        const dx = Math.max(b.x - x, 0, x - b.x - b.width), dy = Math.max(b.y - y, 0, y - b.y - b.height);
        const score = dx * dx + dy * dy;
        if (score < distance) { best = { objectId: object.id, offset: hit.offset, bounds: hit.bounds }; distance = score; }
      }
      const span = best && [...root.querySelectorAll<HTMLElement>('[data-text-object]')].find(node => node.dataset.textObject === best.objectId);
      affinity.current = best;
      return best && span ? domTextPoint(span, best.offset) : null;
    });
    return () => { pageHitTests.delete(root); };
  }, [shown.page, shown.info.revision, zoom]);
  const copy = async () => {
    try { if (shown.info.permissions.copy) await navigator.clipboard.writeText(contextText.current || text); }
    catch { onError(t('Clipboard access was denied. Use Ctrl/Cmd+C to copy selected text.')); }
  };

  return <ContextMenu.Root onOpenChange={open => { menuOpen.current = open; }}>
    <ContextMenu.Trigger render={<div />} ref={layer} className="pdf-text-layer" aria-label={t('Select text')} tabIndex={0}
      onPointerDown={event => {
        if (event.button !== 0 || disabled || !layer.current) return;
        const hit = pageHitTests.get(layer.current)?.(event.clientX, event.clientY);
        if (!hit) return;
        event.preventDefault(); layer.current.focus({ preventScroll: true });
        const selection = window.getSelection();
        const start = event.shiftKey && selection?.anchorNode ? { node: selection.anchorNode, offset: selection.anchorOffset } : hit;
        anchor.current = start;
        selection?.setBaseAndExtent(start.node, start.offset, hit.node, hit.offset);
        event.currentTarget.setPointerCapture(event.pointerId);
        showSelection();
      }}
      onPointerMove={event => {
        if (!anchor.current || !(event.buttons & 1)) return;
        const root = window.document.elementFromPoint(event.clientX, event.clientY)?.closest('.pdf-text-layer');
        const hit = root && pageHitTests.get(root)?.(event.clientX, event.clientY);
        if (hit) window.getSelection()?.setBaseAndExtent(anchor.current.node, anchor.current.offset, hit.node, hit.offset);
      }}
      onPointerUp={event => { anchor.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); showSelection(); }}
      onPointerCancel={() => { anchor.current = null; setCaret(null); }}
      onDoubleClick={() => {
        const selection = window.getSelection();
        if (!selection?.focusNode || !layer.current?.contains(selection.focusNode)) return;
        const span = selection.focusNode.parentElement?.closest<HTMLElement>('[data-text-object]');
        const target = readSelection()[0];
        if (!span || !target) return;
        const value = span.textContent ?? '';
        const offset = target.logicalRange?.[0] ?? logicalTextRange(sourceById.get(target.objectId)!, target.range)[0];
        const segment = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(value)]
          .find(part => part.index <= offset && part.index + part.segment.length > offset);
        if (segment) {
          const start = domTextPoint(span, segment.index), end = domTextPoint(span, segment.index + segment.segment.length);
          selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset); showSelection();
        }
      }}
      onBlur={event => { if (!menuOpen.current && !(event.relatedTarget instanceof Element && event.relatedTarget.closest('[role="menu"]'))) setCaret(null); }}
      onContextMenu={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPoint({ x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom });
        const id = (event.target as HTMLElement).closest<HTMLElement>('[data-text-object]')?.dataset.textObject;
        let next = readSelection();
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        let copied = range?.toString() ?? '';
        let local = Boolean(range && layer.current?.contains(range.startContainer) && layer.current.contains(range.endContainer));
        if (!next.length || (id && !next.some(target => target.objectId === id))) {
          const object = byId.get(id ?? '');
          if (object?.textBlock) {
            const value = object.textBlock.runs.map(run => run.text).join('');
            const source = sourceById.get(object.id)!;
            next = [{ objectId: object.id, blockId: object.textBlock.id, range: [0, sourceTextOffset(source, value.length)], logicalRange: [0, value.length], text: value, rects: [object.bounds] }];
          } else next = [];
          copied = next.map(target => target.text).join('\n'); local = true;
        }
        contextText.current = copied; setLocalSelection(local);
        contextTargets.current = next; setTargets(next);
      }}
      onCopy={event => {
        event.preventDefault();
        if (shown.info.permissions.copy) {
          const selection = window.getSelection();
          event.clipboardData.setData('text/plain', selection?.rangeCount ? selection.getRangeAt(0).toString() : '');
        }
      }}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && layer.current) {
          event.preventDefault(); window.getSelection()?.selectAllChildren(layer.current); showSelection(); return;
        }
        if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') affinity.current = null;
        if (event.key === 'Enter' && editTarget && canEdit && !disabled) { event.preventDefault(); onEdit(shown, editTarget.objectId, editTarget.range, true); }
      }}>
      {objects.map((item, objectIndex) => {
        const block = item.textBlock!, clusters = textClusters(block), value = block.runs.map(run => run.text).join('');
        const previous = objects[objectIndex - 1];
        const preceding = previous ? textClusters(previous.textBlock!).at(-1)?.bounds ?? previous.bounds : item.bounds;
        const first = clusters[0]?.bounds ?? item.bounds;
        const prefix = prefixes.get(item.id) ?? '';
        const sameLine = Math.abs(preceding.y - first.y) < Math.max(preceding.height, first.height) * 0.3;
        let offset = 0;
        return <Fragment key={item.id}>
          {prefix && <span className="pdf-text-separator" style={{
            left: Math.min(shown.page.widthPt - 1, preceding.x + preceding.width) * zoom, top: preceding.y * zoom,
            width: Math.max(1, sameLine ? first.x - preceding.x - preceding.width : (block.runs[0]?.style.fontSize ?? 12) / 3) * zoom,
            height: Math.max(2, preceding.height) * zoom, fontSize: prefix.includes('\n') ? 1 : (block.runs[0]?.style.fontSize ?? 12) * zoom,
          }}>{prefix}</span>}
          {!clusters.length ? <span data-text-object={item.id} className="pdf-text-fallback" style={{
            left: item.bounds.x * zoom, top: item.bounds.y * zoom, width: item.bounds.width * zoom,
            fontSize: (block.runs[0]?.style.fontSize ?? 12) * zoom, lineHeight: block.runs[0]?.style.lineHeight ?? 1.2,
            letterSpacing: (block.runs[0]?.style.characterSpacing ?? 0) * zoom }}>{value}</span>
          : <span data-text-object={item.id} className="pdf-text-object">{clusters.map((cluster, index) => {
            const gap = value.slice(offset, cluster.range[0]); offset = cluster.range[1];
            return <span key={index} className="pdf-character" style={{ left: cluster.bounds.x * zoom, top: cluster.bounds.y * zoom,
              width: cluster.bounds.width * zoom, height: cluster.bounds.height * zoom, fontSize: cluster.bounds.height * zoom }}>
              {gap}{cluster.text}{index === clusters.length - 1 ? value.slice(offset) : ''}
            </span>;
          })}</span>}
        </Fragment>;
      })}
      <div className="pdf-selection-paint" aria-hidden="true">{mergeTextRects(targets.flatMap(target => target.rects), shown.page.rotation % 180 !== 0).map((rect, index) =>
        <i key={index} style={{ left: rect.x * zoom, top: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom }} />)}</div>
      {caret && <i className="reading-caret" aria-hidden="true" style={{ left: caret.x * zoom, top: caret.y * zoom,
        width: Math.max(1.5, caret.width * zoom), height: Math.max(1.5, caret.height * zoom) }} />}
    </ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Positioner><ContextMenu.Popup className="ui-menu">
      {targets.length > 0 && <>
        <ContextMenu.Item className="ui-menu-item" disabled={!text || disabled || !shown.info.permissions.copy} onClick={() => void copy()}>{t('Copy text')}<kbd>Ctrl/Cmd C</kbd></ContextMenu.Item>
        {editTarget && <ContextMenu.Item className="ui-menu-item" disabled={!canEdit || disabled} onClick={() => onEdit(shown, editTarget.objectId, editTarget.range, true)}>{t(text ? 'Edit selected text' : 'Insert text at cursor')}</ContextMenu.Item>}
        <ContextMenu.Item className="ui-menu-item" disabled={!text || disabled || !localSelection || !shown.info.permissions.annotate || !shown.info.capabilities.includes('annotation.add')}
          onClick={() => void onAnnotate(shown, contextTargets.current, 'highlight')}>{t('Highlight selection')}</ContextMenu.Item>
        <ContextMenu.Item className="ui-menu-item" disabled={!text || disabled || !localSelection || !canEdit || !shown.info.capabilities.includes('text.style')}
          onClick={() => void onAnnotate(shown, contextTargets.current, 'underline')}>{t('Underline text')}</ContextMenu.Item>
        <ContextMenu.Separator className="ui-menu-separator" />
      </>}
      <ContextMenu.Item className="ui-menu-item" disabled={disabled || !shown.info.permissions.modify || !shown.info.capabilities.includes('text.insert')} onClick={() => onInsert(shown, point)}>{t('Add text here')}</ContextMenu.Item>
    </ContextMenu.Popup></ContextMenu.Positioner></ContextMenu.Portal>
  </ContextMenu.Root>;
}
