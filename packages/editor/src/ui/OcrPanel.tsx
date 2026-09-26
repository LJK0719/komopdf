import { translate as t, useI18n } from './i18n.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandRegistry } from '@pdf-editor/commands';
import {
  type CommitResult,
  type DocumentInfo,
  type EditCommand,
  type EditTransaction,
  type EngineAdapter,
  type Matrix,
  type PageModel,
  type Rect,
} from '@pdf-editor/contracts';
import { useFontResources } from './font-resources.js';

export type OcrPanelProps = {
  document: DocumentInfo;
  page: PageModel;
  selectedIds: string[];
  engine: EngineAdapter;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
  onCommitted(result: CommitResult): Promise<void>;
};

export type CandidateLine = {
  id: string;
  text: string;
  confidence: number;
  bounds: Rect;
  rotated180?: boolean | undefined;
  transform?: Matrix | undefined;
};

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function isValidBounds(b: Rect | undefined): b is Rect {
  return (
    Boolean(b) &&
    Number.isFinite(b!.x) &&
    Number.isFinite(b!.y) &&
    Number.isFinite(b!.width) &&
    Number.isFinite(b!.height) &&
    b!.width > 0 &&
    b!.height > 0
  );
}

export function OcrPanel({
  document,
  page,
  selectedIds,
  engine,
  disabled,
  onBusyChange,
  onCommitted,
}: OcrPanelProps) {
  useI18n();
  // If engine has no OCR capabilities, do not display panel
  if (!engine.recognizeOcr) {
    return null;
  }

  const [targetMode, setTargetMode] = useState<'current' | 'range'>('current');
  const [pageRangeInput, setPageRangeInput] = useState(() => {
    const idx = document.pageOrder.indexOf(page.id);
    return idx >= 0 ? String(idx + 1) : '1';
  });
  const [useImageRegion, setUseImageRegion] = useState(false);
  const [fontId, setFontId] = useState('');
  const [candidateLines, setCandidateLines] = useState<CandidateLine[]>([]);
  const [candidateBase, setCandidateBase] = useState<{
    docId: string;
    revision: number;
    pageId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const { fonts, error: fontError } = useFontResources(engine);

  // Prefer Noto CJK font faces for OCR searchable layer
  const defaultNotoCjkFont = useMemo(() => {
    return (
      fonts.find(f => /noto.*cjk/i.test(f.id) || /noto.*cjk/i.test(f.family)) ??
      fonts.find(f => /noto/i.test(f.id) || /noto/i.test(f.family)) ??
      fonts[0]
    );
  }, [fonts]);

  const chosenFontId = fontId || defaultNotoCjkFont?.id || '';

  // Single selected image check
  const selectedImage = useMemo(() => {
    if (selectedIds.length !== 1) return null;
    const obj = page.objects.find(o => o.id === selectedIds[0]);
    return obj?.type === 'image' ? obj : null;
  }, [page.objects, selectedIds]);

  // Existing text blocks on current page
  const existingTextObjects = useMemo(() => {
    return page.objects.filter(obj => obj.type === 'text' || Boolean(obj.textBlock));
  }, [page.objects]);
  const hasExistingText = existingTextObjects.length > 0;

  // Detect whether selected image region overlaps with any existing text block
  const selectedImageOverlapsExistingText = useMemo(() => {
    if (!selectedImage) return false;
    return existingTextObjects.some(textObj => rectsIntersect(selectedImage.bounds, textObj.bounds));
  }, [selectedImage, existingTextObjects]);

  // Track expected document identity to distinguish internal vs external revision advances
  const expectedDocIdRef = useRef(document.id);
  const expectedRevisionRef = useRef(document.revision);
  const expectedPageIdRef = useRef(page.id);

  const activeJobIdRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);

  // Clear stale results only on external changes; internal advances will match expectedRevisionRef
  useEffect(() => {
    const isExternalDoc = document.id !== expectedDocIdRef.current;
    const isExternalPage = page.id !== expectedPageIdRef.current;
    const isExternalRevision = document.revision !== expectedRevisionRef.current;

    expectedDocIdRef.current = document.id;
    expectedRevisionRef.current = document.revision;
    expectedPageIdRef.current = page.id;

    if (isExternalDoc || isExternalPage || isExternalRevision) {
      if (activeJobIdRef.current && engine.cancelOcr) {
        void engine.cancelOcr(activeJobIdRef.current).catch(() => undefined);
      }
      activeJobIdRef.current = null;
      stopRequestedRef.current = true;
      setCandidateLines([]);
      setCandidateBase(null);
      setError('');
      setStatusMessage('');
    }
  }, [document.id, document.revision, page.id, engine]);

  useEffect(() => () => {
    stopRequestedRef.current = true;
    const jobId = activeJobIdRef.current;
    if (jobId && engine.cancelOcr) void engine.cancelOcr(jobId).catch(() => undefined);
  }, [engine]);

  const locked = disabled || busy;
  const canWriteLayer = document.permissions.modify && document.capabilities.includes('text.insert')
    && document.capabilities.includes('objects.transform');

  async function handleStop(): Promise<void> {
    stopRequestedRef.current = true;
    const jobId = activeJobIdRef.current;
    if (jobId && engine.cancelOcr) {
      try {
        await engine.cancelOcr(jobId);
      } catch {
        // Ignore cancellation cleanup error
      }
    }
    setStatusMessage('Stopping… Already committed pages will be retained.');
  }

  async function runCurrentPageOcr(): Promise<void> {
    if (locked) return;

    if (hasExistingText) {
      if (!useImageRegion || !selectedImage) {
        setError('Page already contains text blocks. Full-page OCR is blocked to avoid duplicate text.');
        return;
      }
      if (selectedImageOverlapsExistingText) {
        setError('Selected image region overlaps with existing text blocks. OCR is blocked to avoid duplicate text.');
        return;
      }
    }

    const currentDocId = document.id;
    const currentRevision = document.revision;
    const currentPageId = page.id;

    const jobId = crypto.randomUUID();
    activeJobIdRef.current = jobId;
    stopRequestedRef.current = false;

    setBusy(true);
    onBusyChange(true);
    setError('');
    setStatusMessage('Recognizing current page…');

    try {
      const clip = useImageRegion && selectedImage ? { ...selectedImage.bounds } : undefined;
      const result = await engine.recognizeOcr!({
        docId: currentDocId,
        pageId: currentPageId,
        baseRevision: currentRevision,
        jobId,
        ...(clip ? { clip } : {}),
      });

      if (
        stopRequestedRef.current ||
        document.id !== currentDocId ||
        document.revision !== currentRevision ||
        page.id !== currentPageId
      ) {
        return;
      }

      const lines: CandidateLine[] = (result.lines || [])
        .filter(l => isValidBounds(l.bounds))
        .map((l, index) => {
          const lineTransform = (l as { transform?: Matrix }).transform;
          return {
            id: `ocr-line-${index}-${crypto.randomUUID()}`,
            text: l.text,
            confidence: l.confidence,
            bounds: {
              x: l.bounds.x,
              y: l.bounds.y,
              width: l.bounds.width,
              height: l.bounds.height,
            },
            ...(l.rotated180 !== undefined ? { rotated180: l.rotated180 } : {}),
            ...(lineTransform ? { transform: lineTransform } : {}),
          };
        });

      setCandidateLines(lines);
      setCandidateBase({
        docId: currentDocId,
        revision: currentRevision,
        pageId: currentPageId,
      });

      if (lines.length === 0) {
        setStatusMessage('No valid text lines detected in the specified area.');
      } else {
        setStatusMessage(`Recognized ${lines.length} text line(s). Review or edit below, then click "Add Searchable Text".`);
      }
    } catch (caught) {
      if (!stopRequestedRef.current) {
        setError(caught instanceof Error ? caught.message : 'OCR recognition failed');
        setStatusMessage('');
      }
    } finally {
      if (activeJobIdRef.current === jobId) {
        activeJobIdRef.current = null;
      }
      setBusy(false);
      onBusyChange(false);
    }
  }

  async function applyCandidates(): Promise<void> {
    if (locked || !canWriteLayer || candidateLines.length === 0) return;
    if (!candidateBase) {
      setError('No active candidates to apply.');
      return;
    }
    if (
      document.id !== candidateBase.docId ||
      document.revision !== candidateBase.revision ||
      page.id !== candidateBase.pageId
    ) {
      setError('The document or page has changed since OCR recognition. Candidates are stale and cannot be applied.');
      return;
    }
    if (!chosenFontId) {
      setError('A font must be selected to insert searchable text.');
      return;
    }

    const validLines = candidateLines.filter(
      line => line.text.trim().length > 0 && isValidBounds(line.bounds)
    );
    if (validLines.length === 0) {
      setError('No valid non-empty text lines to insert.');
      return;
    }

    setBusy(true);
    onBusyChange(true);
    setError('');
    setStatusMessage('Applying searchable text layer…');

    try {
      const commands: EditCommand[] = [];
      for (const line of validLines) {
        const objectId = crypto.randomUUID();
        commands.push({
          type: 'text.insert',
          pageId: page.id,
          objectId,
          bounds: {
            x: line.bounds.x,
            y: line.bounds.y,
            width: line.bounds.width,
            height: line.bounds.height,
          },
          text: line.text,
          style: {
            fontId: chosenFontId,
            fontSize: 12,
          },
          invisible: true,
          fitBounds: true,
          ocr: true,
        });

        if (line.transform) {
          commands.push({
            type: 'objects.transform',
            pageId: page.id,
            objectIds: [objectId],
            matrix: line.transform,
          });
        }
      }

      const transaction: EditTransaction = {
        id: crypto.randomUUID(),
        docId: document.id,
        baseRevision: document.revision,
        source: 'manual',
        commands,
      };

      const context = {
        document,
        pages: new Map([[page.id, page]]),
        fontIds: new Set(fonts.map(f => f.id)),
      };

      await engine.previewTransaction(transaction);
      if (
        document.id !== candidateBase.docId ||
        document.revision !== candidateBase.revision ||
        page.id !== candidateBase.pageId ||
        stopRequestedRef.current
      ) {
        setError('Document changed during preview.');
        return;
      }

      const commitResult = await new CommandRegistry(engine).execute(transaction, context);
      expectedRevisionRef.current = commitResult.revision;
      await onCommitted(commitResult);

      setCandidateLines([]);
      setCandidateBase(null);
      setStatusMessage(`Added ${validLines.length} searchable text line(s) to current page.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to apply searchable text layer');
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  async function runOcrRange(): Promise<void> {
    if (locked || !canWriteLayer) return;
    const pageNumbers = parsePageRange(pageRangeInput, document.pageOrder.length);
    if (pageNumbers.length === 0) {
      setError('Please specify a valid page range (e.g. 1-3, 5).');
      return;
    }
    if (!chosenFontId) {
      setError('A font must be selected to insert searchable text.');
      return;
    }

    setBusy(true);
    onBusyChange(true);
    setError('');
    setStatusMessage(`Starting batch OCR for ${pageNumbers.length} page(s)…`);

    stopRequestedRef.current = false;
    let committedPages = 0;
    let skippedPages = 0;
    let currentDocRevision = document.revision;

    try {
      for (const pageNum of pageNumbers) {
        if (stopRequestedRef.current) break;

        const targetPageId = document.pageOrder[pageNum - 1];
        if (!targetPageId) continue;

        setStatusMessage(`Processing page ${pageNum} (${committedPages} committed)…`);

        const targetPage = await engine.describePage(document.id, targetPageId);
        // Skip pages that already contain text blocks in batch range mode
        const hasText = targetPage.objects.some(obj => obj.type === 'text' || Boolean(obj.textBlock));
        if (hasText) {
          skippedPages++;
          continue;
        }

        const jobId = crypto.randomUUID();
        activeJobIdRef.current = jobId;

        const result = await engine.recognizeOcr!({
          docId: document.id,
          pageId: targetPageId,
          baseRevision: currentDocRevision,
          jobId,
        });

        if (stopRequestedRef.current) break;

        const validLines = (result.lines || []).filter(
          l => l.text.trim().length > 0 && isValidBounds(l.bounds)
        );

        if (validLines.length > 0) {
          const commands: EditCommand[] = [];
          for (const line of validLines) {
            const objectId = crypto.randomUUID();
            commands.push({
              type: 'text.insert',
              pageId: targetPageId,
              objectId,
              bounds: {
                x: line.bounds.x,
                y: line.bounds.y,
                width: line.bounds.width,
                height: line.bounds.height,
              },
              text: line.text,
              style: {
                fontId: chosenFontId,
                fontSize: 12,
              },
              invisible: true,
              fitBounds: true,
              ocr: true,
            });

            const lineTransform = (line as { transform?: Matrix }).transform;
            if (lineTransform) {
              commands.push({
                type: 'objects.transform',
                pageId: targetPageId,
                objectIds: [objectId],
                matrix: lineTransform,
              });
            }
          }

          const transaction: EditTransaction = {
            id: crypto.randomUUID(),
            docId: document.id,
            baseRevision: currentDocRevision,
            source: 'manual',
            commands,
          };

          const context = {
            document: { ...document, revision: currentDocRevision },
            pages: new Map([[targetPageId, targetPage]]),
            fontIds: new Set(fonts.map(f => f.id)),
          };

          await engine.previewTransaction(transaction);
          if (stopRequestedRef.current) break;

          const commitResult = await new CommandRegistry(engine).execute(transaction, context);
          expectedRevisionRef.current = commitResult.revision;
          currentDocRevision = commitResult.revision;
          await onCommitted(commitResult);
          committedPages++;
        }
      }

      if (stopRequestedRef.current) {
        setStatusMessage(`Stopped. ${committedPages} page(s) committed (retained). ${skippedPages} page(s) skipped.`);
      } else {
        setStatusMessage(`Completed: ${committedPages} page(s) committed, ${skippedPages} page(s) skipped.`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Batch OCR range failed');
    } finally {
      activeJobIdRef.current = null;
      setBusy(false);
      onBusyChange(false);
    }
  }

  function updateCandidateText(id: string, text: string): void {
    setCandidateLines(lines => lines.map(l => l.id === id ? { ...l, text } : l));
  }

  function removeCandidateLine(id: string): void {
    setCandidateLines(lines => lines.filter(l => l.id !== id));
  }

  const isCurrentPageBlocked =
    hasExistingText &&
    (!useImageRegion || !selectedImage || selectedImageOverlapsExistingText);

  return (
    <section className="text-edit-panel" aria-label={t("OCR and searchable text")}>
      <details open>
        <summary>{t("OCR & Searchable Text")}</summary>
        <p>{t("Recognize scanned documents and insert an invisible text layer for searching and selection.")}</p>

        <label>{t("Scope")}<select
            value={targetMode}
            disabled={locked}
            onChange={e => setTargetMode(e.target.value as 'current' | 'range')}
          >
            <option value="current">{t("Current page (Page")} {document.pageOrder.indexOf(page.id) + 1})</option>
            <option value="range">{t("Page range (batch)")}</option>
          </select>
        </label>

        {targetMode === 'range' && (
          <label>{t("Page range (e.g. 1-3, 5)")}<input
              type="text"
              value={pageRangeInput}
              disabled={locked}
              placeholder="e.g. 1-3, 5"
              onChange={e => setPageRangeInput(e.target.value)}
            />
          </label>
        )}

        {targetMode === 'current' && (
          <label className="document-checkbox" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={useImageRegion && Boolean(selectedImage)}
              disabled={locked || !selectedImage}
              onChange={e => setUseImageRegion(e.target.checked)}
            />
            <span>{t("Use selected image region")}{!selectedImage ? ' (select 1 image to enable)' : ` (${Math.round(selectedImage.bounds.width)}×${Math.round(selectedImage.bounds.height)} pt)`}
            </span>
          </label>
        )}

        <label>{t("OCR Font (CJK Supported)")}<select
            value={chosenFontId}
            disabled={locked}
            onChange={e => setFontId(e.target.value)}
          >
            {fonts.map(f => (
              <option key={f.id} value={f.id}>
                {f.family} · {f.style}
              </option>
            ))}
          </select>
        </label>
        {fontError && <p role="alert">{t(fontError)}</p>}

        {targetMode === 'current' && hasExistingText && (
          <div style={{ background: '#fff3cd', padding: '8px', borderLeft: '3px solid #ffa000', fontSize: '10px' }}>
            <p style={{ margin: 0, fontWeight: 700, color: '#856404' }}>{t("Notice: Page already contains text blocks.")}</p>
            <p style={{ margin: '4px 0 0', color: '#856404' }}>{t("Full-page OCR is disabled to prevent duplicate text. Only selecting an image region that does not overlap existing text is allowed.")}</p>
            {useImageRegion && selectedImage && selectedImageOverlapsExistingText && (
              <p style={{ margin: '4px 0 0', color: 'var(--signal)', fontWeight: 700 }}>{t("Selected image overlaps existing text blocks. Deselect or choose a non-overlapping image.")}</p>
            )}
          </div>
        )}

        {targetMode === 'range' && (
          <p style={{ fontSize: '10px', color: '#646761' }}>{t("Run OCR range processes pages sequentially and commits searchable text per page. Pages with existing text blocks are skipped to prevent duplication. Pages already committed are retained if stopped.")}</p>
        )}

        <div className="text-edit-actions">
          {targetMode === 'current' ? (
            <button
              type="button"
              disabled={locked || isCurrentPageBlocked}
              onClick={() => void runCurrentPageOcr()}
            >
              {busy ? t("Recognizing…") : t("Run OCR on page")}
            </button>
          ) : (
            <button
              type="button"
              disabled={locked || !canWriteLayer}
              onClick={() => void runOcrRange()}
            >
              {busy ? t("Running range…") : t("Run OCR range")}
            </button>
          )}

          <button
            type="button"
            disabled={!busy}
            onClick={() => void handleStop()}
          >{t("Stop")}</button>
        </div>

        {targetMode === 'current' && candidateLines.length > 0 && (
          <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="eyebrow">{t("Candidates (")}{candidateLines.length} {t("lines)")}</span>
              <button
                type="button"
                className="button button-quiet"
                style={{ minHeight: 'auto', padding: '2px 6px', fontSize: '9px' }}
                disabled={locked}
                onClick={() => {
                  setCandidateLines([]);
                  setCandidateBase(null);
                }}
              >{t("Clear")}</button>
            </div>
            <p style={{ fontSize: '10px' }}>{t("Review and edit recognized candidates below before adding to document.")}</p>

            <ul className="document-tools-list" style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {candidateLines.map(line => (
                <li key={line.id} style={{ display: 'grid', gap: '4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <small style={{ color: line.confidence > 0.8 ? '#4b8b3b' : '#b27300', fontWeight: 700 }}>{t("Confidence:")} {Math.round(line.confidence * 100)}%
                      {line.transform && ' · Oriented'}
                    </small>
                    <button
                      type="button"
                      style={{
                        minHeight: 'auto',
                        padding: '2px 6px',
                        fontSize: '9px',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--signal)',
                        cursor: 'pointer',
                      }}
                      disabled={locked}
                      title={t("Remove candidate line")}
                      onClick={() => removeCandidateLine(line.id)}
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    type="text"
                    value={line.text}
                    disabled={locked}
                    onChange={e => updateCandidateText(line.id, e.target.value)}
                  />
                </li>
              ))}
            </ul>

            <button
              type="button"
              disabled={locked || !canWriteLayer || candidateLines.length === 0}
              onClick={() => void applyCandidates()}
            >{t("Add searchable text")}</button>
          </div>
        )}

        {statusMessage && (
          <div className="layout-result" role="status">
            <span>{statusMessage}</span>
          </div>
        )}

        {error && (
          <p role="alert" style={{ color: 'var(--signal)', fontWeight: 700 }}>
            {t(error)}
          </p>
        )}

        <div className="boundary-note" style={{ margin: '8px 0 0' }}>
          <span>{t("Searchable Text Layer")}</span>
          <p>{t("Adds an invisible searchable text layer over the document. The original scanned image is preserved. Injected OCR text objects can later be inspected and edited using the Text panel. Recognition results are executed locally and never uploaded.")}</p>
        </div>
      </details>
    </section>
  );
}

function parsePageRange(input: string, totalPages: number): number[] {
  const pages = new Set<number>();
  const parts = input.split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map(s => s.trim());
      const start = parseInt(startStr ?? '', 10);
      const end = parseInt(endStr ?? '', 10);
      if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start) {
        for (let i = start; i <= Math.min(end, totalPages); i++) {
          pages.add(i);
        }
      }
    } else {
      const p = parseInt(part, 10);
      if (Number.isInteger(p) && p >= 1 && p <= totalPages) {
        pages.add(p);
      }
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}
