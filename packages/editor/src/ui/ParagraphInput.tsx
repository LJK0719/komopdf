import { useEffect, useLayoutEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { ParagraphSourceSelection, type InputSelection, type SourceSelectionGeometry } from './ParagraphSourceSelection.js';
import type { TextHit } from './text-geometry.js';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $patchStyleText } from '@lexical/selection';
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isElementNode, $isLineBreakNode,
  $isRangeSelection, $isTextNode, $createRangeSelection, $setSelection, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND,
  COMMAND_PRIORITY_HIGH, FORMAT_TEXT_COMMAND, SKIP_SCROLL_INTO_VIEW_TAG, HISTORY_PUSH_TAG, UNDO_COMMAND, REDO_COMMAND, type LexicalNode, type TextNode } from 'lexical';
import type { StyledTextRun, TextRange, TextStyle } from '@pdf-editor/contracts';
import { type EditorFont, loadFontPreview } from './font-resources.js';
import { getFontItalic, getFontWeight, resolveSourceFont, sourceFontFamily, sourceFontTraits } from './font-face-matcher.js';

export type ParagraphInputHandle = { format(style: TextStyle, range?: TextRange): void; focus(range?: TextRange): void; isComposing(): boolean;
  replace(range: TextRange, text: string): void; undo(): void; redo(): void };
type Props = {
  runs: StyledTextRun[]; fonts: EditorFont[]; zoom: number; disabled: boolean; initialRange?: TextRange | null | undefined;
  handle: RefObject<ParagraphInputHandle | null>; label: string; style: TextStyle;
  baseline?: number | undefined; frameHeight?: number | undefined; fixedFrame?: boolean | undefined;
  pristine?: boolean | undefined; sourceGeometry?: SourceSelectionGeometry | undefined; initialHit?: TextHit | undefined;
  onChange(text: string, runs: StyledTextRun[], dirty: boolean): void; onSelect(range: TextRange, insertionStyle?: TextStyle): void; onFinish(): void; onCancel(): void;
  onFormat(format: 'bold' | 'italic' | 'underline'): void;
};

function previewFace(style: TextStyle, fonts: EditorFont[], _text: string): EditorFont | undefined {
  return resolveSourceFont(fonts, style);
}

// Text-node styles are PDF point values. View zoom never enters serialization.
function css(style: TextStyle, fonts: EditorFont[], text = ''): Record<string, string> {
  const result: Record<string, string> = {};
  if (style.fontId) {
    const font = previewFace(style, fonts, text);
    const family = font?.family ?? (style.fontId.startsWith('pdf:') ? sourceFontFamily(style.fontId.slice(4)) : 'sans-serif');
    result['--pdf-font-id'] = JSON.stringify(style.fontId); result['font-family'] = JSON.stringify(family);
    const traits = font && !style.fontId.startsWith('pdf:')
      ? { weight: getFontWeight(font), italic: getFontItalic(font) } : sourceFontTraits(style);
    result['font-weight'] = String(traits.weight); result['font-style'] = traits.italic ? 'italic' : 'normal';
    // Keep source metadata separate from the face used to display the draft.
    result['--pdf-weight'] = style.weight === undefined ? 'auto' : String(style.weight);
    result['--pdf-italic'] = style.italic === undefined ? 'auto' : String(style.italic);
  }
  if (style.fontSize !== undefined) result['font-size'] = `${style.fontSize}px`;
  if (style.characterSpacing !== undefined) result['letter-spacing'] = `${style.characterSpacing}px`;
  if (style.color) result.color = `rgb(${style.color.map(value => Math.round(value * 255)).join(',')})`;
  if (!style.fontId && style.weight !== undefined) result['--pdf-weight'] = result['font-weight'] = String(style.weight);
  if (!style.fontId && style.italic !== undefined) {
    result['--pdf-italic'] = String(style.italic); result['font-style'] = style.italic ? 'italic' : 'normal';
  }
  if (style.underline !== undefined) result['text-decoration'] = style.underline ? 'underline' : 'none';
  return result;
}
const cssString = (style: TextStyle, fonts: EditorFont[], text: string) => Object.entries(css(style, fonts, text)).map(([name, value]) => `${name}:${value}`).join(';');

function sourceStyle(node: TextNode, base: TextStyle): TextStyle {
  return sourceCssStyle(node.getStyle(), base, node);
}

function sourceCssStyle(cssText: string, base: TextStyle, node: Pick<TextNode, 'hasFormat'>): TextStyle {
  const declaration = document.createElement('span').style;
  declaration.cssText = cssText;
  const result = { ...base };
  const font = declaration.getPropertyValue('--pdf-font-id').trim();
  if (font) { try { result.fontId = JSON.parse(font) as string; } catch { /* External paste has no PDF font identity. */ } }
  if (declaration.fontSize) result.fontSize = parseFloat(declaration.fontSize);
  if (declaration.letterSpacing && declaration.letterSpacing !== 'normal') result.characterSpacing = parseFloat(declaration.letterSpacing);
  const color = declaration.color.match(/[\d.]+/g)?.map(Number);
  if (color?.length === 3) result.color = color.map(value => value / 255) as [number, number, number];
  const weight = declaration.getPropertyValue('--pdf-weight').trim();
  const italic = declaration.getPropertyValue('--pdf-italic').trim();
  if (weight === 'auto') delete result.weight;
  else result.weight = weight ? Number(weight) : declaration.fontWeight ? Number(declaration.fontWeight) || 400 : node.hasFormat('bold') ? 700 : base.weight ?? 400;
  if (italic === 'auto') delete result.italic;
  else result.italic = italic ? italic === 'true' : declaration.fontStyle ? declaration.fontStyle === 'italic' : node.hasFormat('italic') || Boolean(base.italic);
  result.underline = declaration.textDecoration ? declaration.textDecoration.includes('underline') : node.hasFormat('underline') || Boolean(base.underline);
  return result;
}

function readDraft(base: TextStyle, zoom: number) {
  const runs: StyledTextRun[] = [], positions = new Map<string, { start: number; length: number; node: LexicalNode }>();
  let text = '';
  const append = (value: string, style: TextStyle) => {
    if (!value) return;
    text += value;
    const last = runs.at(-1);
    if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.text += value;
    else runs.push({ text: value, style, sourceObjectIds: [] });
  };
  const visit = (node: LexicalNode) => {
    const start = text.length;
    if ($isTextNode(node)) append(node.getTextContent(), sourceStyle(node, base));
    else if ($isLineBreakNode(node)) append('\n', runs.at(-1)?.style ?? base);
    else if ($isElementNode(node)) node.getChildren().forEach(visit);
    positions.set(node.getKey(), { start, length: text.length - start, node });
  };
  $getRoot().getChildren().forEach((node, index) => { if (index) append('\n', runs.at(-1)?.style ?? base); visit(node); });
  return { text, runs, positions };
}

function selectRange(range: TextRange, positions: ReturnType<typeof readDraft>['positions']) {
  const nodes = [...positions.values()].filter(value => $isTextNode(value.node));
  if (!nodes.length) { $getRoot().selectEnd(); return; }
  const point = (offset: number) => nodes.find(item => item.start + item.length > offset) ?? nodes.at(-1)!;
  const start = point(range[0]), end = point(range[1]), selection = $createRangeSelection();
  selection.anchor.set(start.node.getKey(), Math.min(start.length, Math.max(0, range[0] - start.start)), 'text');
  selection.focus.set(end.node.getKey(), Math.min(end.length, Math.max(0, range[1] - end.start)), 'text');
  const focus = end.node as TextNode;
  selection.style = focus.getStyle();
  selection.format = focus.getFormat();
  $setSelection(selection);
}

function Controls(props: Props) {
  const [editor] = useLexicalComposerContext();
  const latest = useRef(props); latest.current = props;
  const lastContent = useRef(''), originalContent = useRef('');
  const draft = useRef<ReturnType<typeof readDraft> | null>(null);
  const selected = useRef<InputSelection | null>(null);
  const selectedStyle = useRef('');
  useLayoutEffect(() => { editor.getEditorState().read(() => {
    draft.current = readDraft(props.style, props.zoom);
    originalContent.current = lastContent.current = JSON.stringify(draft.current.runs);
  }); }, [editor]);
  const selectionOffsets = (): InputSelection | null => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !draft.current) return null;
    const offset = (point: typeof selection.anchor) => {
      const value = draft.current!.positions.get(point.key);
      if (!value) return draft.current!.text.length;
      if ($isTextNode(value.node)) return value.start + point.offset;
      const child = $isElementNode(value.node) ? value.node.getChildren()[point.offset] : null;
      return child ? draft.current!.positions.get(child.getKey())?.start ?? value.start : value.start + value.length;
    };
    return { anchor: offset(selection.anchor), focus: offset(selection.focus) };
  };
  const updatePreviewFamilies = (families: ReadonlyMap<string, string>) => {
    editor.update(() => {
      const updated = new Map<string, string>();
      for (const node of $getRoot().getAllTextNodes()) {
        const face = previewFace(sourceStyle(node, latest.current.style), latest.current.fonts, node.getTextContent());
        const family = face && families.get(face.id);
        if (!family) continue;
        const previous = node.getStyle(), declaration = document.createElement('span').style;
        declaration.cssText = previous; declaration.fontFamily = JSON.stringify(family);
        node.setStyle(declaration.cssText); updated.set(previous, declaration.cssText);
      }
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        const style = updated.get(selection.style);
        if (style !== undefined) selection.setStyle(style);
      }
    }, { tag: 'font-preview' });
  };
  useImperativeHandle(props.handle, () => ({
    format(style, range) {
      editor.update(() => {
        const current = selectionOffsets();
        if (range && (!current || current.anchor !== range[0] || current.focus !== range[1])) selectRange(range, draft.current!.positions);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const patch = css(style, latest.current.fonts);
          $patchStyleText(selection, patch);
          // A range format also sets the style used when typing after collapsing it.
          const insertion = document.createElement('span').style;
          insertion.cssText = selection.style;
          for (const [name, value] of Object.entries(patch)) insertion.setProperty(name, value);
          selection.setStyle(insertion.cssText);
        }
      });
      const font = style.fontId && latest.current.fonts.find(face => face.id === style.fontId);
      if (font) void loadFontPreview(font).then(family => {
        if (!editor.getRootElement()) return;
        updatePreviewFamilies(new Map([[font.id, family]]));
      }).catch(() => undefined);
      editor.focus();
    },
    focus(range) { editor.update(() => { if (range) selectRange(range, draft.current!.positions); else $getRoot().selectEnd(); }); editor.focus(); },
    replace(range, text) {
      if (editor.isComposing()) return;
      editor.update(() => {
        selectRange(range, readDraft(latest.current.style, latest.current.zoom).positions);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(text);
      }, { tag: HISTORY_PUSH_TAG, discrete: true });
      editor.focus();
    },
    undo: () => { editor.dispatchCommand(UNDO_COMMAND, undefined); },
    redo: () => { editor.dispatchCommand(REDO_COMMAND, undefined); },
    isComposing: () => editor.isComposing(),
  }), [editor]);
  useEffect(() => {
    const enter = editor.registerCommand(KEY_ENTER_COMMAND, event => {
      if (!event || editor.isComposing() || !(event.ctrlKey || event.metaKey)) return false;
      event.preventDefault(); latest.current.onFinish(); return true;
    }, COMMAND_PRIORITY_HIGH);
    const escape = editor.registerCommand(KEY_ESCAPE_COMMAND, event => {
      if (editor.isComposing()) return false;
      event.preventDefault(); latest.current.onCancel(); return true;
    }, COMMAND_PRIORITY_HIGH);
    const format = editor.registerCommand(FORMAT_TEXT_COMMAND, value => {
      if (value !== 'bold' && value !== 'italic' && value !== 'underline') return false;
      latest.current.onFormat(value); return true;
    }, COMMAND_PRIORITY_HIGH);
    return () => { enter(); escape(); format(); };
  }, [editor]);
  useEffect(() => { editor.setEditable(!props.disabled); }, [editor, props.disabled]);
  const fontKey = props.fonts.map(font => font.id).join('\0');
  useEffect(() => {
    const faces = new Map(props.runs.map(run => previewFace(run.style, props.fonts, run.text)).filter((font): font is EditorFont => Boolean(font)).map(font => [font.id, font]));
    let active = true;
    void Promise.all([...faces.values()].map(async font => [font.id, await loadFontPreview(font)] as const))
      .then(families => { if (active) updatePreviewFamilies(new Map(families)); }).catch(() => undefined);
    return () => { active = false; };
  }, [editor, fontKey]);
  useEffect(() => editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => editorState.read(() => {
    const current = latest.current;
    if (dirtyElements.size || dirtyLeaves.size || !draft.current) {
      draft.current = readDraft(current.style, current.zoom);
      const content = JSON.stringify(draft.current.runs);
      if (!tags.has('font-preview') && content !== lastContent.current)
        current.onChange(draft.current.text, draft.current.runs, content !== originalContent.current);
      lastContent.current = content;
    }
    const next = selectionOffsets(), selection = $getSelection();
    const insertion = $isRangeSelection(selection) && selection.isCollapsed()
      ? sourceCssStyle(selection.style, current.style, selection) : undefined;
    const signature = JSON.stringify(insertion) ?? '';
    if (next && (next.anchor !== selected.current?.anchor || next.focus !== selected.current?.focus || signature !== selectedStyle.current)) {
      selected.current = next; selectedStyle.current = signature;
      current.onSelect([Math.min(next.anchor, next.focus), Math.max(next.anchor, next.focus)], insertion);
    }
  })), [editor]);
  useEffect(() => {
    editor.update(() => selectRange(props.initialRange ?? [0, 0], draft.current!.positions), { tag: SKIP_SCROLL_INTO_VIEW_TAG, discrete: true });
    editor.getRootElement()?.focus({ preventScroll: true });
  }, [editor]);
  return props.sourceGeometry && <ParagraphSourceSelection geometry={props.sourceGeometry} enabled={Boolean(props.pristine)}
    text={props.runs.map(run => run.text).join('')} initialHit={props.initialHit}
    readSelection={() => editor.getEditorState().read(selectionOffsets)}
    select={selection => selectRange([selection.anchor, selection.focus], draft.current!.positions)} />;
}

function baselineOffset(props: Props, previewFamily?: string): number {
  if (props.baseline === undefined) return 0;
  const run = props.runs.find(item => item.text.length);
  if (!run) return 0;
  const style = { ...props.style, ...run.style };
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return 0;
  const family = previewFamily ?? previewFace(style, props.fonts, run.text)?.family ?? sourceFontFamily(style.fontId?.replace(/^pdf:/, '') ?? 'sans-serif');
  const size = style.fontSize ?? 12;
  const display = css(style, props.fonts, run.text);
  context.font = `${display['font-style'] ?? 'normal'} ${display['font-weight'] ?? 400} ${size}px ${JSON.stringify(family)}`;
  const metrics = context.measureText(run.text.split('\n')[0]!);
  const ascent = metrics.fontBoundingBoxAscent, descent = metrics.fontBoundingBoxDescent;
  const height = props.style.lineSpacing || size * (props.style.lineHeight ?? 1.2);
  return props.baseline - (ascent + (height - ascent - descent) / 2);
}

export function ParagraphInput(props: Props) {
  const first = props.runs.find(run => run.text.length);
  const face = first && previewFace({ ...props.style, ...first.style }, props.fonts, first.text);
  const [baselineFamily, setBaselineFamily] = useState<string | undefined>();
  useEffect(() => {
    let active = true;
    setBaselineFamily(undefined);
    if (face) void loadFontPreview(face).then(family => { if (active) setBaselineFamily(family); }).catch(() => undefined);
    return () => { active = false; };
  }, [face?.id]);
  const baseline = useMemo(() => baselineOffset(props, baselineFamily), [props.baseline, props.runs, props.fonts, props.style, baselineFamily]);
  const initial = useRef({ namespace: 'pdf-paragraph', onError: (error: Error) => { throw error; },
    editorState: () => {
      let paragraph = $createParagraphNode(); $getRoot().append(paragraph);
      for (const run of props.runs) {
        run.text.split('\n').forEach((part, index) => {
          if (index) { paragraph = $createParagraphNode(); $getRoot().append(paragraph); }
          if (part) paragraph.append($createTextNode(part).setStyle(cssString(run.style, props.fonts, run.text)));
        });
      }
    },
  });
  return <LexicalComposer initialConfig={initial.current}>
    <RichTextPlugin ErrorBoundary={LexicalErrorBoundary} contentEditable={<ContentEditable className="paragraph-input" aria-label={props.label}
      style={{ zoom: props.zoom, fontSize: props.style.fontSize ?? 12,
        minHeight: props.frameHeight,
        maxHeight: props.fixedFrame ? props.frameHeight : undefined,
        position: 'relative', top: baseline,
        lineHeight: props.style.lineSpacing ? `${props.style.lineSpacing}px` : props.style.lineHeight ?? 1.2,
        textAlign: props.style.alignment ?? 'left', textIndent: props.style.firstLineIndent ?? 0,
        ['--paragraph-space-before' as string]: `${props.style.spaceBefore ?? 0}px`,
        ['--paragraph-space-after' as string]: `${props.style.spaceAfter ?? 0}px` }}
      onBlur={event => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.text-properties, .direct-text-editor, .paragraph-settings, .ai-owned-focus'))) props.onFinish(); }} />}
      placeholder={null} />
    <HistoryPlugin /><Controls {...props} />
  </LexicalComposer>;
}
