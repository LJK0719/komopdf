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
import { useFontResources } from './font-resources.js';

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
  const [text, setText] = useState('');
  const [fontId, setFontId] = useState('');
  const [fontSize, setFontSize] = useState('18');
  const [lineHeight, setLineHeight] = useState('1.2');
  const [alignment, setAlignment] = useState<'left' | 'center' | 'right'>('left');
  const [color, setColor] = useState('#000000');
  const [characterSpacing, setCharacterSpacing] = useState('');

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
      Number(x),
      Number(y),
      Number(width),
      Number(height),
      selectedTextObjects.map(o => o.textBlock!.id),
    ]);
  }, [scope, text, chosenFontId, fontSize, lineHeight, alignment, color, characterSpacing, x, y, width, height, selectedTextObjects]);

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
  const canReflow =
    isPreviewCurrent &&
    !preview.overflow &&
    selectedTextObjects.length > 0 &&
    canModify &&
    validBounds &&
    Boolean(chosenFontId) &&
    !locked;

  const canInsert =
    isPreviewCurrent &&
    !preview.overflow &&
    text.trim().length > 0 &&
    canModify &&
    validBounds &&
    Boolean(chosenFontId) &&
    !locked;

  const buildStyle = (): ReflowTextStyle => ({
    fontId: chosenFontId,
    fontSize: numFontSize,
    ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color: parseRgb(color) } : {}),
    lineHeight: numLineHeight,
    alignment,
    ...(characterSpacing.trim() && Number.isFinite(parseFloat(characterSpacing))
      ? { characterSpacing: parseFloat(characterSpacing) }
      : {}),
  });

  const runPreview = async (): Promise<void> => {
    if (!document || !page || !chosenFontId || locked || previewing) return;
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
        <span className="eyebrow">Paragraph Reflow & Insert</span>
        <p>Open a document to insert or reflow paragraphs.</p>
      </section>
    );
  }

  if (!supportsParagraph) return null;

  return (
    <section className="text-edit-panel" aria-label="Paragraph reflow and insertion">
      <span className="eyebrow">Paragraph Reflow & Insert</span>
      <p>
        Reflow multiple selected text lines into a native ICU paragraph or insert a new paragraph.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontSize: '11px', color: '#646761' }}>
          {selectedTextObjects.length > 0
            ? `${selectedTextObjects.length} text object${selectedTextObjects.length === 1 ? '' : 's'} selected`
            : 'No text objects selected'}
        </span>
        <button
          type="button"
          disabled={locked || selectedTextObjects.length === 0}
          onClick={handleUseSelectedText}
          style={{ minHeight: '28px', padding: '4px 8px', fontSize: '10px' }}
        >
          Use selected text
        </button>
      </div>

      <label>
        Paragraph text
        <textarea
          value={text}
          onChange={e => {
            setText(e.target.value);
            clearPreview();
          }}
          disabled={locked}
          placeholder="Enter paragraph text or use selected text above…"
          rows={4}
        />
      </label>

      <div className="document-tools-grid">
        <label>
          Box X (pt)
          <input
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
        <label>
          Box Y (pt)
          <input
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
        <label>
          Box Width (pt)
          <input
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
        <label>
          Box Height (pt)
          <input
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

      <label>
        Font
        <select
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

      <div className="document-tools-grid">
        <label>
          Font size (pt)
          <input
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
        <label>
          Line height
          <input
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
        <label>
          Alignment
          <select
            value={alignment}
            onChange={e => {
              setAlignment(e.target.value as 'left' | 'center' | 'right');
              clearPreview();
            }}
            disabled={locked}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label>
          Color
          <input
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

      <label>
        Character spacing (pt)
        <input
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

      <div className="text-edit-actions">
        <button
          type="button"
          onClick={() => void runPreview()}
          disabled={locked || previewing || !text.trim() || !chosenFontId || !validBounds}
        >
          {previewing ? 'Previewing…' : 'Preview paragraph'}
        </button>
        <button
          type="button"
          disabled={locked || (!draftDirty && !preview)}
          onClick={handleDiscard}
        >
          Discard draft
        </button>
      </div>

      {preview ? (
        <div className={preview.overflow ? 'layout-result layout-result-overflow' : 'layout-result'}>
          <strong>{preview.overflow ? 'Overflow detected (does not fit bounds)' : 'Fits paragraph bounds'}</strong>
          <span>
            Lines: {preview.lines.length} · Box: {formatNumber(preview.bounds.width)} × {formatNumber(preview.bounds.height)} pt
          </span>
          {preview.replacementFontId ? <span>Core font: {preview.replacementFontId}</span> : null}
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
              ? 'Preview paragraph first'
              : preview?.overflow
              ? 'Fix overflow before reflowing'
              : 'Reflow selected text objects into one paragraph'
          }
        >
          {busy ? 'Reflowing…' : 'Reflow selected text'}
        </button>
        <button
          type="button"
          onClick={() => void handleInsert()}
          disabled={!canInsert}
          title={
            !isPreviewCurrent
              ? 'Preview paragraph first'
              : preview?.overflow
              ? 'Fix overflow before inserting'
              : 'Insert as a new paragraph'
          }
        >
          {busy ? 'Inserting…' : 'Insert paragraph'}
        </button>
      </div>

      <p style={{ fontSize: '9px', color: '#777a74', margin: '4px 0 0' }}>
        Reflow operates only on adjacent top-level text blocks in content order. Cross-page or arbitrary non-adjacent layout detection is not supported.
      </p>

      {error ? <p role="alert">{error}</p> : null}
      {fontError ? <p role="alert">{fontError}</p> : null}
    </section>
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
