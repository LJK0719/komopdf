import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Italic, Underline, Check, X } from 'lucide-react';
import { CommandRegistry } from '@pdf-editor/commands';
import type { CommitResult, DocumentInfo, EngineAdapter, PageModel, RenderResult, TextRange, TextStyle } from '@pdf-editor/contracts';
import { useFontResources, findSelectionFontInfo, loadFontPreview } from './font-resources.js';
import { resolveSelectionFormatRuns, type SelectionFormatOptions } from './TextEditPanel.js';
import { useI18n } from './i18n.js';
import { detectParagraph } from './paragraph-detection.js';
import { changedBlock, textChange } from './text-change.js';

export type TextEditorHandle = { finish(): Promise<boolean>; cancel(): void };
type Props = {
  document: DocumentInfo; page: PageModel; selectedIds: string[]; inlineId: string | null;
  host: HTMLElement | null; render: RenderResult; engine: EngineAdapter; disabled: boolean;
  handle: RefObject<TextEditorHandle | null>; initialRange?: TextRange | null; onClose(): void; onEdit(): void; onManageFonts(): void;
  onParagraph(id: string): void;
  onDraftChange(dirty: boolean): void; onBusyChange(busy: boolean): void; onCommitted(result: CommitResult): Promise<void>;
};

export function DirectTextEditor(props: Props) {
  const { document, page, engine, selectedIds, inlineId, host, render, handle, onClose, onEdit, onManageFonts, onDraftChange, onBusyChange, onCommitted, disabled } = props;
  const { t } = useI18n();
  const object = selectedIds.length === 1 ? page.objects.find(item => item.id === selectedIds[0]) : undefined;
  const block = object?.textBlock;
  const original = block?.runs.map(run => run.text).join('') ?? '';
  const key = `${document.id}:${document.revision}:${block?.id}`;
  const [text, setText] = useState(original);
  const [error, setError] = useState('');
  const [size, setSize] = useState('');
  const [spacing, setSpacing] = useState('');
  const [lineHeight, setLineHeight] = useState('1');
  const [selectionRange, setSelectionRange] = useState<TextRange>([0, original.length]);
  const [formatting, setFormatting] = useState(false);
  const [pendingFamily, setPendingFamily] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const range = useRef<TextRange>([0, original.length]);
  const composing = useRef(false);
  const pending = useRef<Promise<boolean> | null>(null);
  const { fonts } = useFontResources(engine);
  const editing = Boolean(block && object?.id === inlineId);
  const dirty = Boolean(editing && text !== original);
  let offset = 0;
  const activeRun = block?.runs.find(run => { offset += run.text.length; return offset > selectionRange[0]; }) ?? block?.runs.at(-1);
  const base = activeRun?.style ?? {};
  const paragraph = object ? detectParagraph(page, object.id) : null;
  const fontInfo = block ? findSelectionFontInfo(block, selectionRange, fonts) : null;
  const currentFamily = fontInfo?.family ?? (/\p{Script=Han}/u.test(original) ? 'Noto Sans CJK SC' : 'Liberation Sans');
  const currentWeight = fontInfo?.weight ?? base.weight ?? 400;
  const currentItalic = fontInfo?.italic ?? base.italic ?? false;
  const families = [...new Set(fonts.map(font => font.family))];
  const [previewFamily, setPreviewFamily] = useState('');
  const previewFace = fonts.find(font => font.id === fontInfo?.fontId);
  useEffect(() => {
    setPreviewFamily('');
    if (!editing || !previewFace) return;
    let active = true;
    void loadFontPreview(previewFace).then(family => { if (active) setPreviewFamily(family); }).catch(() => undefined);
    return () => { active = false; };
  }, [editing, previewFace?.id]);
  const canEdit = Boolean(block && block.editability !== 'geometry-only' && document.permissions.modify && document.capabilities.includes('text.replace'));
  useEffect(() => { setText(original); setError(''); }, [key, original]);
  useEffect(() => { setSize(String(base.fontSize ?? 12)); }, [key, base.fontSize]);
  useEffect(() => { setSpacing(String(Math.round((base.characterSpacing ?? 0) * 1000) / 1000)); }, [key, base.characterSpacing]);
  useEffect(() => { setLineHeight(String(Math.round((base.lineHeight ?? paragraph?.lineHeight ?? 1) * 1000) / 1000)); }, [key, base.lineHeight, paragraph?.lineHeight]);
  useEffect(() => { range.current = [0, original.length]; setSelectionRange(range.current); }, [document.id, block?.id]);
  useEffect(() => { onDraftChange(dirty); }, [dirty, onDraftChange]);
  useEffect(() => () => onDraftChange(false), [onDraftChange]);
  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    const selected = props.initialRange ?? [original === t('New text') ? 0 : original.length, original.length];
    input.current?.setSelectionRange(selected[0]!, selected[1]!);
  }, [inlineId, host]);

  const cancel = () => { setText(original); setError(''); onDraftChange(false); onClose(); };
  const save = (format?: Partial<SelectionFormatOptions>, close = !format): Promise<boolean> => {
    if (pending.current) return pending.current;
    if (!block || !canEdit || composing.current || disabled) return Promise.resolve(false);
    if (!dirty && !format) { if (close) onClose(); return Promise.resolve(true); }
    const perform = async () => {
      onBusyChange(true); setFormatting(Boolean(format)); setError('');
      try {
        const commands: import('@pdf-editor/contracts').EditCommand[] = [];
        const fontIds = new Set<string>();
        if (dirty) {
          const style: TextStyle = {};
          // Keep paragraph run styles by replacing only the changed graphemes.
          const change = block.isParagraph ? textChange(original, text) : { range: [0, original.length] as TextRange, text };
          if (!block.isParagraph && base.fontId && fonts.some(font => font.id === base.fontId)) style.fontId = base.fontId;
          if (style.fontId) fontIds.add(style.fontId);
          const request = { docId: document.id, pageId: page.id, blockId: block.id, ...change, style };
          const layout = await engine.previewText(request);
          if (layout.overflow) throw new Error(t('Text does not fit. Shorten it or use a smaller font size.'));
          commands.push({ type: 'text.replace', pageId: page.id, blockId: block.id, ...change, style });
        }
        if (format && (dirty ? text : original).length) {
          const length = dirty ? text.length : original.length;
          const paragraphFormat = format.formatLineHeight !== undefined || format.formatAlignment !== undefined;
          const part: TextRange = paragraphFormat || range.current[0] === range.current[1] ? [0, length] : range.current;
          const formats = resolveSelectionFormatRuns({ block: dirty ? changedBlock(block, text) : block, range: part, fonts, ...format });
          for (const item of formats) {
            if (item.resolvedFontId) fontIds.add(item.resolvedFontId);
            commands.push({ type: 'text.style', pageId: page.id, blockIds: [block.id], range: item.range, style: item.style });
          }
        }
        const transaction = { id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual' as const, commands };
        // Apply already validates atomically; a second full-document preview doubles the work.
        const result = await new CommandRegistry(engine).execute(transaction, { document, pages: new Map([[page.id, page]]), fontIds });
        onDraftChange(false);
        await onCommitted(result);
        if (close) onClose();
        return true;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : t('Unable to edit this text.');
        setError(message);
        return false;
      } finally { onBusyChange(false); setFormatting(false); setPendingFamily(null); pending.current = null; }
    };
    pending.current = perform();
    return pending.current;
  };
  const convertParagraph = async (height?: string, alignment?: TextStyle['alignment']) => {
    if (!object || !block || dirty || disabled || pending.current) return;
    const candidate = paragraph ?? detectParagraph(page, object.id, true);
    if (!candidate) return;
    onBusyChange(true); setError('');
    try {
      const resolved = resolveSelectionFormatRuns({ block, range: [0, original.length], fonts,
        formatWeight: currentWeight, formatItalic: currentItalic ? 'on' : 'off' })[0]!;
      const fontId = resolved.resolvedFontId!;
      const id = crypto.randomUUID();
      const command = { type: 'text.reflow' as const, pageId: page.id, objectId: id,
        blockIds: candidate.objects.map(item => item.textBlock!.id), text: candidate.text, bounds: candidate.bounds,
        style: { fontId, fontSize: candidate.style.fontSize ?? 12,
          characterSpacing: candidate.style.characterSpacing ?? 0,
          color: candidate.style.color ?? [0, 0, 0] as [number, number, number],
          underline: Boolean(candidate.style.underline), lineHeight: Number(height ?? candidate.lineHeight),
          alignment: alignment ?? 'left' as const } };
      const transaction = { id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual' as const, commands: [command] };
      const result = await new CommandRegistry(engine).execute(transaction, { document, pages: new Map([[page.id, page]]), fontIds: new Set([fontId]) });
      await onCommitted(result);
      props.onParagraph(id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('Unable to edit this text.')); }
    finally { onBusyChange(false); }
  };
  handle.current = { finish: () => save(), cancel };
  if (!block || !object) return <span className="ribbon-hint">{t('Click an object to select it. Double-click text to edit.')} </span>;
  const color = '#' + (base.color ?? [0, 0, 0]).map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
  return <>
    <div className="text-properties" role="toolbar" aria-label={t('Text properties')}>
      <span className="context-label">{t('Text')}</span>
      <select aria-label={t('Font')} disabled={disabled || !canEdit} value={pendingFamily ?? currentFamily}
        onChange={event => {
          const font = fonts.find(item => item.family === event.target.value);
          if (font) { setPendingFamily(font.family); void save({ formatFontId: font.id, formatWeight: currentWeight, formatItalic: currentItalic ? 'on' : 'off' }); }
        }}>
        {!families.includes(currentFamily) && <option value={currentFamily}>{t(currentFamily)}</option>}
        {families.map(family => <option value={family} key={family}>{t(family.replace(/\s*\(technical preview\)$/i, ''))}</option>)}
      </select>
      <button type="button" disabled={disabled} onClick={onManageFonts}>{t('More fonts…')}</button>
      <input type="number" aria-label={t('Font size')} min="1" max="1000" step="0.5" value={size} disabled={disabled || !canEdit}
        onChange={event => setSize(event.target.value)} onBlur={() => { if (Number(size) > 0 && Number(size) !== (base.fontSize ?? 12)) void save({ formatSize: size }); }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
      <button type="button" aria-label={t('Bold')} aria-pressed={currentWeight >= 600} disabled={disabled || !canEdit}
        onClick={() => void save({ formatWeight: currentWeight >= 600 ? 400 : 700 })}><Bold size={17} /></button>
      <button type="button" aria-label={t('Italic')} aria-pressed={currentItalic} disabled={disabled || !canEdit}
        onClick={() => void save({ formatItalic: currentItalic ? 'off' : 'on' })}><Italic size={17} /></button>
      <button type="button" aria-label={t('Underline')} aria-pressed={Boolean(base.underline)} disabled={disabled || !canEdit}
        onClick={() => void save({ formatUnderline: base.underline ? 'off' : 'on' })}><Underline size={17} /></button>
      <input type="color" aria-label={t('Text color')} value={color} disabled={disabled || !canEdit}
        onChange={event => void save({ formatColor: event.target.value })} />
      <span className="toolbar-divider" />
      <label>{t('Character spacing')}<input type="number" aria-label={t('Character spacing')} step="0.1" value={spacing} disabled={disabled || !canEdit}
        onChange={event => setSpacing(event.target.value)} onBlur={() => { if (spacing.trim() && Number.isFinite(Number(spacing)) && Math.abs(Number(spacing) - (base.characterSpacing ?? 0)) > 0.0005) void save({ formatSpacing: spacing }); }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
      <label>{t('Line spacing')}<input type="number" aria-label={t('Line spacing')} min="0.1" max="100" step="0.1" value={lineHeight}
        disabled={disabled || !canEdit || (!block.isParagraph && (dirty || !detectParagraph(page, object.id, true)))}
        onChange={event => setLineHeight(event.target.value)} onBlur={() => {
          if (Number(lineHeight) > 0 && Number(lineHeight) <= 100 && Math.abs(Number(lineHeight) - (base.lineHeight ?? paragraph?.lineHeight ?? 1)) > 0.0005) {
            if (block.isParagraph) void save({ formatLineHeight: lineHeight }); else void convertParagraph(lineHeight);
          }
        }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
      <select aria-label={t('Paragraph alignment')} value={base.alignment ?? 'left'}
        disabled={disabled || !canEdit || (!block.isParagraph && (dirty || !detectParagraph(page, object.id, true)))}
        onChange={event => { const alignment = event.target.value as TextStyle['alignment'];
          if (block.isParagraph) void save({ formatAlignment: alignment }); else void convertParagraph(undefined, alignment);
        }}>
        <option value="left">{t('Align left')}</option><option value="center">{t('Align center')}</option>
        <option value="right">{t('Align right')}</option><option value="justify">{t('Justify')}</option>
      </select>
      {!block.isParagraph && <button type="button" disabled={disabled || !canEdit || dirty || !paragraph}
        title={t('Recognize adjacent text in the same column and edit it as one paragraph.')}
        onClick={() => void convertParagraph()}>{t('Edit paragraph')}</button>}
      <button type="button" disabled={disabled || !canEdit} onClick={() => { if (editing) void save(); else onEdit(); }}>{t(editing ? 'Done' : 'Edit text')}</button>
      {editing && <button type="button" disabled={disabled} onClick={cancel}>{t('Cancel')}</button>}
      {!canEdit && <span className="ribbon-hint">{t('This text cannot be edited directly.')}</span>}
      {formatting && <span className="ribbon-hint" role="status">{t('Updating text…')}</span>}
      {error && <span className="property-error" role="alert">{t(error)}</span>}
    </div>
    {editing && host && canEdit && createPortal(<div className="direct-text-editor" role="group" aria-label={t('Edit text on page')}
      style={{ left: object.bounds.x * render.width / page.widthPt, top: object.bounds.y * render.height / page.heightPt,
        width: Math.max(40, object.bounds.width * render.width / page.widthPt + 4) }}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <textarea ref={input} aria-label={t('Page text')} value={text} disabled={disabled}
        rows={Math.max(1, text.split('\n').length)} wrap={block.isParagraph || original.includes('\n') ? 'soft' : 'off'}
        style={{ minHeight: Math.max(28, object.bounds.height * render.height / page.heightPt + 6),
          fontFamily: `"${previewFamily || currentFamily}", sans-serif`,
          fontSize: (base.fontSize ?? 12) * render.width / page.widthPt, color, fontWeight: currentWeight,
          fontStyle: currentItalic ? 'italic' : 'normal', textDecoration: base.underline ? 'underline' : 'none',
          letterSpacing: (base.characterSpacing ?? 0) * render.width / page.widthPt,
          lineHeight: base.lineHeight ?? 1, textAlign: base.alignment ?? 'left' }}
        onChange={event => setText(event.target.value)} onSelect={event => { range.current = [event.currentTarget.selectionStart, event.currentTarget.selectionEnd]; setSelectionRange(range.current); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; setText(event.currentTarget.value); }}
        onBlur={event => {
          const target = event.relatedTarget;
          if (target instanceof Element && target.closest('.text-properties, .direct-text-editor')) return;
          if (!composing.current) void save();
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || composing.current) return;
          if (event.key === 'Escape') { event.preventDefault(); cancel(); }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
        }} />
      <div className="direct-text-actions">
        <button type="button" aria-label={t('Done')} title={t('Done (Ctrl Enter)')} disabled={disabled} onClick={() => void save()}><Check size={15} /></button>
        <button type="button" aria-label={t('Cancel')} disabled={disabled} onClick={cancel}><X size={15} /></button>
      </div>
      {error && <span className="direct-text-error" role="alert">{t(error)}</span>}
    </div>, host)}
  </>;
}
