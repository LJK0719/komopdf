import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  EngineError, assertTextRange, graphemeBoundaries, type TextRange,
  type CommitResult,
  type DocumentInfo,
  type EngineAdapter,
  type PageModel,
  type RenderResult,
  type TextBlock,
  type TextLayoutResult,
  type TextStyle,
  type EditTransaction,
} from '@pdf-editor/contracts';
import { CommandRegistry } from '@pdf-editor/commands';
import {
  useFontResources,
  resolveExactFontFace,
  findSelectionFontInfo,
  getFontWeight,
  getFontItalic,
  getAvailableWeightsForFamily,
  familySupportsItalic,
  isFontEmbeddable,
  STANDARD_WEIGHT_OPTIONS,
  type EditorFont,
} from './font-resources.js';

type Props = {
  document: DocumentInfo | null;
  page: PageModel | null;
  selectedIds: string[];
  searchSelection?: { docId: string; revision: number; pageId: string; blockId: string; start: number; end: number; key: number } | null;
  inlineTextId?: string | null;
  inlineHost?: HTMLElement | null;
  render?: RenderResult | null;
  onInlineClose?(): void;
  engine: EngineAdapter;
  disabled?: boolean;
  onBusyChange?(busy: boolean): void;
  onDraftChange?(dirty: boolean): void;
  onCommitted(result: CommitResult): Promise<void>;
};

export function TextEditPanel({ document, page, selectedIds, searchSelection, inlineTextId, inlineHost, render, onInlineClose,
  engine, disabled = false, onBusyChange, onDraftChange, onCommitted }: Props) {
  const selectedObject = useMemo(() => {
    if (!page || selectedIds.length !== 1) return null;
    return page.objects.find((object) => object.id === selectedIds[0]) ?? null;
  }, [page, selectedIds]);
  const block = selectedObject?.textBlock ?? null;
  const originalText = block?.runs.map((run) => run.text).join('') ?? '';
  const selectionKey = `${document?.id ?? ''}\0${document?.revision ?? ''}\0${page?.id ?? ''}\0${block?.id ?? ''}`;
  const originalInput = useRef<HTMLTextAreaElement>(null);
  const inlineInput = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [replacement, setReplacement] = useState(originalText);
  const [fontId, setFontId] = useState('');
  const [formatFontId, setFormatFontId] = useState('');
  const [formatWeight, setFormatWeight] = useState<number | ''>('');
  const [formatItalic, setFormatItalic] = useState<'' | 'on' | 'off'>('');
  const [formatSize, setFormatSize] = useState('');
  const [formatColor, setFormatColor] = useState('');
  const [formatSpacing, setFormatSpacing] = useState('');
  const [formatUnderline, setFormatUnderline] = useState<'' | 'on' | 'off'>('');
  const formatDirty = Boolean(formatFontId || formatWeight !== '' || formatItalic !== '' || formatSize || formatColor || formatSpacing || formatUnderline);
  const clearFormat = () => {
    setFormatFontId('');
    setFormatWeight('');
    setFormatItalic('');
    setFormatSize('');
    setFormatColor('');
    setFormatSpacing('');
    setFormatUnderline('');
  };
  const [range, setRange] = useState<TextRange>([0, originalText.length]);
  const wholeBlock = range[0] === 0 && range[1] === originalText.length;
  const targetText = originalText.slice(range[0], range[1]);
  const draftBase = useRef({ key: selectionKey, text: originalText });
  const draftDirty = Boolean(block && draftBase.current.key === selectionKey && draftBase.current.text === originalText
    && (replacement !== targetText || fontId || formatDirty));
  useEffect(() => { onDraftChange?.(draftDirty); }, [draftDirty, onDraftChange]);
  useEffect(() => () => { onDraftChange?.(false); }, [onDraftChange]);
  const [preview, setPreview] = useState<TextLayoutResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const previewSequence = useRef(0);
  const invalidatePreview = () => {
    previewSequence.current += 1;
    setPreview(null);
    setPreviewing(false);
    setError('');
  };
  const changeReplacement = (text: string) => { setReplacement(text); invalidatePreview(); };
  const discardDraft = () => { setReplacement(targetText); setFontId(''); clearFormat(); invalidatePreview(); };
  const { fonts, error: fontError } = useFontResources(engine);

  useEffect(() => {
    previewSequence.current += 1;
    draftBase.current = { key: selectionKey, text: originalText };
    setReplacement(originalText);
    setRange([0, originalText.length]);
    setFontId('');
    clearFormat();
    setPreview(null);
    setPreviewing(false);
    setError('');
  }, [selectionKey, originalText]);

  useEffect(() => {
    if (!searchSelection || document?.id !== searchSelection.docId || document.revision !== searchSelection.revision ||
      page?.id !== searchSelection.pageId || block?.id !== searchSelection.blockId) return;
    if (searchSelection.start < 0 || searchSelection.end > originalText.length || searchSelection.end <= searchSelection.start) return;
    let start = 0;
    let end = originalText.length;
    for (const boundary of graphemeBoundaries(originalText)) {
      if (boundary <= searchSelection.start && boundary > start) start = boundary;
      if (boundary >= searchSelection.end && boundary < end) end = boundary;
    }
    const next: TextRange = [start, end];
    setRange(next);
    setReplacement(originalText.slice(...next));
    previewSequence.current += 1;
    setPreview(null);
    setPreviewing(false);
    originalInput.current?.focus();
    originalInput.current?.setSelectionRange(...next);
  }, [searchSelection, selectionKey, originalText]);

  useEffect(() => {
    if (!inlineTextId || inlineTextId !== selectedObject?.id || !block) return;
    setRange([0, originalText.length]);
    setReplacement(originalText);
    setFontId('');
    clearFormat();
    previewSequence.current += 1;
    setPreview(null);
    setPreviewing(false);
    setError('');
    inlineInput.current?.focus();
    inlineInput.current?.setSelectionRange(0, originalText.length);
  }, [inlineTextId]);

  const canReplace = Boolean(
    document
    && page
    && block
    && block.editability !== 'geometry-only'
    && document.permissions.modify
    && document.capabilities.includes('text.replace'),
  );

  const request = () => {
    if (!document || !page || !block) throw new EngineError('INVALID_REQUEST', 'Select one editable text block');
    return {
      docId: document.id,
      pageId: page.id,
      blockId: block.id,
      range,
      text: replacement,
      ...(fontId ? { style: { fontId } } : {}),
    };
  };

  const runPreview = async (): Promise<void> => {
    if (!canReplace || previewing || applying || composing.current) return;
    const sequence = ++previewSequence.current;
    setPreviewing(true);
    setError('');
    try {
      const result = await engine.previewText(request());
      if (previewSequence.current === sequence) setPreview(result);
    } catch (caught) {
      if (previewSequence.current === sequence) setError(formatError(caught));
    } finally {
      if (previewSequence.current === sequence) setPreviewing(false);
    }
  };

  const commit = async (): Promise<void> => {
    if (!document || !page || !block || !preview || preview.overflow || applying || composing.current) return;
    setApplying(true);
    onBusyChange?.(true);
    setError('');
    try {
      if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is required to commit edits');
      const registry = new CommandRegistry(engine);
      const result = await registry.execute({
        id: crypto.randomUUID(),
        docId: document.id,
        baseRevision: document.revision,
        source: 'manual',
        commands: [{
          type: 'text.replace',
          pageId: page.id,
          blockId: block.id,
          range,
          text: replacement,
          ...(fontId ? { style: { fontId } } : {}),
        }],
      }, {
        document,
        pages: new Map([[page.id, page]]),
        ...(fontId ? { fontIds: new Set([fontId]) } : {}),
      });
      await onCommitted(result);
      onInlineClose?.();
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      onBusyChange?.(false);
      setApplying(false);
    }
  };

  const formatSelection = async (): Promise<void> => {
    if (!document || !page || !block || applying || !formatDirty) return;
    setApplying(true); onBusyChange?.(true); setError('');
    try {
      const formats = resolveSelectionFormatRuns({
        block,
        range,
        fonts,
        formatFontId,
        formatWeight,
        formatItalic,
        formatSize,
        formatSpacing,
        formatColor,
        formatUnderline,
      });
      const transaction: EditTransaction = {
        id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual',
        commands: formats.map(({ range: part, style }) => ({
          type: 'text.style', pageId: page.id, blockIds: [block.id], range: part, style,
        })),
      };
      const registry = new CommandRegistry(engine);
      const fontIds = new Set(formats.flatMap(({ resolvedFontId }) => resolvedFontId ? [resolvedFontId] : []));
      const context = { document, pages: new Map([[page.id, page]]), fontIds };
      await engine.previewTransaction(transaction);
      await onCommitted(await registry.execute(transaction, context));
      clearFormat();
    } catch (caught) { setError(formatError(caught)); }
    finally { setApplying(false); onBusyChange?.(false); }
  };

  if (!block) {
    return <section className="text-edit-panel" aria-label="Manual text editing">
      <span className="eyebrow">Manual Text Edit</span>
      <p>Select one text object to edit its original text.</p>
    </section>;
  }

  return <section className="text-edit-panel" aria-label="Manual text editing">
    {inlineHost && render && page && selectedObject && inlineTextId === selectedObject.id && canReplace && createPortal(
      <div className="inline-text-editor" role="group" aria-label="Edit text on page"
        style={{ left: selectedObject.bounds.x * render.width / page.widthPt,
          top: selectedObject.bounds.y * render.height / page.heightPt,
          width: Math.max(190, selectedObject.bounds.width * render.width / page.widthPt) }}
        onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
        {preview && <div className={preview.overflow ? 'inline-preview-bounds inline-preview-overflow' : 'inline-preview-bounds'}
          aria-hidden="true" style={{ left: (preview.bounds.x - selectedObject.bounds.x) * render.width / page.widthPt,
            top: (preview.bounds.y - selectedObject.bounds.y) * render.height / page.heightPt,
            width: preview.bounds.width * render.width / page.widthPt,
            height: preview.bounds.height * render.height / page.heightPt }} />}
        <label className="inline-text-label">Page text draft
          <textarea ref={inlineInput} aria-label="Page text draft" value={replacement}
            style={{ minHeight: Math.max(42, selectedObject.bounds.height * render.height / page.heightPt) }}
            disabled={disabled || applying}
            onChange={event => changeReplacement(event.currentTarget.value)}
            onBeforeInput={event => { if (!composing.current) snapGraphemeSelection(event.currentTarget); }}
            onSelect={event => { if (!composing.current) snapGraphemeSelection(event.currentTarget); }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={event => { composing.current = false; changeReplacement(event.currentTarget.value); snapGraphemeSelection(event.currentTarget); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || composing.current) return;
              if (event.key === 'Escape') { event.preventDefault(); discardDraft(); onInlineClose?.(); return; }
              moveEditableSelection(event, changeReplacement);
            }} />
        </label>
        <div className="inline-text-toolbar">
          <button type="button" disabled={disabled || previewing || applying} onClick={() => void runPreview()}>
            {previewing ? 'Previewing…' : 'Preview page text'}</button>
          <button type="button" disabled={disabled || !preview || preview.overflow || previewing || applying || !draftDirty || formatDirty}
            onClick={() => void commit()}>Commit page text</button>
          <button type="button" disabled={disabled || applying} onClick={() => { discardDraft(); onInlineClose?.(); }}>Cancel page text</button>
        </div>
        {preview && <span role="status" className={preview.overflow ? 'inline-text-status inline-text-overflow' : 'inline-text-status'}>
          {preview.overflow ? 'Overflow detected — shorten the draft before committing' : 'Engine preview: fits current text bounds'}
        </span>}
        {error && <span role="alert" className="inline-text-status inline-text-overflow">{error}</span>}
      </div>, inlineHost)}
    <span className="eyebrow">{block.isOcr ? 'Correct OCR Search Text' : block.isParagraph ? 'Paragraph Text Edit' : 'Manual Text Edit'}</span>
    {block.isOcr && <p>This is an invisible OCR search layer. Corrections update searchable and copied text inside the recognized box; they do not change the scanned image.</p>}
    {block.isParagraph && <p>This text block is a formatted paragraph. Text replacement (including newlines) reflows natively while preserving the block ID. If the document was reopened and the original font is not in the font registry, select an explicit Replacement font below.</p>}
    <label>Original text<textarea ref={originalInput} value={originalText} readOnly disabled={disabled || previewing || applying}
      onKeyDown={moveReadOnlySelection}
      onSelect={event => {
        if (!canReplace || !document?.capabilities.includes('text.style') || disabled || previewing || applying) return;
        const next: TextRange = [event.currentTarget.selectionStart, event.currentTarget.selectionEnd];
        if (next[0] === next[1] || (next[0] === range[0] && next[1] === range[1])) return;
        try { assertTextRange(originalText, next); }
        catch (caught) { event.currentTarget.setSelectionRange(...range); setError(formatError(caught)); return; }
        if (draftDirty && !window.confirm('Discard the current replacement draft and edit this selection?')) {
          event.currentTarget.setSelectionRange(...range); return;
        }
        setRange(next); setReplacement(originalText.slice(...next)); setFontId(''); clearFormat(); invalidatePreview();
      }} /></label>
    <p>{wholeBlock ? 'Editing the whole text block. Highlight characters above to replace a range.'
      : `Editing characters ${range[0] + 1}–${range[1]}. Font changes require the whole block.`}</p>
    {!wholeBlock && <button type="button" disabled={disabled || previewing || applying} onClick={() => {
      setReplacement(originalText.slice(0, range[0]) + replacement + originalText.slice(range[1]));
      setRange([0, originalText.length]); invalidatePreview();
    }}>Use whole text block</button>}
    <label>Replacement<textarea
      value={replacement}
      onChange={(event) => changeReplacement(event.target.value)}
      disabled={disabled || previewing || applying || !canReplace || formatDirty}
    /></label>
    <label>Replacement font<select
      value={fontId}
      onChange={(event) => { setFontId(event.target.value); invalidatePreview(); }}
      disabled={disabled || previewing || applying || !canReplace || !wholeBlock || formatDirty}
    >
      <option value="">Preserve original font</option>
      {fonts.map((font) => <option key={font.id} value={font.id}>{font.family} · {font.style}</option>)}
    </select></label>
    {fontId && wholeBlock && (() => {
      const selectedFont = fonts.find(f => f.id === fontId);
      if (!selectedFont) return null;
      const availableWeights = getAvailableWeightsForFamily(fonts, selectedFont.family);
      const hasItalic = familySupportsItalic(fonts, selectedFont.family);
      return (
        <div className="document-tools-grid">
          <label>Replacement weight<select
            value={getFontWeight(selectedFont)}
            onChange={event => {
              const targetWeight = Number(event.target.value);
              const match = resolveExactFontFace(fonts, {
                family: selectedFont.family,
                weight: targetWeight,
                italic: getFontItalic(selectedFont),
              });
              if (match.success) {
                setFontId(match.font.id);
                invalidatePreview();
              } else {
                setError(match.reason);
              }
            }}
            disabled={disabled || previewing || applying || !canReplace || formatDirty}
          >
            {availableWeights.map(w => (
              <option key={w} value={w}>
                {STANDARD_WEIGHT_OPTIONS.find(o => o.value === w)?.label ?? `Weight ${w}`}
              </option>
            ))}
          </select></label>
          <label>Replacement posture<select
            value={getFontItalic(selectedFont) ? 'italic' : 'normal'}
            onChange={event => {
              const targetItalic = event.target.value === 'italic';
              const match = resolveExactFontFace(fonts, {
                family: selectedFont.family,
                weight: getFontWeight(selectedFont),
                italic: targetItalic,
              });
              if (match.success) {
                setFontId(match.font.id);
                invalidatePreview();
              } else {
                setError(match.reason);
              }
            }}
            disabled={disabled || previewing || applying || !canReplace || formatDirty}
          >
            <option value="normal">Regular (Upright)</option>
            <option value="italic">Italic{!hasItalic ? ' (Unavailable)' : ''}</option>
          </select></label>
        </div>
      );
    })()}
    {document?.capabilities.includes('text.style') && <fieldset disabled={disabled || previewing || applying || !canReplace || replacement !== targetText || Boolean(fontId)}>
      <legend>Format selected text</legend>
      <p>{selectedObject?.locator.containerPath.length
        ? 'Format selected characters inside this Form instance. Other shared instances stay unchanged; changes must fit the parent clipping bounds.'
        : block.isParagraph
          ? 'Format the selected characters in this logical paragraph. The native preview rejects changes that overflow its box.'
          : 'Applies only to the selected characters. Blank fields preserve existing formatting. Font or size changes move the remaining text on this line; they do not wrap the paragraph.'}</p>
      <label>Selection font<select value={formatFontId} onChange={event => { setFormatFontId(event.target.value); setError(''); }}>
        <option value="">Preserve font</option>
        {fonts.map(font => <option key={font.id} value={font.id}>{font.family} · {font.style}</option>)}
      </select></label>
      <div className="document-tools-grid">
        <label>Selection weight<select
          value={formatWeight}
          onChange={event => {
            setFormatWeight(event.target.value ? Number(event.target.value) : '');
            setError('');
          }}
        >
          <option value="">Preserve weight</option>
          {STANDARD_WEIGHT_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select></label>
        <label>Selection posture<select
          value={formatItalic}
          onChange={event => {
            setFormatItalic(event.target.value as '' | 'on' | 'off');
            setError('');
          }}
        >
          <option value="">Preserve posture</option>
          <option value="off">Regular (Upright)</option>
          <option value="on">Italic</option>
        </select></label>
      </div>
      <label>Selection font size<input type="number" min="0.1" max="1000" step="0.1" value={formatSize} onChange={event => setFormatSize(event.target.value)} placeholder="Preserve size" /></label>
      <label>Selection color<input value={formatColor} onChange={event => setFormatColor(event.target.value)} placeholder="#RRGGBB" /></label>
      <label>Selection character spacing<input type="number" step="0.1" value={formatSpacing} onChange={event => setFormatSpacing(event.target.value)} placeholder="Preserve spacing" /></label>
      <label>Selection underline<select value={formatUnderline}
        onChange={event => setFormatUnderline(event.target.value as '' | 'on' | 'off')}>
        <option value="">Preserve underline</option><option value="on">Underline</option><option value="off">Remove underline</option>
      </select></label>
      <button type="button" disabled={!formatDirty} onClick={() => void formatSelection()}>Apply selection format</button>
    </fieldset>}
    {fontError ? <p role="alert">{fontError}; original font remains available.</p> : null}
    {!canReplace ? <p role="alert">{block.editability === 'geometry-only'
      ? 'This TextBlock cannot be edited directly.'
      : 'The current PDF core does not provide real text replacement.'}</p> : null}
    <div className="text-edit-actions">
      <button type="button" onClick={() => void runPreview()} disabled={disabled || !canReplace || previewing || applying}>
        {previewing ? 'Previewing…' : 'Preview layout'}
      </button>
      <button type="button" onClick={() => void commit()} disabled={disabled || !preview || preview.overflow || previewing || applying || formatDirty}>
        {applying ? 'Committing…' : 'Commit replacement'}
      </button>
      <button type="button" disabled={disabled || previewing || applying || !draftDirty} onClick={discardDraft}>Discard draft</button>
    </div>
    {preview ? <div className={preview.overflow ? 'layout-result layout-result-overflow' : 'layout-result'}>
      <strong>{preview.overflow ? 'Overflow detected' : 'Fits current text bounds'}</strong>
      <span>Bounds: {formatNumber(preview.bounds.x)}, {formatNumber(preview.bounds.y)} · {formatNumber(preview.bounds.width)} × {formatNumber(preview.bounds.height)}</span>
      <span>{preview.lines.length} line{preview.lines.length === 1 ? '' : 's'}</span>
      {preview.replacementFontId ? <span>Core font: {preview.replacementFontId}</span> : null}
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

// Chromium does not provide caret navigation in a readonly textarea.
// Keep source text immutable while allowing keyboard range selection.
function moveReadOnlySelection(event: KeyboardEvent<HTMLTextAreaElement>): void {
  const { key, shiftKey, ctrlKey, metaKey, altKey } = event;
  if (altKey || event.nativeEvent.isComposing) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
  if ((ctrlKey || metaKey) && (key === 'ArrowLeft' || key === 'ArrowRight')) return;
  event.preventDefault();
  const element = event.currentTarget;
  const { selectionStart: start, selectionEnd: end, selectionDirection, value } = element;
  const backward = selectionDirection === 'backward';
  const anchor = backward ? end : start;
  const focus = backward ? start : end;
  let next: number;
  if (key === 'Home') next = 0;
  else if (key === 'End') next = value.length;
  else if (!shiftKey && start !== end) next = key === 'ArrowLeft' ? start : end;
  else {
    const boundaries = [...graphemeBoundaries(value)].sort((a, b) => a - b);
    next = key === 'ArrowLeft'
      ? boundaries.findLast(position => position < focus) ?? 0
      : boundaries.find(position => position > focus) ?? value.length;
  }
  if (shiftKey) element.setSelectionRange(Math.min(anchor, next), Math.max(anchor, next), next < anchor ? 'backward' : 'forward');
  else element.setSelectionRange(next, next);
}

function snapGraphemeSelection(element: HTMLTextAreaElement): void {
  const boundaries = [...graphemeBoundaries(element.value)].sort((a, b) => a - b);
  const { selectionStart: start, selectionEnd: end, selectionDirection } = element;
  const before = (position: number) => boundaries.findLast(boundary => boundary <= position) ?? 0;
  const after = (position: number) => boundaries.find(boundary => boundary >= position) ?? element.value.length;
  const snappedStart = before(start);
  const snappedEnd = start === end
    ? (start - snappedStart < after(start) - start ? snappedStart : after(start))
    : after(end);
  if (start !== snappedStart || end !== snappedEnd) {
    element.setSelectionRange(start === end ? snappedEnd : snappedStart, snappedEnd, selectionDirection);
  }
}

function moveEditableSelection(event: KeyboardEvent<HTMLTextAreaElement>, onChange: (text: string) => void): void {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    moveReadOnlySelection(event);
    return;
  }
  if (!['Backspace', 'Delete'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  const element = event.currentTarget;
  snapGraphemeSelection(element);
  const boundaries = [...graphemeBoundaries(element.value)].sort((a, b) => a - b);
  let start = element.selectionStart;
  let end = element.selectionEnd;
  if (start === end) {
    if (event.key === 'Backspace') start = boundaries.findLast(boundary => boundary < start) ?? 0;
    else end = boundaries.find(boundary => boundary > end) ?? element.value.length;
  }
  event.preventDefault();
  element.setRangeText('', start, end, 'start');
  onChange(element.value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatError(error: unknown): string {
  if (error instanceof EngineError) return `${error.code} · ${error.message}`;
  return error instanceof Error ? error.message : 'Operation failed';
}

export type SelectionFormatOptions = {
  block: TextBlock;
  range: TextRange;
  fonts: readonly EditorFont[];
  formatFontId?: string;
  formatWeight?: number | '';
  formatItalic?: '' | 'on' | 'off';
  formatSize?: string;
  formatSpacing?: string;
  formatColor?: string;
  formatUnderline?: '' | 'on' | 'off';
};

export function resolveSelectionFormatRuns(options: SelectionFormatOptions): {
  range: TextRange; style: TextStyle; resolvedFontId?: string;
}[] {
  const { block, range, fonts } = options;
  const changingFace = (options.formatWeight !== undefined && options.formatWeight !== '') ||
    (options.formatItalic !== undefined && options.formatItalic !== '');
  if (!block.isParagraph || options.formatFontId || !changingFace ||
      findSelectionFontInfo(block, range, fonts)) {
    return [{ range, ...resolveSelectionFormatStyle(options) }];
  }
  let offset = 0;
  const formats: { range: TextRange; style: TextStyle; resolvedFontId?: string }[] = [];
  for (const run of block.runs) {
    const start = Math.max(range[0], offset);
    offset += run.text.length;
    const end = Math.min(range[1], offset);
    if (start >= end) continue;
    const part: TextRange = [start, end];
    formats.push({ range: part, ...resolveSelectionFormatStyle({ ...options, range: part }) });
  }
  if (!formats.length) throw new EngineError('INVALID_REQUEST', 'Select text to format');
  return formats;
}

export function resolveSelectionFormatStyle({
  block,
  range,
  fonts,
  formatFontId = '',
  formatWeight = '',
  formatItalic = '',
  formatSize = '',
  formatSpacing = '',
  formatColor = '',
  formatUnderline = '',
}: SelectionFormatOptions): { style: TextStyle; resolvedFontId?: string } {
  let resolvedFontId = formatFontId;
  if (formatWeight !== '' || formatItalic !== '') {
    let targetFamily = '';
    let baseWeight = 400;
    let baseItalic = false;

    if (formatFontId) {
      const chosen = fonts.find(f => f.id === formatFontId);
      if (chosen) {
        targetFamily = chosen.family;
        baseWeight = getFontWeight(chosen);
        baseItalic = getFontItalic(chosen);
      }
    } else {
      const selectionInfo = findSelectionFontInfo(block, range, fonts);
      if (!selectionInfo) {
        throw new EngineError(
          'INVALID_REQUEST',
          'Cannot apply weight or italic without selecting a registered font: the selected text uses an unregistered or mixed font. Please select a registered Selection font first.'
        );
      }
      targetFamily = selectionInfo.family;
      baseWeight = selectionInfo.weight;
      baseItalic = selectionInfo.italic;
    }

    const targetWeight = formatWeight !== '' ? formatWeight : baseWeight;
    const targetItalic = formatItalic !== '' ? formatItalic === 'on' : baseItalic;

    const match = resolveExactFontFace(fonts, {
      family: targetFamily,
      weight: targetWeight,
      italic: targetItalic,
    });

    if (!match.success) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', match.reason);
    }

    resolvedFontId = match.font.id;
  }

  if (resolvedFontId) {
    const targetFont = fonts.find(f => f.id === resolvedFontId);
    if (targetFont && !isFontEmbeddable(targetFont)) {
      throw new EngineError('INVALID_REQUEST', `Font face "${targetFont.family} · ${targetFont.style}" is restricted from editable embedding by font flags.`);
    }
  }

  const style: TextStyle = {};
  if (resolvedFontId) style.fontId = resolvedFontId;
  if (formatSize) style.fontSize = Number(formatSize);
  if (formatSpacing) style.characterSpacing = Number(formatSpacing);
  if (formatUnderline) style.underline = formatUnderline === 'on';
  if (formatColor) {
    if (!/^#[0-9a-f]{6}$/i.test(formatColor)) throw new EngineError('INVALID_REQUEST', 'Color must use #RRGGBB');
    style.color = [1, 3, 5].map(offset => parseInt(formatColor.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  }

  return { style, ...(resolvedFontId ? { resolvedFontId } : {}) };
}
