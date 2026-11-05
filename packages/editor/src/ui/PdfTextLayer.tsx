import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { Rect, TextRange, TextAction } from '@pdf-editor/contracts';
import { Languages, MessageSquare } from 'lucide-react';
import { TextActionMenuItems } from './TextActionMenu.js';
import { textActionSelection, textActionTarget, type TextActionSelection } from './text-actions.js';
import type { LoadedDocument } from './display-document.js';
import { ObjectSelectionStartContext, resumePointerIntent, selectionPointer, type SelectionPointerStart } from './ObjectSelectionLayer.js';
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
  onTextAction?(selection: TextActionSelection, action: TextAction | 'ask'): void;
  aiSelection?: TextActionSelection | null;
  onRequestPage?(pageId: string): Promise<void>;
  onSelectionSettled?(): void;
  selectionEpoch?: number | undefined;
};
type DomPoint = { node: Node; offset: number };
const pageHitTests = new WeakMap<Element, (x: number, y: number) => DomPoint | null>();
const selectionReaders = new Map<Element, () => { document: LoadedDocument; targets: TextSelectionTarget[] }>();
const textLayerWaiters = new Map<string, Set<() => void>>();
function waitForTextLayer(key: string, resume: () => void): () => void {
  let waiters = textLayerWaiters.get(key);
  if (!waiters) { waiters = new Set(); textLayerWaiters.set(key, waiters); }
  waiters.add(resume);
  return () => { waiters.delete(resume); if (!waiters.size) textLayerWaiters.delete(key); };
}

function actionTargets(shown: LoadedDocument, targets: TextSelectionTarget[]) {
  const objects = new Map(readingRegions(shown.page).flatMap(region => region.objects).map(object => [object.id, object]));
  return targets.flatMap(target => {
    const object = objects.get(target.objectId);
    const value = object && textActionTarget(object, shown.info.pageOrder.indexOf(shown.page.id) + 1, target.range, target.text, target.rects);
    return value ? [value] : [];
  });
}
export function captureReadingSelection(documentId: string): TextActionSelection | null {
  const pages = [...selectionReaders.values()].map(read => read()).filter(item => item.document.info.id === documentId && item.targets.some(target => target.text.trim()));
  pages.sort((a, b) => a.document.info.pageOrder.indexOf(a.document.page.id) - b.document.info.pageOrder.indexOf(b.document.page.id));
  const first = pages[0]?.document;
  if (!first || !first.info.permissions.copy) return null;
  const targets = pages.flatMap(item => actionTargets(item.document, item.targets));
  return targets.length ? textActionSelection(first.info, first.name, targets, 'translate', pages.map(item => item.document.page)) : null;
}

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

export function PdfTextLayer({ document: shown, zoom, disabled, onEdit, onInsert, onAnnotate, onError, onTextAction, aiSelection, onRequestPage, onSelectionSettled, selectionEpoch }: Props) {
  const { t } = useI18n();
  const layer = useRef<HTMLDivElement>(null);
  const anchor = useRef<DomPoint | null>(null);
  const pointerPosition = useRef<SelectionPointerStart | null>(null);
  const pointerEnded = useRef(false);
  const pendingFocus = useRef<{ pageId: string; cancel(): void } | null>(null);
  useEffect(() => () => {
    if (pendingFocus.current) { pendingFocus.current.cancel(); pendingFocus.current = null; onSelectionSettled?.(); }
  }, []);
  const affinity = useRef<{ objectId: string; offset: number; bounds: Rect } | null>(null);
  const [targets, setTargets] = useState<TextSelectionTarget[]>([]);
  useLayoutEffect(() => {
    pendingFocus.current?.cancel(); pendingFocus.current = null;
    anchor.current = null; pointerPosition.current = null; pointerEnded.current = false;
    setTargets(previous => previous.length ? [] : previous); setCaret(null);
  }, [selectionEpoch]);
  const [localSelection, setLocalSelection] = useState(true);
  const contextText = useRef('');
  const textSpans = useRef(new Map<string, HTMLElement>());
  const displayedSelection = useRef<unknown[]>([]);
  const [caret, setCaret] = useState<Rect | null>(null);
  const [point, setPoint] = useState({ x: 36, y: 36 });
  const contextTargets = useRef<TextSelectionTarget[]>([]);
  const [menuSelection, setMenuSelection] = useState<{ targets: TextSelectionTarget[]; local: boolean; text: string }>({ targets: [], local: true, text: '' });
  const contextAction = useRef<TextActionSelection | null>(null);
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
  const editingTarget = (selection: TextSelectionTarget[], local: boolean) => {
    const first = selection[0];
    if (!first || !local) return null;
    const region = readingRegions(shown.page).find(region => region.sourceRanges[first.objectId]);
    if (!region) return null;
    const range = paragraphEditRange(region, selection);
    return range ? { objectId: first.objectId, range } : null;
  };
  const editTarget = editingTarget(targets, localSelection);
  const menuEditTarget = editingTarget(menuSelection.targets, menuSelection.local);

  const readSelection = (): TextSelectionTarget[] => {
    const selection = window.getSelection();
    if (!layer.current || !selection?.rangeCount) return [];
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(layer.current)) return [];
    const result: TextSelectionTarget[] = [];
    for (const span of textSpans.current.values()) {
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
        const scaleX = root.width / shown.page.widthPt, scaleY = root.height / shown.page.heightPt;
        rects = [...part.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({
          x: (rect.left - root.left) / scaleX, y: (rect.top - root.top) / scaleY, width: rect.width / scaleX, height: rect.height / scaleY,
        }));
      }
      const source = sourceById.get(object.id)!;
      result.push({ objectId: object.id, blockId: block.id, range: [sourceTextOffset(source, start), sourceTextOffset(source, end)], logicalRange: [start, end], text: value.slice(start, end), rects });
    }
    return result;
  };
  const readCurrent = useRef(() => ({ document: shown, targets: readSelection() }));
  readCurrent.current = () => ({ document: shown, targets: readSelection() });
  useLayoutEffect(() => {
    const root = layer.current;
    if (!root) return;
    selectionReaders.set(root, () => readCurrent.current());
    return () => { selectionReaders.delete(root); };
  }, []);
  const startAction = (action: TextAction | 'ask', fromMenu = false) => {
    const selection = fromMenu ? contextAction.current : captureReadingSelection(shown.info.id);
    if (!disabled && shown.info.permissions.copy && selection) onTextAction?.(selection, action);
  };
  const showSelection = () => {
    // Native menus/WebView focus can collapse the DOM range. Keep the captured
    // selection for both menu availability and the command until it closes.
    if (menuOpen.current) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const stamp = [range?.startContainer, range?.startOffset, range?.endContainer, range?.endOffset,
      selection?.focusNode, selection?.focusOffset, affinity.current];
    if (stamp.every((value, index) => value === displayedSelection.current[index])) return;
    displayedSelection.current = stamp;
    const next = readSelection();
    setTargets(previous => previous.length === 0 && next.length === 0 ? previous : next);
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
        setCaret(rect ? { x: (rect.left - root.left) * shown.page.widthPt / root.width,
          y: (rect.top - root.top) * shown.page.heightPt / root.height, width: 0, height: rect.height * shown.page.heightPt / root.height } : null);
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
    textSpans.current = new Map([...root.querySelectorAll<HTMLElement>('[data-text-object]')].map(span => [span.dataset.textObject!, span]));
    displayedSelection.current = [];
    if (pendingFocus.current) { pendingFocus.current.cancel(); pendingFocus.current = null; onSelectionSettled?.(); }
    setCaret(null); setTargets([]); anchor.current = null; affinity.current = null;
    pageHitTests.set(root, (clientX, clientY) => {
      const rect = root.getBoundingClientRect();
      const x = (clientX - rect.left) * shown.page.widthPt / rect.width, y = (clientY - rect.top) * shown.page.heightPt / rect.height;
      let best: { objectId: string; offset: number; bounds: Rect } | null = null, distance = Infinity;
      for (const object of objects) {
        const hit = hitText(textClusters(object.textBlock!), x, y);
        if (!hit) continue;
        const b = hit.bounds;
        const dx = Math.max(b.x - x, 0, x - b.x - b.width), dy = Math.max(b.y - y, 0, y - b.y - b.height);
        const score = dx * dx + dy * dy;
        if (score < distance) { best = { objectId: object.id, offset: hit.offset, bounds: hit.bounds }; distance = score; }
      }
      const span = best && textSpans.current.get(best.objectId);
      affinity.current = best;
      return best && span ? domTextPoint(span, best.offset) : null;
    });
    const key = `${shown.info.id}\0${shown.page.id}`;
    for (const resume of [...textLayerWaiters.get(key) ?? []]) resume();
    return () => { pageHitTests.delete(root); };
  }, [shown.page]);
  const copy = async () => {
    try { if (shown.info.permissions.copy) await navigator.clipboard.writeText(contextText.current || text); }
    catch { onError(t('Clipboard access was denied. Use Ctrl/Cmd+C to copy selected text.')); }
  };

  const textNodes = useMemo(() => objects.map((item, objectIndex) => {
    const block = item.textBlock!, clusters = textClusters(block), value = block.runs.map(run => run.text).join('');
    const previous = objects[objectIndex - 1];
    const preceding = previous ? textClusters(previous.textBlock!).at(-1)?.bounds ?? previous.bounds : item.bounds;
    const first = clusters[0]?.bounds ?? item.bounds;
    const prefix = prefixes.get(item.id) ?? '';
    const sameLine = Math.abs(preceding.y - first.y) < Math.max(preceding.height, first.height) * 0.3;
    let offset = 0;
    return <Fragment key={item.id}>
      {prefix && <span className="pdf-text-separator" style={{
        left: Math.min(shown.page.widthPt - 1, preceding.x + preceding.width), top: preceding.y,
        width: Math.max(1, sameLine ? first.x - preceding.x - preceding.width : (block.runs[0]?.style.fontSize ?? 12) / 3),
        height: Math.max(2, preceding.height), fontSize: prefix.includes('\n') ? 1 : (block.runs[0]?.style.fontSize ?? 12),
      }}>{prefix}</span>}
      {!clusters.length ? <span data-text-object={item.id} className="pdf-text-fallback" style={{
        left: item.bounds.x, top: item.bounds.y, width: item.bounds.width,
        fontSize: block.runs[0]?.style.fontSize ?? 12, lineHeight: block.runs[0]?.style.lineHeight ?? 1.2,
        letterSpacing: block.runs[0]?.style.characterSpacing ?? 0 }}>{value}</span>
      : <span data-text-object={item.id} className="pdf-text-object">{clusters.map((cluster, index) => {
        const gap = value.slice(offset, cluster.range[0]); offset = cluster.range[1];
        return <span key={index} className="pdf-character" style={{ left: cluster.bounds.x, top: cluster.bounds.y,
          width: cluster.bounds.width, height: cluster.bounds.height, fontSize: cluster.bounds.height }}>
          {gap}{cluster.text}{index === clusters.length - 1 ? value.slice(offset) : ''}
        </span>;
      })}</span>}
    </Fragment>;
  }), [objects, prefixes, shown.page.widthPt]);

  const applyPointerFocus = () => {
    const position = pointerPosition.current, start = anchor.current;
    if (!position || !start || !layer.current) return;
    const page = window.document.elementFromPoint(position.clientX, position.clientY)?.closest<HTMLElement>('[data-document-page]');
    const pageId = page?.dataset.documentPage;
    const root = page?.querySelector('.pdf-text-layer');
    const hit = root && pageHitTests.get(root)?.(position.clientX, position.clientY);
    if (hit) {
      pendingFocus.current?.cancel(); pendingFocus.current = null;
      window.getSelection()?.setBaseAndExtent(start.node, start.offset, hit.node, hit.offset);
      onSelectionSettled?.(); showSelection();
      if (pointerEnded.current) anchor.current = null;
      return;
    }
    if (!root && pageId && onRequestPage && page?.closest('.document-pages') === layer.current.closest('.document-pages')) {
      if (pendingFocus.current?.pageId === pageId) return;
      pendingFocus.current?.cancel();
      const cancel = waitForTextLayer(`${shown.info.id}\0${pageId}`, () => focusReader.current());
      pendingFocus.current = { pageId, cancel };
      void onRequestPage(pageId).catch(() => {
        if (pendingFocus.current?.pageId !== pageId) return;
        cancel(); pendingFocus.current = null; anchor.current = null; onSelectionSettled?.();
        onError(t('Unable to display this page.'));
      });
      return;
    }
    pendingFocus.current?.cancel(); pendingFocus.current = null;
    if (pointerEnded.current) { anchor.current = null; onSelectionSettled?.(); }
  };
  const focusReader = useRef(applyPointerFocus); focusReader.current = applyPointerFocus;
  const beginSelection = (event: SelectionPointerStart, capture: boolean): boolean => {
    if (event.button !== 0 || disabled || !layer.current) return false;
    const hit = pageHitTests.get(layer.current)?.(event.clientX, event.clientY);
    if (!hit) return false;
    pendingFocus.current?.cancel(); pendingFocus.current = null;
    layer.current.focus({ preventScroll: true });
    const selection = window.getSelection();
    const start = event.shiftKey && selection?.anchorNode ? { node: selection.anchorNode, offset: selection.anchorOffset } : hit;
    anchor.current = start; pointerPosition.current = selectionPointer(event); pointerEnded.current = false;
    selection?.setBaseAndExtent(start.node, start.offset, hit.node, hit.offset);
    if (capture) layer.current.setPointerCapture(event.pointerId);
    onSelectionSettled?.(); showSelection(); return true;
  };
  const moveSelection = (event: SelectionPointerStart) => {
    if (!anchor.current) return;
    pointerPosition.current = selectionPointer(event); applyPointerFocus();
  };
  const endSelection = (event: SelectionPointerStart) => {
    pointerEnded.current = true; moveSelection(event);
    if (!pendingFocus.current) anchor.current = null;
    if (layer.current?.hasPointerCapture(event.pointerId)) layer.current.releasePointerCapture(event.pointerId);
    showSelection();
  };
  const activationStart = useContext(ObjectSelectionStartContext);
  useLayoutEffect(() => {
    const intent = activationStart?.current;
    if (!intent || intent.tool !== 'select' || disabled) return;
    activationStart.current = null; activationStart.onConsumed();
    resumePointerIntent(intent, { start: beginSelection, move: moveSelection, end: endSelection });
  }, [activationStart, shown.page, disabled]);

  return <ContextMenu.Root onOpenChange={open => { menuOpen.current = open; }}>
    <ContextMenu.Trigger render={<div />} ref={layer} className="pdf-text-layer" aria-label={t('Select text')} tabIndex={0}
      onPointerDown={event => { if (beginSelection(event, true)) event.preventDefault(); }}
      onPointerMove={event => { if (event.buttons & 1) moveSelection(event); }}
      onPointerUp={endSelection}
      onPointerCancel={() => { pendingFocus.current?.cancel(); pendingFocus.current = null; anchor.current = null; setCaret(null); onSelectionSettled?.(); }}
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
      onContextMenuCapture={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPoint({ x: (event.clientX - rect.left) * shown.page.widthPt / rect.width,
          y: (event.clientY - rect.top) * shown.page.heightPt / rect.height });
        const id = (event.target as HTMLElement).closest<HTMLElement>('[data-text-object]')?.dataset.textObject;
        let next = readSelection();
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        let copied = range?.toString() ?? '';
        let local = Boolean(range && layer.current?.contains(range.startContainer) && layer.current.contains(range.endContainer));
        let wholeObject = false;
        if (!next.length || (id && !next.some(target => target.objectId === id))) {
          wholeObject = true;
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
        setMenuSelection({ targets: next, local, text: copied });
        contextAction.current = !wholeObject ? captureReadingSelection(shown.info.id) : null;
        if (!contextAction.current && next.some(target => target.text.trim())) contextAction.current = textActionSelection(shown.info, shown.name, actionTargets(shown, next), 'translate', [shown.page]);
      }}
      onCopy={event => {
        event.preventDefault();
        if (shown.info.permissions.copy) {
          const selection = window.getSelection();
          event.clipboardData.setData('text/plain', selection?.rangeCount ? selection.getRangeAt(0).toString() : '');
        }
      }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          const next = readSelection(); contextTargets.current = next; setTargets(next);
          const selection = window.getSelection();
          const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
          contextText.current = selection?.toString() ?? '';
          setMenuSelection({ targets: next, text: contextText.current, local: Boolean(range && layer.current?.contains(range.startContainer) && layer.current.contains(range.endContainer)) });
          contextAction.current = captureReadingSelection(shown.info.id);
          const first = next[0]?.rects[0]; if (first) setPoint({ x: first.x, y: first.y });
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && layer.current) {
          event.preventDefault(); window.getSelection()?.selectAllChildren(layer.current); showSelection(); return;
        }
        if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') affinity.current = null;
        if (event.key === 'Enter' && editTarget && canEdit && !disabled) { event.preventDefault(); onEdit(shown, editTarget.objectId, editTarget.range, true); }
      }}>
      <div className="pdf-text-content" style={{ position: 'absolute', left: 0, top: 0, width: shown.page.widthPt, height: shown.page.heightPt,
        transformOrigin: '0 0', transform: `scale(${zoom})` }}>{textNodes}</div>
      <div className="pdf-selection-paint" aria-hidden="true">{mergeTextRects((targets.length ? targets : aiSelection?.revision === shown.info.revision ? aiSelection.targets.filter(target => target.pageId === shown.page.id) : []).flatMap(target => target.rects), shown.page.rotation % 180 !== 0).map((rect, index) =>
        <i key={index} style={{ left: rect.x * zoom, top: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom }} />)}</div>
      {caret && <i className="reading-caret" aria-hidden="true" style={{ left: caret.x * zoom, top: caret.y * zoom,
        width: Math.max(1.5, caret.width * zoom), height: Math.max(1.5, caret.height * zoom) }} />}
    </ContextMenu.Trigger>
    {onTextAction && text.trim() && shown.info.permissions.copy && !disabled && !menuOpen.current && layer.current?.contains(window.getSelection()?.focusNode ?? null) && (() => {
      const rect = targets.at(-1)?.rects.at(-1);
      return rect && <div className="selection-ai-toolbar ai-owned-focus" role="toolbar" aria-label={t('Selected text tools')}
        style={{ left: Math.max(4, Math.min(rect.x * zoom, shown.page.widthPt * zoom - 150)), top: Math.min((rect.y + rect.height) * zoom + 6, shown.page.heightPt * zoom - 38) }}
        onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}>
        <button type="button" onClick={() => startAction('translate')}><Languages size={16} />{t('AI translate')}</button>
        <button type="button" onClick={() => startAction('ask')} aria-label={t('Ask KOMO about selection')} title={t('Ask KOMO about selection')}><MessageSquare size={16} /></button>
      </div>;
    })()}
    <ContextMenu.Portal><ContextMenu.Positioner className="ui-menu-positioner"><ContextMenu.Popup className="ui-menu ai-owned-focus">
      {menuSelection.targets.length > 0 && <>
        <ContextMenu.Item className="ui-menu-item" disabled={!menuSelection.text || disabled || !shown.info.permissions.copy} onClick={() => void copy()}>{t('Copy text')}<kbd>Ctrl/Cmd C</kbd></ContextMenu.Item>
        <ContextMenu.Item className="ui-menu-item" disabled={!menuSelection.text || disabled || !menuSelection.local || !shown.info.permissions.annotate || !shown.info.capabilities.includes('annotation.add')}
          onClick={() => void onAnnotate(shown, contextTargets.current, 'highlight')}>{t('Highlight selection')}</ContextMenu.Item>
        <ContextMenu.Item className="ui-menu-item" disabled={!menuSelection.text || disabled || !menuSelection.local || !canEdit || !shown.info.capabilities.includes('text.style')}
          onClick={() => void onAnnotate(shown, contextTargets.current, 'underline')}>{t('Underline text')}</ContextMenu.Item>
        {menuEditTarget && <><ContextMenu.Separator className="ui-menu-separator" />
          <ContextMenu.Item className="ui-menu-item" disabled={!canEdit || disabled} onClick={() => onEdit(shown, menuEditTarget.objectId, menuEditTarget.range, true)}>{t(menuSelection.text ? 'Edit selected text' : 'Insert text at cursor')}</ContextMenu.Item></>}
      </>}
      {!menuSelection.text && <ContextMenu.Item className="ui-menu-item" disabled={disabled || !shown.info.permissions.modify || !shown.info.capabilities.includes('text.insert')} onClick={() => onInsert(shown, point)}>{t('Add text here')}</ContextMenu.Item>}
      {onTextAction && menuSelection.text.trim() && <TextActionMenuItems disabled={disabled || !shown.info.permissions.copy} onAction={action => startAction(action, true)} />}
      {onTextAction && objects.length === 0 && <ContextMenu.Item className="ui-menu-item" disabled={disabled} onClick={() => onTextAction(textActionSelection(shown.info, shown.name, []), 'translate')}><Languages size={16} />{t('Translate scanned PDF')}</ContextMenu.Item>}
    </ContextMenu.Popup></ContextMenu.Positioner></ContextMenu.Portal>
  </ContextMenu.Root>;
}
