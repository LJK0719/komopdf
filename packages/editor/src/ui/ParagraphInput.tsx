import { useEffect, useLayoutEffect, useImperativeHandle, useRef, type RefObject } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $patchStyleText } from '@lexical/selection';
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isElementNode, $isLineBreakNode,
  $isRangeSelection, $isTextNode, $createRangeSelection, $setSelection, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND,
  COMMAND_PRIORITY_HIGH, FORMAT_TEXT_COMMAND, SKIP_SCROLL_INTO_VIEW_TAG, type LexicalNode, type TextNode } from 'lexical';
import type { StyledTextRun, TextRange, TextStyle } from '@pdf-editor/contracts';
import { type EditorFont, loadFontPreview } from './font-resources.js';
import { getFontWeight, resolveFormattingFont, sourceFontFamily } from './font-face-matcher.js';

export type ParagraphInputHandle = { format(style: TextStyle, range?: TextRange): void; focus(range?: TextRange): void; isComposing(): boolean };
type Props = {
  runs: StyledTextRun[]; fonts: EditorFont[]; zoom: number; disabled: boolean; initialRange?: TextRange | null | undefined;
  handle: RefObject<ParagraphInputHandle | null>; label: string; style: TextStyle;
  onChange(text: string, runs: StyledTextRun[], dirty: boolean): void; onSelect(range: TextRange): void; onFinish(): void; onCancel(): void;
  onFormat(format: 'bold' | 'italic' | 'underline'): void;
};

function previewFace(style: TextStyle, fonts: EditorFont[], text: string): EditorFont | undefined {
  const exact = fonts.find(font => font.id === style.fontId);
  if (exact || !fonts.length || !style.fontId?.startsWith('pdf:')) return exact;
  const name = style.fontId.slice(4), family = sourceFontFamily(name);
  return resolveFormattingFont(fonts, { family, text, weight: style.weight ?? getFontWeight({ id: name, family, style: name, format: 'ttf' }),
    italic: style.italic ?? /italic|oblique/i.test(name) });
}

// Text-node styles are PDF point values. View zoom never enters serialization.
function css(style: TextStyle, fonts: EditorFont[], text = ''): Record<string, string> {
  const result: Record<string, string> = {};
  if (style.fontId) {
    const font = previewFace(style, fonts, text);
    result['--pdf-font-id'] = JSON.stringify(style.fontId); result['font-family'] = JSON.stringify(font?.family ?? 'sans-serif');
    if (font) { result['font-weight'] = String(font.weight ?? 400); result['font-style'] = font.italic ? 'italic' : 'normal'; }
  }
  if (style.fontSize !== undefined) result['font-size'] = `${style.fontSize}px`;
  if (style.characterSpacing !== undefined) result['letter-spacing'] = `${style.characterSpacing}px`;
  if (style.color) result.color = `rgb(${style.color.map(value => Math.round(value * 255)).join(',')})`;
  if (style.weight !== undefined) result['font-weight'] = String(style.weight);
  if (style.italic !== undefined) result['font-style'] = style.italic ? 'italic' : 'normal';
  if (style.underline !== undefined) result['text-decoration'] = style.underline ? 'underline' : 'none';
  return result;
}
const cssString = (style: TextStyle, fonts: EditorFont[], text: string) => Object.entries(css(style, fonts, text)).map(([name, value]) => `${name}:${value}`).join(';');

function sourceStyle(node: TextNode, base: TextStyle): TextStyle {
  const declaration = document.createElement('span').style;
  declaration.cssText = node.getStyle();
  const result = { ...base };
  const font = declaration.getPropertyValue('--pdf-font-id').trim();
  if (font) { try { result.fontId = JSON.parse(font) as string; } catch { /* External paste has no PDF font identity. */ } }
  if (declaration.fontSize) result.fontSize = parseFloat(declaration.fontSize);
  if (declaration.letterSpacing && declaration.letterSpacing !== 'normal') result.characterSpacing = parseFloat(declaration.letterSpacing);
  const color = declaration.color.match(/[\d.]+/g)?.map(Number);
  if (color?.length === 3) result.color = color.map(value => value / 255) as [number, number, number];
  result.weight = declaration.fontWeight ? Number(declaration.fontWeight) || 400 : node.hasFormat('bold') ? 700 : base.weight ?? 400;
  result.italic = declaration.fontStyle ? declaration.fontStyle === 'italic' : node.hasFormat('italic') || Boolean(base.italic);
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

function selectRange(range: TextRange, base: TextStyle, zoom: number) {
  const { positions } = readDraft(base, zoom);
  const nodes = [...positions.values()].filter(value => $isTextNode(value.node));
  if (!nodes.length) { $getRoot().selectEnd(); return; }
  const point = (offset: number) => nodes.find(item => item.start + item.length >= offset) ?? nodes.at(-1)!;
  const start = point(range[0]), end = point(range[1]), selection = $createRangeSelection();
  selection.anchor.set(start.node.getKey(), Math.min(start.length, Math.max(0, range[0] - start.start)), 'text');
  selection.focus.set(end.node.getKey(), Math.min(end.length, Math.max(0, range[1] - end.start)), 'text');
  $setSelection(selection);
}

function Controls(props: Props) {
  const [editor] = useLexicalComposerContext();
  const latest = useRef(props); latest.current = props;
  const lastContent = useRef(''), originalContent = useRef('');
  useLayoutEffect(() => { editor.getEditorState().read(() => { originalContent.current = lastContent.current = JSON.stringify(readDraft(props.style, props.zoom).runs); }); }, [editor]);
  useImperativeHandle(props.handle, () => ({
    format(style, range) {
      editor.update(() => {
        if (range) selectRange(range, latest.current.style, latest.current.zoom);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) $patchStyleText(selection, css(style, latest.current.fonts));
      });
      const font = style.fontId && latest.current.fonts.find(face => face.id === style.fontId);
      if (font) void loadFontPreview(font).then(family => {
        if (!editor.getRootElement()) return;
        editor.update(() => {
          for (const node of $getRoot().getAllTextNodes())
            if (sourceStyle(node, latest.current.style).fontId === font.id) node.setStyle(`${node.getStyle()};font-family:${JSON.stringify(family)}`);
        }, { tag: 'font-preview' });
      }).catch(() => undefined);
      editor.focus();
    },
    focus(range) { editor.update(() => { if (range) selectRange(range, latest.current.style, latest.current.zoom); else $getRoot().selectEnd(); }); editor.focus(); },
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
  useEffect(() => {
    editor.update(() => selectRange(props.initialRange ?? [0, 0], props.style, props.zoom), { tag: SKIP_SCROLL_INTO_VIEW_TAG, discrete: true });
    editor.getRootElement()?.focus({ preventScroll: true });
  }, [editor]);
  const fontKey = props.fonts.map(font => font.id).join('\0');
  useEffect(() => {
    const faces = new Map(props.runs.map(run => previewFace(run.style, props.fonts, run.text)).filter((font): font is EditorFont => Boolean(font)).map(font => [font.id, font]));
    let active = true;
    void Promise.all([...faces.values()].map(async font => [font.id, await loadFontPreview(font)] as const))
      .then(families => { if (active) editor.update(() => {
        for (const node of $getRoot().getAllTextNodes()) {
          const style = sourceStyle(node, props.style);
          const face = previewFace(style, props.fonts, node.getTextContent());
          const family = families.find(([id]) => id === face?.id)?.[1];
          if (family) node.setStyle(`${node.getStyle()};font-family:${JSON.stringify(family)}`);
        }
      }, { tag: 'font-preview' }); }).catch(() => undefined);
    return () => { active = false; };
  }, [editor, fontKey]);
  return <OnChangePlugin ignoreSelectionChange={false} onChange={(state, _editor, tags) => state.read(() => {
    const current = latest.current, draft = readDraft(current.style, current.zoom);
    const content = JSON.stringify(draft.runs);
    if (!tags.has('font-preview') && content !== lastContent.current) current.onChange(draft.text, draft.runs, content !== originalContent.current);
    lastContent.current = content;
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      const offset = (point: typeof selection.anchor) => {
        const value = draft.positions.get(point.key);
        return value ? value.start + ($isTextNode(value.node) ? point.offset : point.offset ? value.length : 0) : draft.text.length;
      };
      const a = offset(selection.anchor), b = offset(selection.focus);
      current.onSelect([Math.min(a, b), Math.max(a, b)]);
    }
  })} />;
}

export function ParagraphInput(props: Props) {
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
        maxHeight: `min(calc(55vh / ${props.zoom}), ${640 / props.zoom}px)`,
        lineHeight: props.style.lineSpacing ? `${props.style.lineSpacing}px` : props.style.lineHeight ?? 1.2,
        textAlign: props.style.alignment ?? 'left', textIndent: props.style.firstLineIndent ?? 0,
        ['--paragraph-space-before' as string]: `${props.style.spaceBefore ?? 0}px`,
        ['--paragraph-space-after' as string]: `${props.style.spaceAfter ?? 0}px` }}
      onBlur={event => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.text-properties, .direct-text-editor, .paragraph-settings'))) props.onFinish(); }} />}
      placeholder={null} />
    <HistoryPlugin /><Controls {...props} />
  </LexicalComposer>;
}
