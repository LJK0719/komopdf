import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Popover } from '@base-ui/react/popover';
import { Bold, Italic, Underline, Check, X } from 'lucide-react';
import { CommandRegistry } from '@pdf-editor/commands';
import type { CommitResult, DocumentInfo, EngineAdapter, PageModel, RenderResult, StyledTextRun, TextBlock, TextRange, TextStyle } from '@pdf-editor/contracts';
import { useFontResources, findSelectionFontInfo, loadFontPreview } from './font-resources.js';
import { resolveSelectionFormatRuns, type SelectionFormatOptions } from './TextEditPanel.js';
import { useI18n } from './i18n.js';
import { detectParagraph, selectedTextObject } from './paragraph-detection.js';
import { paragraphInputRange, sourceTextOffset } from './source-text.js';
import { applyParagraphFormats, canFormatSourceParagraph, paragraphProperties, resolveParagraphRunFont, sourceParagraphLayout, sourceParagraphStyles } from './source-paragraph-edit.js';
import { changedBlock, textChange } from './text-change.js';
import type { ParagraphInputHandle } from './ParagraphInput.js';
const ParagraphInput = lazy(() => import('./ParagraphInput.js').then(module => ({ default: module.ParagraphInput })));

export type TextEditorHandle = { finish(): Promise<boolean>; cancel(): void };
type Props = {
  document: DocumentInfo; page: PageModel; selectedIds: string[]; inlineId: string | null;
  host: HTMLElement | null; render: RenderResult; engine: EngineAdapter; disabled: boolean;
  handle: RefObject<TextEditorHandle | null>; initialRange?: TextRange | null; initialRangeIsLogical?: boolean; onClose(): void; onEdit(): void; onManageFonts(): void;
  onParagraph(id: string): void;
  copiedFormat: TextStyle | null; onCopyFormat(style: TextStyle): void;
  onDraftChange(dirty: boolean): void; onBusyChange(busy: boolean): void; onCommitted(result: CommitResult): Promise<void>;
};

export function DirectTextEditor(props: Props) {
  const { document, page, engine, selectedIds, inlineId, host, render, handle, onClose, onEdit, onManageFonts, onDraftChange, onBusyChange, onCommitted, disabled } = props;
  const { t } = useI18n();
  const selected = selectedTextObject(page, selectedIds);
  const object = selected && inlineId && selectedIds.includes(inlineId) ? page.objects.find(item => item.id === inlineId) : selected;
  const sourceBlock = object?.textBlock;
  const editing = Boolean(sourceBlock && inlineId && selectedIds.includes(inlineId));
  const paragraph = object ? detectParagraph(page, object.id) ?? detectParagraph(page, object.id, true) : null;
  const virtual = paragraph && !sourceBlock?.isParagraph ? paragraph : null;
  const block: TextBlock | undefined = virtual && sourceBlock ? { ...sourceBlock, isParagraph: true, bounds: virtual.bounds, runs: virtual.runs }
    : sourceBlock?.flow?.start === 0 && sourceBlock.flow.runs ? { ...sourceBlock, runs: sourceBlock.flow.runs } : sourceBlock;
  const original = block?.runs.map(run => run.text).join('') ?? '';
  const sourceOffset = virtual && object ? virtual.sourceRanges[object.id]?.[0] ?? 0 : 0;
  let initialRange: TextRange | null = props.initialRange ?? (original === t('New text') ? [0, original.length] : null);
  if (initialRange && sourceBlock) {
    if (virtual) initialRange = paragraphInputRange(sourceBlock, initialRange, sourceOffset, props.initialRangeIsLogical);
    else if (props.initialRangeIsLogical) initialRange = [sourceTextOffset(sourceBlock, initialRange[0]), sourceTextOffset(sourceBlock, initialRange[1])];
  }
  const key = `${document.id}:${document.revision}:${block?.id}:${editing}`;
  const [text, setText] = useState(original);
  const [draftRuns, setDraftRuns] = useState<StyledTextRun[] | null>(null);
  const [draftStyle, setDraftStyle] = useState<TextStyle>({});
  const richInput = useRef<ParagraphInputHandle | null>(null);
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
  const dirty = Boolean(editing && (text !== original || draftRuns || Object.keys(draftStyle).length));
  let offset = 0;
  const activeRuns = draftRuns ?? block?.runs;
  const activeRun = activeRuns?.find(run => { offset += run.text.length; return offset > selectionRange[0]; }) ?? activeRuns?.at(-1);
  const base = { ...activeRun?.style, ...(virtual ? { alignment: virtual.style.alignment ?? 'left' } : {}), ...draftStyle };
  const paragraphStyle: TextStyle = { ...block?.runs[0]?.style, ...(virtual ? { alignment: virtual.style.alignment ?? 'left' } : {}), lineHeight: block?.runs[0]?.style.lineHeight ?? virtual?.lineHeight ?? 1.2,
    firstLineIndent: block?.runs[0]?.style.firstLineIndent ?? virtual?.firstLineIndent ?? 0, ...draftStyle };
  const fontInfo = block ? findSelectionFontInfo({ ...block, runs: activeRuns ?? block.runs }, selectionRange, fonts) : null;
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
  useEffect(() => { setText(original); setDraftRuns(null); setDraftStyle({}); setError(''); }, [key, original]);
  useEffect(() => { setSize(String(base.fontSize ?? 12)); }, [key, base.fontSize]);
  useEffect(() => { setSpacing(String(Math.round((base.characterSpacing ?? 0) * 1000) / 1000)); }, [key, base.characterSpacing]);
  useEffect(() => { setLineHeight(String(Math.round((base.lineHeight ?? paragraph?.lineHeight ?? 1) * 1000) / 1000)); }, [key, base.lineHeight, paragraph?.lineHeight]);
  useEffect(() => { range.current = [0, original.length]; setSelectionRange(range.current); }, [document.id, block?.id]);
  useEffect(() => { onDraftChange(dirty); }, [dirty, onDraftChange]);
  useEffect(() => () => onDraftChange(false), [onDraftChange]);
  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    const selected = initialRange ?? [original === t('New text') ? 0 : original.length, original.length];
    input.current?.setSelectionRange(selected[0]!, selected[1]!);
  }, [inlineId, host]);

  const cancel = () => { setText(original); setDraftRuns(null); setDraftStyle({}); setError(''); onDraftChange(false); onClose(); };
  const save = (format?: Partial<SelectionFormatOptions>, close = !format): Promise<boolean> => {
    if (pending.current) return pending.current;
    if (!block || !canEdit || composing.current || richInput.current?.isComposing() || disabled) return Promise.resolve(false);
    if (format && editing && block.isParagraph) {
      try {
        const current = { ...block, runs: draftRuns ?? block.runs };
        const part: TextRange = range.current[0] === range.current[1] ? [0, text.length] : range.current;
        const formats = resolveSelectionFormatRuns({ block: current, range: part, fonts, ...format });
        for (const item of formats) {
          const { lineHeight, alignment, firstLineIndent, lineSpacing, spaceBefore, spaceAfter, ...inline } = item.style;
          const paragraphValues = { lineHeight, alignment, firstLineIndent, lineSpacing, spaceBefore, spaceAfter };
          if (Object.values(paragraphValues).some(value => value !== undefined))
            setDraftStyle(previous => ({ ...previous, ...Object.fromEntries(Object.entries(paragraphValues).filter(([, value]) => value !== undefined)) }));
          if (Object.keys(inline).length) richInput.current?.format(inline, item.range);
        }
        setError(''); return Promise.resolve(true);
      } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return Promise.resolve(false); }
    }
    if (!dirty && !format) { if (close) onClose(); return Promise.resolve(true); }
    if (virtual && format && !editing) {
      try {
        const style = resolveSelectionFormatRuns({ block, range: [0, original.length], fonts, ...format })[0]!.style;
        if (!canFormatSourceParagraph(page, virtual, style)) return convertParagraph(undefined, style.alignment, style).then(() => true);
      } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return Promise.resolve(false); }
    }
    const perform = async () => {
      onBusyChange(true); setFormatting(Boolean(format)); setError('');
      try {
        const commands: import('@pdf-editor/contracts').EditCommand[] = [];
        const fontIds = new Set<string>();
        let convertedId: string | null = null;
        const sourceFormats = virtual && format && !editing
          ? resolveSelectionFormatRuns({ block, range: [0, original.length], fonts, ...format }) : [];
        const sourceStyle = Object.assign({}, draftStyle, ...sourceFormats.map(item => paragraphProperties(item.style))) as TextStyle;
        const sourceEdit = virtual && text === original && canFormatSourceParagraph(page, virtual, sourceStyle);
        if (sourceEdit) {
          const runs = applyParagraphFormats(draftRuns ?? block.runs, sourceFormats);
          commands.push(...sourceParagraphLayout(page, virtual, sourceStyle), ...sourceParagraphStyles(page, virtual, runs, fonts));
          for (const command of commands) if (command.type === 'text.style' && command.style.fontId) fontIds.add(command.style.fontId);
        } else if (dirty && !virtual && text === original && !draftRuns) {
          commands.push({ type: 'text.style', pageId: page.id, blockIds: [block.id], style: draftStyle });
        } else if (dirty) {
          let target = block.id;
          const runs = draftRuns ?? changedBlock(block, text).runs;
          const resolved = runs.filter(run => run.text).map(run => {
            const font = resolveParagraphRunFont(run, fonts);
            fontIds.add(font);
            const { weight: _weight, italic: _italic, lineHeight: _height, alignment: _alignment,
              firstLineIndent: _indent, lineSpacing: _spacing, spaceBefore: _before, spaceAfter: _after, ...inline } = run.style;
            return { text: run.text, style: { ...inline, fontId: font } };
          });
          if (virtual && text.length) {
            const id = crypto.randomUUID(); target = id + ':text'; convertedId = id;
            const first = resolved[0]!;
            const seedFont = first.style.fontId;
            fontIds.add(seedFont);
            commands.push({ type: 'text.reflow', pageId: page.id, objectId: id,
              blockIds: virtual.objects.map(item => item.textBlock!.id), text, bounds: virtual.bounds,
              style: { ...first.style, fontId: seedFont, fontSize: first.style.fontSize ?? 12,
                lineHeight: paragraphStyle.lineHeight ?? 1.2, alignment: paragraphStyle.alignment ?? 'left',
                firstLineIndent: paragraphStyle.firstLineIndent ?? 0, lineSpacing: paragraphStyle.lineSpacing ?? 0,
                spaceBefore: paragraphStyle.spaceBefore ?? 0, spaceAfter: paragraphStyle.spaceAfter ?? 0 } });
          } else if (virtual && !text.length) {
            commands.push({ type: 'objects.delete', pageId: page.id, objectIds: virtual.objects.map(item => item.id) });
          } else if (text !== original) {
            const style: TextStyle = {};
            const change = block.isParagraph ? textChange(original, text) : { range: [0, original.length] as TextRange, text };
            if (!block.isParagraph && resolved[0]) style.fontId = resolved[0].style.fontId;
            if (block.isParagraph && change.text) {
              let position = 0;
              const insertion = resolved.find(run => { position += run.text.length; return position > change.range[0]; }) ?? resolved.at(-1)!;
              const face = fonts.find(font => font.id === insertion.style.fontId);
              style.fontId = resolveSelectionFormatRuns({ block: { ...block, runs: [{ text: change.text, style: insertion.style, sourceObjectIds: [] }] },
                range: [0, change.text.length], fonts, formatFontId: insertion.style.fontId,
                formatWeight: face?.weight ?? 400, formatItalic: face?.italic ? 'on' : 'off' })[0]!.resolvedFontId!;
              fontIds.add(style.fontId);
            }
            // Paragraph replacement grows and paginates in the core, atomically.
            commands.push({ type: 'text.replace', pageId: page.id, blockId: block.id, ...change, style });
          }
          if (text.length && block.isParagraph) {
            let start = 0;
            if (!virtual || resolved.length > 1) for (const run of resolved) {
              const end = start + run.text.length;
              commands.push({ type: 'text.style', pageId: page.id, blockIds: [target], range: [start, end], style: run.style });
              start = end;
            }
            if (!virtual && Object.keys(draftStyle).length)
              commands.push({ type: 'text.style', pageId: page.id, blockIds: [target], style: draftStyle });
          }
        }
        if (format && !sourceEdit && (dirty ? text : original).length) {
          const length = dirty ? text.length : original.length;
          const paragraphFormat = format.formatLineHeight !== undefined || format.formatAlignment !== undefined;
          const part: TextRange = paragraphFormat || range.current[0] === range.current[1] ? [0, length] : range.current;
          const formats = resolveSelectionFormatRuns({ block: dirty ? changedBlock(block, text) : block, range: part, fonts, ...format });
          for (const item of formats) {
            if (item.resolvedFontId) fontIds.add(item.resolvedFontId);
            commands.push({ type: 'text.style', pageId: page.id, blockIds: [block.id], range: item.range, style: item.style });
          }
        }
        if (!commands.length) { onDraftChange(false); if (close) onClose(); return true; }
        const transaction = { id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual' as const, commands };
        // Apply already validates atomically; a second full-document preview doubles the work.
        const result = await new CommandRegistry(engine).execute(transaction, { document, pages: new Map([[page.id, page]]), fontIds });
        onDraftChange(false);
        await onCommitted(result);
        if (convertedId) props.onParagraph(convertedId);
        if (close) onClose();
        return true;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : t('Unable to edit this text.');
        setError(message);
        return false;
      } finally { onBusyChange(false); setFormatting(false); setPendingFamily(null); pending.current = null; }
    };
    pending.current = Promise.resolve().then(perform);
    return pending.current;
  };
  const convertParagraph = async (height?: string, alignment?: TextStyle['alignment'], metrics: TextStyle = {}) => {
    if (!object || !block || dirty || disabled || pending.current) return;
    const candidate = paragraph ?? detectParagraph(page, object.id, true);
    if (!candidate) return;
    onBusyChange(true); setError('');
    try {
      const fontId = resolveParagraphRunFont(metrics.fontId
        ? { text: candidate.text, style: { ...candidate.style, ...metrics }, sourceObjectIds: [] }
        : candidate.runs[0]!, fonts);
      const id = crypto.randomUUID();
      const command = { type: 'text.reflow' as const, pageId: page.id, objectId: id,
        blockIds: candidate.objects.map(item => item.textBlock!.id), text: candidate.text, bounds: candidate.bounds,
        style: { characterSpacing: candidate.style.characterSpacing ?? 0,
          color: candidate.style.color ?? [0, 0, 0] as [number, number, number],
          underline: Boolean(candidate.style.underline), lineHeight: Number(height ?? candidate.lineHeight),
          alignment: alignment ?? candidate.style.alignment ?? 'left' as const, firstLineIndent: candidate.firstLineIndent, ...metrics,
          fontId, fontSize: metrics.fontSize ?? candidate.style.fontSize ?? 12 } };
      const commands: import('@pdf-editor/contracts').EditCommand[] = [command];
      const fontIds = new Set([fontId]);
      if (!metrics.fontId) {
        let start = 0;
        for (const run of candidate.runs) {
          const face = resolveParagraphRunFont(run, fonts);
          fontIds.add(face);
          commands.push({ type: 'text.style', pageId: page.id, blockIds: [id + ':text'], range: [start, start + run.text.length],
            style: { fontId: face, fontSize: run.style.fontSize ?? 12, color: run.style.color ?? [0, 0, 0],
              characterSpacing: run.style.characterSpacing ?? 0, underline: run.style.underline ?? false } });
          start += run.text.length;
        }
      }
      const transaction = { id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual' as const, commands };
      const result = await new CommandRegistry(engine).execute(transaction, { document, pages: new Map([[page.id, page]]), fontIds });
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
      <button type="button" disabled={disabled || !canEdit} title={t('Copied format also applies to new text boxes')}
        onClick={() => {
          try {
            const font = resolveSelectionFormatRuns({ block: { ...block, runs: draftRuns ?? block.runs }, range: selectionRange,
              fonts, formatWeight: currentWeight, formatItalic: currentItalic ? 'on' : 'off' })[0]!.resolvedFontId!;
            const { weight: _weight, italic: _italic, ...format } = { ...paragraphStyle, ...base };
            props.onCopyFormat({ ...format, fontId: font }); setError('');
          } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
        }}>{t('Copy format')}</button>
      <button type="button" disabled={disabled || !canEdit || !props.copiedFormat} onClick={() => {
        const style = props.copiedFormat;
        if (!style) return;
        if (!block.isParagraph) { void convertParagraph(String(style.lineHeight ?? 1.2), style.alignment, style); return; }
        void save({ formatFontId: style.fontId ?? '', formatSize: String(style.fontSize ?? 12),
          formatSpacing: String(style.characterSpacing ?? 0), formatLineHeight: String(style.lineHeight ?? 1.2),
          formatFirstLineIndent: String(style.firstLineIndent ?? 0), formatLineSpacing: String(style.lineSpacing ?? 0),
          formatSpaceBefore: String(style.spaceBefore ?? 0), formatSpaceAfter: String(style.spaceAfter ?? 0),
          formatAlignment: style.alignment ?? 'left', formatUnderline: style.underline ? 'on' : 'off',
          formatColor: '#' + (style.color ?? [0, 0, 0]).map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('') });
      }}>{t('Apply format')}</button>
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
      <Popover.Root><Popover.Trigger disabled={disabled || !canEdit || (!block.isParagraph && !paragraph)}>{t('Paragraph settings')}</Popover.Trigger>
        <Popover.Portal><Popover.Positioner sideOffset={6}><Popover.Popup className="paragraph-settings" aria-label={t('Paragraph settings')}>
      {([
        ['First-line indent (pt)', 'firstLineIndent', 'formatFirstLineIndent'],
        ['Fixed line spacing (pt)', 'lineSpacing', 'formatLineSpacing'],
        ['Space before (pt)', 'spaceBefore', 'formatSpaceBefore'],
        ['Space after (pt)', 'spaceAfter', 'formatSpaceAfter'],
      ] as const).map(([label, field, option]) => <label key={field}>{t(label)}<input key={`${key}:${paragraphStyle[field] ?? 0}`}
        type="number" aria-label={t(label)} min={field === 'firstLineIndent' ? -1000 : 0} max={field === 'firstLineIndent' ? 1000 : 2000}
        step="0.5" defaultValue={paragraphStyle[field] ?? 0}
        disabled={disabled || !canEdit || (!block.isParagraph && !paragraph)}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        onBlur={event => {
          const value = Number(event.currentTarget.value);
          if (!event.currentTarget.validity.valid || !Number.isFinite(value) || value === (paragraphStyle[field] ?? 0)) return;
          if (block.isParagraph) void save({ [option]: String(value) });
          else void convertParagraph(undefined, undefined, { [field]: value });
        }} /></label>)}
        </Popover.Popup></Popover.Positioner></Popover.Portal></Popover.Root>
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
      style={{ left: block.bounds.x * render.width / page.widthPt, top: block.bounds.y * render.height / page.heightPt,
        width: Math.max(40, block.bounds.width * render.width / page.widthPt + 4) }}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      {block.isParagraph ? <Suspense fallback={<span role="status">{t('Loading…')}</span>}><ParagraphInput key={key}
        runs={block.runs} fonts={fonts} zoom={render.width / page.widthPt} disabled={disabled}
        initialRange={initialRange}
        handle={richInput} label={t('Page text')} style={paragraphStyle}
        onChange={(value, runs, dirty) => { setText(value); setDraftRuns(dirty ? runs : null); }}
        onFormat={format => { void save(format === 'bold' ? { formatWeight: currentWeight >= 600 ? 400 : 700 }
          : format === 'italic' ? { formatItalic: currentItalic ? 'off' : 'on' } : { formatUnderline: base.underline ? 'off' : 'on' }); }}
        onSelect={value => { range.current = value; setSelectionRange(value); }}
        onFinish={() => { void save(); }} onCancel={cancel} /></Suspense> : <textarea ref={input} aria-label={t('Page text')} value={text} disabled={disabled}
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
          if (target instanceof Element && target.closest('.text-properties, .direct-text-editor, .paragraph-settings')) return;
          if (!composing.current) void save();
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || composing.current) return;
          if (event.key === 'Escape') { event.preventDefault(); cancel(); }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
        }} />}
      <div className="direct-text-actions">
        <button type="button" aria-label={t('Done')} title={t('Done (Ctrl Enter)')} disabled={disabled} onClick={() => void save()}><Check size={15} /></button>
        <button type="button" aria-label={t('Cancel')} disabled={disabled} onClick={cancel}><X size={15} /></button>
      </div>
      {error && <span className="direct-text-error" role="alert">{t(error)}</span>}
    </div>, host)}
  </>;
}
