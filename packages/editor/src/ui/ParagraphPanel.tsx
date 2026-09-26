import { translate as t, useI18n } from './i18n.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandRegistry, validateTransaction, type CommandContext } from '@pdf-editor/commands';
import {
  EngineError,
  type CommitResult,
  type DocumentInfo,
  type EditCommand,
  type EditTransaction,
  type EngineAdapter,
  type PageModel,
  type ReflowTextStyle,
  type TextLayoutResult,
} from '@pdf-editor/contracts';
import {
  useFontResources,
  resolveExactFontFace,
  getFontWeight,
  getFontItalic,
  getAvailableWeightsForFamily,
  familySupportsItalic,
  isFontEmbeddable,
  STANDARD_WEIGHT_OPTIONS,
} from './font-resources.js';

export type ParagraphPanelProps = {
  document: DocumentInfo | null;
  page: PageModel | null;
  selectedIds: string[];
  engine: EngineAdapter;
  disabled?: boolean;
  onBusyChange?(busy: boolean): void;
  onDraftChange?(dirty: boolean): void;
  onCommitted(result: CommitResult): Promise<void>;
};

export function ParagraphPanel({
  document,
  page,
  selectedIds,
  engine,
  disabled = false,
  onBusyChange,
  onDraftChange,
  onCommitted,
}: ParagraphPanelProps) {
  useI18n();
  const [text, setText] = useState('');
  const [fontId, setFontId] = useState('');
  const [fontSize, setFontSize] = useState('18');
  const [lineHeight, setLineHeight] = useState('1.2');
  const [alignment, setAlignment] = useState<'left' | 'center' | 'right' | 'justify'>('left');
  const [color, setColor] = useState('#000000');
  const [characterSpacing, setCharacterSpacing] = useState('');
  const [underline, setUnderline] = useState(false);

  const [x, setX] = useState('36');
  const [y, setY] = useState('36');
  const [width, setWidth] = useState('280');
  const [height, setHeight] = useState('140');

  const [preview, setPreview] = useState<TextLayoutResult | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { fonts, error: fontError } = useFontResources(engine);
  const chosenFontId = fontId || fonts[0]?.id || '';
  const chosenFont = useMemo(() => fonts.find(f => f.id === chosenFontId) ?? null, [fonts, chosenFontId]);
  const availableWeights = useMemo(() => {
    if (!chosenFont) return [];
    return getAvailableWeightsForFamily(fonts, chosenFont.family);
  }, [fonts, chosenFont]);
  const canItalic = useMemo(() => {
    if (!chosenFont) return false;
    return familySupportsItalic(fonts, chosenFont.family);
  }, [fonts, chosenFont]);

  const scope = `${document?.id ?? ''}\0${document?.revision ?? ''}\0${page?.id ?? ''}`;
  const scopeRef = useRef(scope);
  const previewSequence = useRef(0);
  scopeRef.current = scope;
  useEffect(() => {
    setText(''); setPreview(null); setPreviewKey(''); setPreviewing(false); setError('');
    return () => { previewSequence.current += 1; };
  }, [scope]);

  const selectedTextObjects = useMemo(() => {
    if (!page) return [];
    return page.objects.filter(
      obj =>
        selectedIds.includes(obj.id) &&
        obj.type === 'text' &&
        (obj.locator?.containerPath?.length ?? 0) === 0 &&
        Boolean(obj.textBlock) &&
        !obj.textBlock?.isOcr &&
        obj.textBlock?.editability !== 'geometry-only'
    );
  }, [page, selectedIds]);

  const selectedBounds = useMemo(() => {
    if (selectedTextObjects.length === 0) return null;
    const minX = Math.min(...selectedTextObjects.map(o => o.bounds.x));
    const minY = Math.min(...selectedTextObjects.map(o => o.bounds.y));
    const maxX = Math.max(...selectedTextObjects.map(o => o.bounds.x + o.bounds.width));
    const maxY = Math.max(...selectedTextObjects.map(o => o.bounds.y + o.bounds.height));
    return {
      x: roundCoord(minX),
      y: roundCoord(minY),
      width: roundCoord(maxX - minX),
      height: roundCoord(maxY - minY),
    };
  }, [selectedTextObjects]);

  const clearPreview = () => {
    setPreview(null);
    setPreviewKey('');
    setError('');
  };

  const handleUseSelectedText = () => {
    if (selectedTextObjects.length === 0) return;
    const merged = selectedTextObjects
      .map(obj => obj.textBlock!.runs.map(r => r.text).join(''))
      .join('\n');
    setText(merged);
    if (selectedBounds) {
      setX(String(selectedBounds.x));
      setY(String(selectedBounds.y));
      setWidth(String(selectedBounds.width));
      setHeight(String(selectedBounds.height));
    }
    clearPreview();
  };

  const currentLayoutKey = useMemo(() => {
    return JSON.stringify([
      scope,
      text,
      chosenFontId,
      Number(fontSize),
      Number(lineHeight),
      alignment,
      color,
      characterSpacing,
      underline,
      Number(x),
      Number(y),
      Number(width),
      Number(height),
      selectedTextObjects.map(o => o.textBlock!.id),
    ]);
  }, [scope, text, chosenFontId, fontSize, lineHeight, alignment, color, characterSpacing, underline, x, y, width, height, selectedTextObjects]);

  const draftDirty = Boolean(text.trim() || preview !== null);
  useEffect(() => {
    onDraftChange?.(draftDirty);
  }, [draftDirty, onDraftChange]);
  useEffect(() => () => {
    onDraftChange?.(false);
  }, [onDraftChange]);

  const locked = disabled || busy || previewing;
  const supportsParagraph = Boolean(document?.capabilities.includes('text.reflow') && engine.previewTextInsert);
  const numX = parseNumber(x);
  const numY = parseNumber(y);
  const numWidth = parseNumber(width);
  const numHeight = parseNumber(height);
  const numFontSize = Number(fontSize);
  const numLineHeight = Number(lineHeight);
  const validBounds = numWidth > 0 && numHeight > 0 && Number.isFinite(numX) && Number.isFinite(numY)
    && Number.isFinite(numFontSize) && numFontSize > 0 && numFontSize <= 1000
    && Number.isFinite(numLineHeight) && numLineHeight > 0;

  const isPreviewCurrent = preview !== null && previewKey === currentLayoutKey;
  const canModify = supportsParagraph && Boolean(document?.permissions.modify);
  const fontEmbeddable = !chosenFont || isFontEmbeddable(chosenFont);
  const canReflow =
    isPreviewCurrent &&
    !preview.overflow &&
    selectedTextObjects.length > 0 &&
    canModify &&
    validBounds &&
    Boolean(chosenFontId) &&
    fontEmbeddable &&
    !locked;

  const canInsert =
    isPreviewCurrent &&
    !preview.overflow &&
    text.trim().length > 0 &&
    canModify &&
    validBounds &&
    Boolean(chosenFontId) &&
    fontEmbeddable &&
    !locked;

  const buildStyle = (): ReflowTextStyle =>
    buildParagraphStyle({
      fontId: chosenFontId,
      fontSize: numFontSize,
      color,
      lineHeight: numLineHeight,
      alignment,
      underline,
      characterSpacing,
    });

  const runPreview = async (): Promise<void> => {
    if (!document || !page || !chosenFontId || locked || previewing) return;
    if (chosenFont && !isFontEmbeddable(chosenFont)) {
      setError(`Font face "${chosenFont.family} · ${chosenFont.style}" is restricted from editable embedding by font flags.`);
      return;
    }
    if (!text.trim()) {
      setError('Enter paragraph text before previewing.');
      return;
    }
    if (!validBounds) {
      setError('Enter valid positive dimensions for the paragraph box.');
      return;
    }
    if (!engine.previewTextInsert) {
      setError('The current engine core does not support paragraph preview.');
      return;
    }
    const key = currentLayoutKey;
    const sequence = ++previewSequence.current;
    setPreviewing(true);
    setError('');
    try {
      const bounds = { x: numX, y: numY, width: numWidth, height: numHeight };
      const command =
        selectedTextObjects.length > 0
          ? ({
              type: 'text.reflow' as const,
              pageId: page.id,
              objectId: crypto.randomUUID(),
              blockIds: selectedTextObjects.map(o => o.textBlock!.id),
              bounds,
              text,
              style: buildStyle(),
            })
          : ({
              type: 'text.insert' as const,
              pageId: page.id,
              objectId: crypto.randomUUID(),
              bounds,
              text,
              style: buildStyle(),
              paragraph: true,
            });
      const layout = await engine.previewTextInsert({
        docId: document.id,
        baseRevision: document.revision,
        command,
      });
      if (sequence !== previewSequence.current || scopeRef.current !== scope) return;
      setPreview(layout);
      setPreviewKey(key);
    } catch (caught) {
      if (sequence === previewSequence.current && scopeRef.current === scope) {
        setPreview(null); setPreviewKey(''); setError(formatError(caught));
      }
    } finally {
      if (sequence === previewSequence.current) setPreviewing(false);
    }
  };

  const handleReflow = async (): Promise<void> => {
    if (!document || !page || !canReflow) return;
    const expectedScope = scope;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      const bounds = { x: numX, y: numY, width: numWidth, height: numHeight };
      const command: EditCommand = {
        type: 'text.reflow',
        pageId: page.id,
        objectId: crypto.randomUUID(),
        blockIds: selectedTextObjects.map(o => o.textBlock!.id),
        bounds,
        text,
        style: buildStyle(),
      };
      const transaction: EditTransaction = {
        id: crypto.randomUUID(),
        docId: document.id,
        baseRevision: document.revision,
        source: 'manual',
        commands: [command],
      };
      const context: CommandContext = {
        document,
        pages: new Map([[page.id, page]]),
        fontIds: new Set(fonts.map(f => f.id)),
      };
      validateTransaction(transaction, context);
      await engine.previewTransaction(transaction);
      if (scopeRef.current !== expectedScope) {
        throw new Error('The document changed while previewing this edit');
      }
      const registry = new CommandRegistry(engine);
      const result = await registry.execute(transaction, context);
      await onCommitted(result);
      setText('');
      setPreview(null);
      setPreviewKey('');
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const handleInsert = async (): Promise<void> => {
    if (!document || !page || !canInsert) return;
    const expectedScope = scope;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      const bounds = { x: numX, y: numY, width: numWidth, height: numHeight };
      const command: EditCommand = {
        type: 'text.insert',
        pageId: page.id,
        objectId: crypto.randomUUID(),
        bounds,
        text,
        style: buildStyle(),
        paragraph: true,
      };
      const transaction: EditTransaction = {
        id: crypto.randomUUID(),
        docId: document.id,
        baseRevision: document.revision,
        source: 'manual',
        commands: [command],
      };
      const context: CommandContext = {
        document,
        pages: new Map([[page.id, page]]),
        fontIds: new Set(fonts.map(f => f.id)),
      };
      validateTransaction(transaction, context);
      await engine.previewTransaction(transaction);
      if (scopeRef.current !== expectedScope) {
        throw new Error('The document changed while previewing this edit');
      }
      const registry = new CommandRegistry(engine);
      const result = await registry.execute(transaction, context);
      await onCommitted(result);
      setText('');
      setPreview(null);
      setPreviewKey('');
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const handleDiscard = () => {
    setText('');
    setPreview(null);
    setPreviewKey('');
    setError('');
  };

  if (!document || !page) {
    return (
      <section className="text-edit-panel" aria-label="Paragraph reflow and insertion">
        <span className="eyebrow">{t("Paragraph")}</span>
        <p>{t("Open a document to insert or reflow paragraphs.")}</p>
      </section>
    );
  }

  if (!supportsParagraph) return null;

  return (
    <section className="text-edit-panel" aria-label={t("Paragraph")}><details><summary>{t("Paragraph")}</summary>
      <span className="eyebrow">{t("Paragraph")}</span>
      <p>{t("Combine selected lines or add a new paragraph.")}</p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontSize: '11px', color: '#646761' }}>
          {selectedTextObjects.length > 0
            ? `${selectedTextObjects.length} text object${selectedTextObjects.length === 1 ? '' : 's'} selected`
            : t("No text objects selected")}
        </span>
        <button
          type="button"
          disabled={locked || selectedTextObjects.length === 0}
          onClick={handleUseSelectedText}
          style={{ minHeight: '28px', padding: '4px 8px', fontSize: '10px' }}
        >{t("Use selected text")}</button>
      </div>

      <label>{t("Paragraph text")}<textarea
          value={text}
          onChange={e => {
            setText(e.target.value);
            clearPreview();
          }}
          disabled={locked}
          placeholder={t("Enter paragraph text or use selected text above…")}
          rows={4}
        />
      </label>

      <div className="document-tools-grid">
        <label>{t("Box X (pt)")}<input
            type="number"
            step="0.5"
            value={x}
            onChange={e => {
              setX(e.target.value);
              clearPreview();
            }}
            disabled={locked}
          />
        </label>
        <label>{t("Box Y (pt)")}<input
            type="number"
            step="0.5"
            value={y}
            onChange={e => {
              setY(e.target.value);
              clearPreview();
            }}
            disabled={locked}
          />
        </label>
      </div>

      <div className="document-tools-grid">
        <label>{t("Box Width (pt)")}<input
            type="number"
            min="1"
            step="0.5"
            value={width}
            onChange={e => {
              setWidth(e.target.value);
              clearPreview();
            }}
            disabled={locked}
          />
        </label>
        <label>{t("Box Height (pt)")}<input
            type="number"
            min="1"
            step="0.5"
            value={height}
            onChange={e => {
              setHeight(e.target.value);
              clearPreview();
            }}
            disabled={locked}
          />
        </label>
      </div>

      <label>{t("Font")}<select
          value={chosenFontId}
          onChange={e => {
            setFontId(e.target.value);
            clearPreview();
          }}
          disabled={locked}
        >
          {fonts.map(font => (
            <option key={font.id} value={font.id}>
              {font.family} · {font.style}
            </option>
          ))}
        </select>
      </label>

      {chosenFont && (
        <div className="document-tools-grid">
          <label>{t("Font weight")}<select
              value={getFontWeight(chosenFont)}
              onChange={e => {
                const targetWeight = Number(e.target.value);
                const match = resolveExactFontFace(fonts, {
                  family: chosenFont.family,
                  weight: targetWeight,
                  italic: getFontItalic(chosenFont),
                });
                if (match.success) {
                  setFontId(match.font.id);
                  clearPreview();
                } else {
                  setError(match.reason);
                }
              }}
              disabled={locked}
            >
              {availableWeights.map(w => (
                <option key={w} value={w}>
                  {STANDARD_WEIGHT_OPTIONS.find(o => o.value === w)?.label ?? `Weight ${w}`}
                </option>
              ))}
            </select>
          </label>
          <label>{t("Font posture")}<select
              value={getFontItalic(chosenFont) ? 'italic' : 'normal'}
              onChange={e => {
                const targetItalic = e.target.value === 'italic';
                const match = resolveExactFontFace(fonts, {
                  family: chosenFont.family,
                  weight: getFontWeight(chosenFont),
                  italic: targetItalic,
                });
                if (match.success) {
                  setFontId(match.font.id);
                  clearPreview();
                } else {
                  setError(match.reason);
                }
              }}
              disabled={locked}
            >
              <option value="normal">{t("Regular (Upright)")}</option>
              <option value="italic">{t("Italic")}{!canItalic ? ' (Unavailable)' : ''}
              </option>
            </select>
          </label>
        </div>
      )}

      <div className="document-tools-grid">
        <label>{t("Font size (pt)")}<input
            type="number"
            min="1"
            max="1000"
            step="0.5"
            value={fontSize}
            onChange={e => {
              setFontSize(e.target.value);
              clearPreview();
            }}
            disabled={locked}
          />
        </label>
        <label>{t("Line height")}<input
            type="number"
            min="0.5"
            max="10"
            step="0.1"
            value={lineHeight}
            onChange={e => {
              setLineHeight(e.target.value);
              clearPreview();
            }}
            disabled={locked}
          />
        </label>
      </div>

      <div className="document-tools-grid">
        <label>{t("Alignment")}<select
            value={alignment}
            onChange={e => {
              setAlignment(e.target.value as 'left' | 'center' | 'right' | 'justify');
              clearPreview();
            }}
            disabled={locked}
          >
            <option value="left">{t("Left")}</option>
            <option value="center">{t("Center")}</option>
            <option value="right">{t("Right")}</option>
            <option value="justify">{t("Justify")}</option>
          </select>
        </label>
        <label>{t("Color")}<input
            value={color}
            onChange={e => {
              setColor(e.target.value);
              clearPreview();
            }}
            placeholder="#000000"
            disabled={locked}
          />
        </label>
      </div>

      <label>{t("Character spacing (pt)")}<input
          type="number"
          step="0.1"
          value={characterSpacing}
          onChange={e => {
            setCharacterSpacing(e.target.value);
            clearPreview();
          }}
          placeholder="0 (optional)"
          disabled={locked}
        />
      </label>
      <label><input type="checkbox" checked={underline} disabled={locked}
        onChange={event => { setUnderline(event.target.checked); clearPreview(); }} />{t("Underline paragraph")}</label>

      <div className="text-edit-actions">
        <button
          type="button"
          onClick={() => void runPreview()}
          disabled={locked || previewing || !text.trim() || !chosenFontId || !validBounds}
        >
          {previewing ? t("Previewing…") : t("Preview paragraph")}
        </button>
        <button
          type="button"
          disabled={locked || (!draftDirty && !preview)}
          onClick={handleDiscard}
        >{t("Discard draft")}</button>
      </div>

      {preview ? (
        <div className={preview.overflow ? 'layout-result layout-result-overflow' : 'layout-result'}>
          <strong>{preview.overflow ? t("Overflow detected (does not fit bounds)") : t("Fits paragraph bounds")}</strong>
          <span>{t("Lines:")} {preview.lines.length} {t("· Box:")} {formatNumber(preview.bounds.width)} × {formatNumber(preview.bounds.height)} pt
          </span>
          {preview.replacementFontId ? <span>{t("Core font:")} {preview.replacementFontId}</span> : null}
        </div>
      ) : null}

      <div className="text-edit-actions">
        <button
          type="button"
          onClick={() => void handleReflow()}
          disabled={!canReflow}
          title={
            selectedTextObjects.length === 0
              ? 'Select one or more text objects to reflow'
              : !isPreviewCurrent
              ? t("Preview paragraph first")
              : preview?.overflow
              ? t("Fix overflow before reflowing")
              : t("Reflow selected text objects into one paragraph")
          }
        >
          {busy ? t("Reflowing…") : t("Reflow selected text")}
        </button>
        <button
          type="button"
          onClick={() => void handleInsert()}
          disabled={!canInsert}
          title={
            !isPreviewCurrent
              ? t("Preview paragraph first")
              : preview?.overflow
              ? t("Fix overflow before inserting")
              : t("Insert as a new paragraph")
          }
        >
          {busy ? t("Inserting…") : t("Insert paragraph")}
        </button>
      </div>



      {error ? <p role="alert">{t(error)}</p> : null}
      {fontError ? <p role="alert">{t(fontError)}</p> : null}
    </details></section>
  );
}

function parseNumber(value: string, fallback = 0): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundCoord(val: number): number {
  return Math.round(val * 100) / 100;
}

function formatNumber(val: number): string {
  return Number.isInteger(val) ? String(val) : val.toFixed(2);
}

function parseRgb(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return [0, 0, 0];
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function formatError(error: unknown): string {
  if (error instanceof EngineError) return `${error.code} · ${error.message}`;
  return error instanceof Error ? error.message : 'Operation failed';
}

export type BuildParagraphStyleOptions = {
  fontId: string;
  fontSize: number;
  color?: string;
  lineHeight?: number;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  underline?: boolean;
  characterSpacing?: string;
};

export function buildParagraphStyle({
  fontId,
  fontSize,
  color,
  lineHeight,
  alignment,
  underline,
  characterSpacing,
}: BuildParagraphStyleOptions): ReflowTextStyle {
  return {
    fontId,
    fontSize,
    ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color: parseRgb(color) } : {}),
    ...(lineHeight !== undefined && Number.isFinite(lineHeight) && lineHeight > 0 ? { lineHeight } : {}),
    ...(alignment ? { alignment } : {}),
    ...(underline !== undefined ? { underline } : {}),
    ...(characterSpacing && characterSpacing.trim() && Number.isFinite(parseFloat(characterSpacing))
      ? { characterSpacing: parseFloat(characterSpacing) }
      : {}),
  };
}
