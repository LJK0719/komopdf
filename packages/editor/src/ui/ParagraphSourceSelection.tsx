import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { SKIP_SCROLL_INTO_VIEW_TAG } from 'lexical';
import { caretAt, clusterCaret, hitText, selectionRects, type TextCluster, type TextHit } from './text-geometry.js';
import { sourceLineRange } from './inline-text-geometry.js';

export type InputSelection = { anchor: number; focus: number };
export type SourceSelectionGeometry = { clusters: TextCluster[]; host: HTMLElement; zoom: number };
type Props = {
  geometry: SourceSelectionGeometry; enabled: boolean; text: string; initialHit?: TextHit | undefined;
  readSelection(): InputSelection | null;
  select(selection: InputSelection): void;
};

export function ParagraphSourceSelection(props: Props) {
  const [editor] = useLexicalComposerContext();
  const latest = useRef(props); latest.current = props;
  const [selection, setSelection] = useState<InputSelection | null>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const affinity = useRef<TextHit | null>(props.initialHit ?? null);
  const enabled = props.enabled && !composing;

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root || !props.enabled) return;
    let anchor: number | null = null;
    const show = () => {
      setFocused(root.contains(document.activeElement));
      const next = latest.current.readSelection();
      setSelection(previous => previous?.anchor === next?.anchor && previous?.focus === next?.focus ? previous : next);
    };
    const choose = (next: InputSelection) => {
      editor.update(() => latest.current.select(next), { tag: SKIP_SCROLL_INTO_VIEW_TAG, discrete: true });
    };
    const hit = (event: MouseEvent) => {
      const { host, zoom, clusters } = latest.current.geometry;
      const box = host.getBoundingClientRect();
      return hitText(clusters, (event.clientX - box.left) / zoom, (event.clientY - box.top) / zoom);
    };
    const down = (event: PointerEvent) => {
      if (!latest.current.enabled || event.button !== 0 || editor.isComposing()) return;
      const point = hit(event);
      if (!point) return;
      if (!(event.target instanceof Node && root.contains(event.target))) {
        const { host, zoom } = latest.current.geometry;
        const box = host.getBoundingClientRect();
        const x = (event.clientX - box.left) / zoom, y = (event.clientY - box.top) / zoom;
        const b = point.bounds;
        if (Math.max(b.x - x, 0, x - b.x - b.width, b.y - y, y - b.y - b.height) > 3 / zoom) return;
      }
      event.preventDefault(); event.stopPropagation();
      affinity.current = point;
      anchor = event.shiftKey ? latest.current.readSelection()?.anchor ?? point.offset : point.offset;
      root.focus({ preventScroll: true });
      choose({ anchor, focus: point.offset });
      root.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!latest.current.enabled || anchor === null) return;
      const point = hit(event);
      if (point) { event.preventDefault(); affinity.current = point; choose({ anchor, focus: point.offset }); }
    };
    const up = (event: PointerEvent) => {
      anchor = null;
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    };
    const doubleClick = (event: MouseEvent) => {
      if (!latest.current.enabled || editor.isComposing()) return;
      const point = hit(event);
      if (!point) return;
      const word = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(latest.current.text)]
        .find(part => part.index <= point.offset && part.index + part.segment.length > point.offset);
      if (word) { event.preventDefault(); affinity.current = null; choose({ anchor: word.index, focus: word.index + word.segment.length }); }
    };
    const key = (event: KeyboardEvent) => {
      if (!latest.current.enabled || event.isComposing || editor.isComposing()) return;
      const current = latest.current.readSelection();
      if (!current) return;
      const { clusters } = latest.current.geometry;
      const caret = affinity.current?.offset === current.focus ? affinity.current : caretAt(clusters, current.focus);
      let offset: number | undefined;
      let targetCaret: TextHit | null = null;
      const control = event.ctrlKey || event.metaKey;
      if (event.key === 'Home' || event.key === 'End') {
        const line = sourceLineRange(clusters, current.focus, caret?.bounds);
        offset = control ? event.key === 'Home' ? 0 : latest.current.text.length : line?.[event.key === 'Home' ? 0 : 1];
        const last = event.key === 'End' ? clusters.find(cluster => cluster.range[1] === offset) : undefined;
        if (last) targetCaret = clusterCaret(last, true);
      } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !control && caret) {
        const y = caret.bounds.y + caret.bounds.height / 2;
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        const adjacent = clusters.filter(cluster => direction * (cluster.bounds.y + cluster.bounds.height / 2 - y) > caret.bounds.height * 0.5)
          .sort((a, b) => Math.abs(a.bounds.y + a.bounds.height / 2 - y) - Math.abs(b.bounds.y + b.bounds.height / 2 - y))[0];
        offset = adjacent ? hitText(clusters, caret.bounds.x, adjacent.bounds.y + adjacent.bounds.height / 2)?.offset : current.focus;
      } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !control) {
        const right = event.key === 'ArrowRight';
        if (!event.shiftKey && current.anchor !== current.focus) offset = right ? Math.max(current.anchor, current.focus) : Math.min(current.anchor, current.focus);
        else {
          const boundaries = [...new Set(clusters.flatMap(cluster => cluster.range))].sort((a, b) => a - b);
          offset = right ? boundaries.find(value => value > current.focus) ?? latest.current.text.length
            : boundaries.findLast(value => value < current.focus) ?? 0;
        }
      }
      if (offset === undefined) { if (event.key.startsWith('Arrow')) affinity.current = null; return; }
      event.preventDefault(); event.stopPropagation(); affinity.current = targetCaret;
      choose({ anchor: event.shiftKey ? current.anchor : offset, focus: offset });
    };
    const startComposition = () => { anchor = null; root.removeAttribute('data-source-selection'); setComposing(true); };
    const endComposition = () => setComposing(false);
    const update = editor.registerUpdateListener(show);
    props.geometry.host.addEventListener('pointerdown', down, true);
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('dblclick', doubleClick);
    root.addEventListener('keydown', key, true);
    root.addEventListener('focus', show);
    root.addEventListener('blur', show);
    root.addEventListener('compositionstart', startComposition);
    root.addEventListener('compositionend', endComposition);
    show();
    return () => {
      update();
      props.geometry.host.removeEventListener('pointerdown', down, true);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', up);
      root.removeEventListener('dblclick', doubleClick);
      root.removeEventListener('keydown', key, true);
      root.removeEventListener('focus', show);
      root.removeEventListener('blur', show);
      root.removeEventListener('compositionstart', startComposition);
      root.removeEventListener('compositionend', endComposition);
    };
  }, [editor, props.enabled, props.geometry]);
  useLayoutEffect(() => {
    const root = editor.getRootElement();
    if (enabled) root?.setAttribute('data-source-selection', 'true');
    else root?.removeAttribute('data-source-selection');
    return () => { root?.removeAttribute('data-source-selection'); };
  }, [editor, enabled]);

  if (!enabled || !focused || !selection) return null;
  const { clusters, zoom, host } = props.geometry;
  const collapsed = selection.anchor === selection.focus;
  const caret = collapsed ? (affinity.current?.offset === selection.focus ? affinity.current : caretAt(clusters, selection.focus))?.bounds : null;
  const rects = collapsed ? [] : selectionRects(clusters, [Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)]);
  return createPortal(<div className="pdf-selection-paint inline-source-selection" aria-hidden="true">
    {rects.map((rect, index) => <i key={index} style={{ left: rect.x * zoom, top: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom }} />)}
    {caret && <span key={`${selection.focus}:${caret.x}:${caret.y}`} className="inline-source-caret" data-offset={selection.focus} style={{ left: caret.x * zoom, top: caret.y * zoom,
      width: Math.max(1.5, caret.width * zoom), height: Math.max(1.5, caret.height * zoom) }} />}
  </div>, host);
}
