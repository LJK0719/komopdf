import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CommandRegistry } from '@pdf-editor/commands';
import {
  EngineError,
  WEB_LIMITS,
  type CommitResult,
  type DocumentInfo,
  type DocumentSource,
  type EditableObject,
  type EngineAdapter,
  type HostAdapter,
  type OutlineEntry,
  type PageModel,
  type RenderResult,
  type SaveConfirmation,
} from '@pdf-editor/contracts';
import { AiPanel } from './AiPanel.js';
import { TextEditPanel } from './TextEditPanel.js';
import { ParagraphPanel } from './ParagraphPanel.js';
import { FontPanel } from './FontPanel.js';
import { PasswordDialog, type PasswordPrompt } from './PasswordDialog.js';
import { ExportPanel, type ExportSettings } from './ExportPanel.js';
import { PrintPanel } from './PrintPanel.js';
import { ObjectEditPanel } from './ObjectEditPanel.js';
import { DocumentToolsPanel } from './DocumentToolsPanel.js';
import { SignaturePanel } from './SignaturePanel.js';
import { OcrPanel } from './OcrPanel.js';
import { PdfSearchPanel } from './PdfSearchPanel.js';
import { PageThumbnail } from './PageThumbnail.js';
import { drawRender, mountVisiblePageTiles, renderPage } from './draw-render.js';
import { ObjectSelectionLayer as SelectionLayer } from './ObjectSelectionLayer.js';
import { PdfLinkLayer } from './PdfLinkLayer.js';
import { addImportedFont } from './font-resources.js';
import {
  checkRecoverableSessions,
  persistRecoverySnapshot,
  discardRecoveryRecord,
  restoreRecoveryRecord,
  type RecoverySessionMeta,
} from '../recovery/index.js';
import './editor.css';

const RENDER_SCALE = 1.25;

type EditorShellProps = {
  engine: EngineAdapter;
  host: HostAdapter;
  productName?: string;
  aiPanel?: ReactNode;
  renderAiPanel?: (context: EditorAiContext) => ReactNode;
  source?: DocumentSource | null;
  onSourceConsumed?: (opened: boolean) => void;
  onDocumentChange?: (state: { document: DocumentInfo | null; busy: boolean; draftDirty: boolean }) => void;
  closeDocumentRef?: { current: (() => Promise<boolean>) | null };
  externalBusy?: boolean;
  onActivityChange?: (busy: boolean) => void;
};

export type EditorAiContext = {
  document: DocumentInfo | null;
  page: PageModel | null;
  name: string | null;
  selectedIds: string[];
  engine: EngineAdapter;
  disabled: boolean;
  onCommitted(result: CommitResult): Promise<void>;
  openDocument(source: DocumentSource): Promise<DocumentInfo | null>;
  saveDocument(): Promise<SaveConfirmation | null>;
};

export type LoadedDocument = {
  info: DocumentInfo;
  name: string;
  page: PageModel;
  render: RenderResult;
};

export function mergeSavedRevision(current: LoadedDocument, savedRevision: number): LoadedDocument {
  return { ...current, info: { ...current.info, savedRevision } };
}

type Activity = 'idle' | 'opening' | 'rendering' | 'saving' | 'editing';
type WebDocumentSession = { loaded: LoadedDocument; history: { canUndo: boolean; canRedo: boolean }; zoom: number; selectedIds: string[] };

export function EditorShell({ engine, host, productName = 'komopdf', aiPanel, renderAiPanel,
  source: externalSource, onSourceConsumed, onDocumentChange, closeDocumentRef, externalBusy = false, onActivityChange }: EditorShellProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileLayerRef = useRef<HTMLDivElement>(null);
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const documentRef = useRef<LoadedDocument | null>(null);
  const inactiveWebDocuments = useRef(new Map<string, WebDocumentSession>());
  const [webTabs, setWebTabs] = useState<{ id: string; name: string }[]>([]);
  const [document, setDocument] = useState<LoadedDocument | null>(null);
  const [activity, setActivity] = useState<Activity>('idle');
  const [notice, setNotice] = useState('PDF processed only on this device');
  const [error, setError] = useState<string | null>(null);
  const [tileViewportLimited, setTileViewportLimited] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inlineTextId, setInlineTextId] = useState<string | null>(null);
  const [searchSelection, setSearchSelection] = useState<{ docId: string; revision: number; pageId: string; blockId: string; start: number; end: number; key: number } | null>(null);
  const searchLocationSequence = useRef(0);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [outlineError, setOutlineError] = useState(false);
  const [pageAnnotations, setPageAnnotations] = useState<import('@pdf-editor/contracts').PdfAnnotationInfo[]>([]);
  const [editPending, setEditPending] = useState(false);
  const [textDraftDirty, setTextDraftDirty] = useState(false);
  const [paragraphDraftDirty, setParagraphDraftDirty] = useState(false);
  const isDraftDirty = textDraftDirty || paragraphDraftDirty;
  const [zoom, setZoom] = useState(RENDER_SCALE);
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState<RecoverySessionMeta | null>(null);
  const passwordResolver = useRef<((value: string | null) => void) | null>(null);
  const openSequence = useRef(0);
  useEffect(() => () => { openSequence.current++; passwordResolver.current?.(null); }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    void checkRecoverableSessions(host).then((sessions) => {
      if (cancelled || documentRef.current) return;
      if (sessions.length > 0) {
        setPendingRecovery(sessions[sessions.length - 1]!);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [host]);

  const askPassword = (name: string, incorrect: boolean) => new Promise<string | null>(resolve => {
    passwordResolver.current?.(null);
    const answer = (value: string | null) => {
      if (passwordResolver.current !== answer) return;
      passwordResolver.current = null; setPasswordPrompt(null); resolve(value);
    };
    passwordResolver.current = answer;
    setPasswordPrompt({ name, incorrect, resolve: answer });
  });

  useEffect(() => {
    documentRef.current = document;
  }, [document]);
  useEffect(() => { setInlineTextId(null); }, [document?.info.id, document?.info.revision, document?.page.id]);

  useEffect(() => {
    setTileViewportLimited(false);
    if (!document) return;
    if (document.render.pixels.byteLength) {
      drawRender(canvasRef.current, document.render);
      return;
    }
    if (!tileLayerRef.current || !stageRef.current) return;
    return mountVisiblePageTiles(tileLayerRef.current, stageRef.current, engine,
      document.info.id, document.page, zoom, document.render,
      caught => setError(formatError(caught)), setTileViewportLimited);
  }, [engine, document?.info.id, document?.page, document?.render, zoom]);

  useEffect(() => {
    const info = document?.info;
    setOutline([]);
    setOutlineError(false);
    if (!info || !engine.describeOutline) return;
    let cancelled = false;
    void engine.describeOutline(info.id).then(entries => {
      if (!cancelled) setOutline(entries);
    }).catch(() => { if (!cancelled) setOutlineError(true); });
    return () => { cancelled = true; };
  }, [engine, document?.info.id, document?.info.revision]);

  useEffect(() => {
    setPageAnnotations([]);
    const info = document?.info;
    const pageId = document?.page.id;
    if (!info || !pageId || !engine.describeAnnotations) return;
    let cancelled = false;
    void engine.describeAnnotations(info.id, pageId).then(annotations => {
      if (!cancelled) setPageAnnotations(annotations);
    }).catch(() => {
      if (!cancelled) setPageAnnotations([]);
    });
    return () => { cancelled = true; };
  }, [engine, document?.info.id, document?.page.id, document?.info.revision]);

  useEffect(() => () => {
    const current = documentRef.current;
    if (current) void engine.close(current.info.id).catch(() => undefined);
    for (const session of inactiveWebDocuments.current.values()) {
      void engine.close(session.loaded.info.id).catch(() => undefined);
    }
    inactiveWebDocuments.current.clear();
  }, [engine]);

  const triggerAutoRecovery = (docInfo: DocumentInfo, name: string): void => {
    void persistRecoverySnapshot(engine, host, { info: docInfo, name }).catch(() => {
      setNotice('Auto-recovery snapshot unavailable for current changes');
    });
  };

  const updateSavedRevision = (docId: string, savedRevision: number): void => {
    const latest = documentRef.current;
    if (!latest || latest.info.id !== docId) return;
    const updated = mergeSavedRevision(latest, savedRevision);
    documentRef.current = updated;
    setDocument(updated);
    triggerAutoRecovery(updated.info, updated.name);
  };

  const restorePendingRecovery = async (): Promise<void> => {
    if (!pendingRecovery) return;
    if (isDraftDirty) {
      setError('Apply or discard the current text draft before restoring');
      return;
    }
    const targetSession = pendingRecovery;
    setError(null);
    setActivity('opening');
    setNotice(`Restoring ${targetSession.name}…`);

    let password: string | undefined;
    for (;;) {
      try {
        const info = await restoreRecoveryRecord(engine, host, targetSession, password);
        const firstPageId = info.pageOrder[0];
        if (!firstPageId) throw new EngineError('INVALID_REQUEST', 'Restored PDF has no displayable pages');
        const loaded = await loadPage(engine, info, targetSession.name, firstPageId);
        if (engine.describeFonts) {
          try {
            const restoredFonts = await engine.describeFonts(info.id);
            for (const font of restoredFonts) {
              if (font.id.startsWith('user-font-')) addImportedFont(engine, font);
            }
          } catch (caught) {
            setError(`Restored document, but custom fonts could not be listed: ${formatError(caught)}`);
          }
        }
        documentRef.current = loaded;
        setDocument(loaded);
        if (host.capabilities.platform === 'web') setWebTabs([{ id: loaded.info.id, name: loaded.name }]);
        setSelectedIds([]);
        setSearchSelection(null);
        setTextDraftDirty(false);
        setParagraphDraftDirty(false);
        setHistory({ canUndo: info.revision > 0, canRedo: false });
        setZoom(RENDER_SCALE);
        setNotice(`Restored ${loaded.name} · Rev ${loaded.info.revision}`);
        setPendingRecovery(null);
        triggerAutoRecovery(loaded.info, loaded.name);
        break;
      } catch (caught) {
        if (caught instanceof EngineError && caught.code === 'PASSWORD_REQUIRED') {
          const answer = await askPassword(targetSession.name, password !== undefined);
          if (answer === null) {
            setNotice('Restore cancelled');
            break;
          }
          password = answer;
        } else {
          setError(formatError(caught));
          setNotice('Restore failed');
          break;
        }
      }
    }
    setActivity('idle');
  };

  const discardPendingRecovery = async (): Promise<void> => {
    if (!pendingRecovery) return;
    const docId = pendingRecovery.docId;
    setPendingRecovery(null);
    try {
      await discardRecoveryRecord(host, docId);
      setNotice('Discarded uncommitted session');
    } catch {
      setError('Unable to clean up discarded recovery session');
    }
  };

  const openDocument = async (suppliedSource?: DocumentSource): Promise<DocumentInfo | null> => {
    if (isDraftDirty) {
      setError('Apply or discard the current text draft before opening another PDF');
      return null;
    }
    setError(null);
    const previous = documentRef.current;
    const web = host.capabilities.platform === 'web';
    if (web && previous && inactiveWebDocuments.current.size >= WEB_LIMITS.openDocuments - 1) {
      setError(`The web editor can keep only ${WEB_LIMITS.openDocuments} PDFs open. Close one before opening another.`);
      return null;
    }
    if (!web && previous && previous.info.revision !== previous.info.savedRevision) {
      const saveFirst = window.confirm('Current document has unsaved changes.\n\nOK: Save first, then open new file\nCancel: Choose whether to discard changes');
      if (saveFirst) {
        const saved = await saveCurrentDocument(previous, engine, host, updateSavedRevision, setError, setNotice, setActivity);
        if (!saved) return null;
      } else if (!window.confirm('Discard unsaved changes and open new file?')) {
        return null;
      }
    }

    const sequence = ++openSequence.current;
    passwordResolver.current?.(null);
    setActivity('opening');
    setNotice('Selecting local PDF…');

    try {
      const source = suppliedSource ?? await host.pickDocument();
      if (!source) {
        if (sequence === openSequence.current) setNotice('No file selected');
        return null;
      }

      if (sequence !== openSequence.current) return null;
      let password: string | undefined;
      let loaded: LoadedDocument;
      for (;;) {
        try {
          // Retain the selected source while the worker consumes each attempt,
          // so a wrong password does not detach the bytes needed to try again.
          const attempt = source.kind === 'bytes' ? { ...source, bytes: source.bytes.slice(0) } : source;
          loaded = await openLoadedDocument(engine, attempt, password);
          break;
        } catch (caught) {
          if (sequence !== openSequence.current) return null;
          if (!(caught instanceof EngineError) || caught.code !== 'PASSWORD_REQUIRED') throw caught;
          const answer = await askPassword(source.name, password !== undefined);
          if (answer === null || sequence !== openSequence.current) { if (sequence === openSequence.current) setNotice('Open cancelled'); return null; }
          password = answer;
        }
      }
      if (sequence !== openSequence.current) { await engine.close(loaded.info.id); return null; }
      if (web && loaded.info.pageOrder.length > WEB_LIMITS.pagesPerDocument) {
        await engine.close(loaded.info.id);
        throw new EngineError('RESOURCE_LIMIT', `The web editor supports at most ${WEB_LIMITS.pagesPerDocument} pages per PDF`);
      }
      if (web) {
        if (previous) inactiveWebDocuments.current.set(previous.info.id, { loaded: previous, history, zoom, selectedIds });
        setWebTabs(current => [...current, { id: loaded.info.id, name: loaded.name }]);
      }
      documentRef.current = loaded;
      setDocument(loaded);
      setSelectedIds([]);
      setSearchSelection(null);
      setTextDraftDirty(false);
      setParagraphDraftDirty(false);
      setHistory({ canUndo: false, canRedo: false });
      setZoom(RENDER_SCALE);
      setNotice(`${loaded.info.pageOrder.length} pages · Rev ${loaded.info.revision}`);
      setPendingRecovery(null);
      if (previous && !web) {
        try {
          await discardRecoveryRecord(host, previous.info.id);
        } catch {
          // Non-fatal cleanup
        }
        await engine.close(previous.info.id).catch(() => undefined);
      }
      triggerAutoRecovery(loaded.info, loaded.name);
      return sequence === openSequence.current ? loaded.info : null;
    } catch (caught) {
      if (sequence === openSequence.current) {
        setError(formatError(caught));
        setNotice(previous ? 'New document not opened; current document retained' : 'Document not opened');
      }
      return null;
    } finally {
      if (sequence === openSequence.current) setActivity('idle');
    }
  };

  const switchPage = async (pageId: string, targetTopPt?: number): Promise<void> => {
    if (isDraftDirty) { setError('Apply or discard the current text draft before changing pages'); return; }
    if (!document) return;
    if (document.page.id === pageId) {
      if (targetTopPt !== undefined && stageRef.current) {
        const scaleY = document.render.height / document.page.heightPt;
        const targetScrollTop = targetTopPt * scaleY;
        stageRef.current.scrollTo({ top: Math.max(0, targetScrollTop - 20), behavior: 'smooth' });
      }
      return;
    }
    setActivity('rendering');
    setError(null);
    try {
      const loaded = await loadPage(engine, document.info, document.name, pageId, zoom);
      const latest = documentRef.current;
      if (!latest || latest.info.id !== document.info.id || !latest.info.pageOrder.includes(pageId)) return;
      const refreshed = { ...loaded, info: latest.info };
      documentRef.current = refreshed;
      setDocument(refreshed);
      setSelectedIds([]);
      setSearchSelection(null);
      setNotice(`Page ${latest.info.pageOrder.indexOf(pageId) + 1} · Rev ${latest.info.revision}`);
      if (targetTopPt !== undefined && stageRef.current) {
        const scaleY = refreshed.render.height / refreshed.page.heightPt;
        const targetScrollTop = targetTopPt * scaleY;
        stageRef.current.scrollTo({ top: Math.max(0, targetScrollTop - 20), behavior: 'smooth' });
      }
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setActivity('idle');
    }
  };

  const saveDocument = async (): Promise<SaveConfirmation | null> => {
    if (isDraftDirty) { setError('Apply or discard the current text draft before saving'); return null; }
    const current = documentRef.current;
    if (!current) return null;
    return saveCurrentDocument(current, engine, host, updateSavedRevision, setError, setNotice, setActivity);
  };

  const exportDocument = async (options: ExportSettings): Promise<void> => {
    const current = documentRef.current;
    if (!current || isDraftDirty) throw new Error('Apply or discard the text draft before exporting');
    setActivity('saving'); setError(null); setNotice('Exporting a local PDF copy…');
    try {
      const result = await engine.save({ docId: current.info.id, ...options });
      const suffix = options.protection === 'set' ? 'protected' : options.protection === 'remove' ? 'unprotected' : options.optimize ? 'optimized' : 'copy';
      const name = `${current.name.replace(/\.pdf$/i, '')}-${suffix}.pdf`;
      const outcome = await host.saveDocument(result, name);
      setNotice(outcome?.status === 'download-started' ? 'Export download started; active document unchanged' : 'Exported PDF copy; active document unchanged');
      // A copy export deliberately does not confirm the active document as saved.
    } catch (caught) {
      setNotice('Export not completed');
      throw caught;
    } finally { setActivity('idle'); }
  };

  const handleCommitted = async (result: CommitResult, action = 'Committed'): Promise<void> => {
    const current = documentRef.current;
    if (!current || current.info.id !== result.docId || result.revision <= current.info.revision) return;
    const info: DocumentInfo = {
      ...current.info,
      revision: result.revision,
      pageOrder: result.pageOrder,
    };
    const committed = { ...current, info };
    documentRef.current = committed;
    setDocument(committed);
    setHistory({ canUndo: result.canUndo, canRedo: result.canRedo });
    setNotice(`${action} rev ${result.revision}`);
    triggerAutoRecovery(committed.info, committed.name);

    const pageId = result.pageOrder.includes(current.page.id) ? current.page.id : result.pageOrder[0];
    if (!pageId) {
      setError('Changes committed, but document has no displayable pages');
      return;
    }
    setActivity('rendering');
    try {
      const loaded = await loadPage(engine, info, current.name, pageId, zoom);
      const latest = documentRef.current;
      if (!latest || latest.info.id !== result.docId || latest.info.revision !== result.revision) return;
      const refreshed = { ...loaded, info: latest.info };
      documentRef.current = refreshed;
      setDocument(refreshed);
      setSelectedIds((ids) => ids.filter((id) => refreshed.page.objects.some((object) => object.id === id)));
    } catch (caught) {
      setError(`Changes committed, but page refresh failed: ${formatError(caught)}`);
    } finally {
      setActivity('idle');
    }
  };

  const moveHistory = async (direction: 'undo' | 'redo'): Promise<void> => {
    const current = documentRef.current;
    if (!current || isDraftDirty || activity !== 'idle' || (direction === 'undo' ? !history.canUndo : !history.canRedo)) return;
    setActivity('editing');
    setError(null);
    try {
      const result = direction === 'undo'
        ? await engine.undo(current.info.id)
        : await engine.redo(current.info.id);
      await handleCommitted(result, direction === 'undo' ? 'Undid to' : 'Redid to');
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setActivity('idle');
    }
  };

  const locateTextBlock = (pageId: string, blockId: string, range?: { start: number; end: number }): void => {
    if (isDraftDirty) { setError('Apply or discard the current text draft before changing selection'); return; }
    void (async () => {
      const current = documentRef.current;
      if (!current || !current.info.pageOrder.includes(pageId)) return;
      setActivity('rendering');
      setError(null);
      try {
        let loaded = current.page.id === pageId
          ? current
          : await loadPage(engine, current.info, current.name, pageId, zoom);
        if (loaded !== current) {
          const latest = documentRef.current;
          if (!latest || latest.info.id !== current.info.id || !latest.info.pageOrder.includes(pageId)) return;
          loaded = { ...loaded, info: latest.info };
          documentRef.current = loaded;
          setDocument(loaded);
        }
        const latest = documentRef.current;
        if (!latest || latest.info.id !== current.info.id || latest.info.revision !== current.info.revision) return;
        const target = loaded.page.objects.find((object) => object.textBlock?.id === blockId);
        setInlineTextId(null);
        setSelectedIds(target ? [target.id] : []);
        setSearchSelection(target && range ? { docId: latest.info.id, revision: latest.info.revision,
          pageId, blockId, start: range.start, end: range.end, key: ++searchLocationSequence.current } : null);
        setNotice(target ? `Located page ${current.info.pageOrder.indexOf(pageId) + 1}` : 'Referenced text block is currently not visible');
      } catch (caught) {
        setError(formatError(caught));
      } finally {
        setActivity('idle');
      }
    })();
  };

  const selectObject = (objectId: string, additive: boolean): void => {
    if (isDraftDirty) { setError('Apply or discard the current text draft before changing selection'); return; }
    setInlineTextId(null);
    setSearchSelection(null);
    setSelectedIds((current) => {
      if (!additive) return [objectId];
      return current.includes(objectId)
        ? current.filter((id) => id !== objectId)
        : [...current, objectId];
    });
  };

  const changeZoom = async (scale: number): Promise<void> => {
    const current = documentRef.current;
    if (!current || isDraftDirty || activity !== 'idle' || editPending || externalBusy) return;
    setActivity('rendering'); setError(null);
    try {
      const render = await renderPage(engine, current.info.id, current.page, scale, current.info.revision);
      const latest = documentRef.current;
      if (!latest || latest.info.id !== current.info.id || latest.page.id !== current.page.id || latest.info.revision !== current.info.revision) return;
      const updated = { ...latest, render };
      documentRef.current = updated; setDocument(updated); setZoom(scale);
    } catch (caught) { setError(formatError(caught)); }
    finally { setActivity('idle'); }
  };

  const switchWebDocument = (docId: string): void => {
    const current = documentRef.current;
    const next = inactiveWebDocuments.current.get(docId);
    if (!current || !next || isDraftDirty || activity !== 'idle' || editPending || externalBusy) return;
    inactiveWebDocuments.current.delete(docId);
    inactiveWebDocuments.current.set(current.info.id, { loaded: current, history, zoom, selectedIds });
    documentRef.current = next.loaded;
    setDocument(next.loaded);
    setHistory(next.history);
    setZoom(next.zoom);
    setSelectedIds(next.selectedIds);
    setSearchSelection(null);
    setError(null);
    setNotice(`Switched to ${next.loaded.name} · Rev ${next.loaded.info.revision}`);
  };

  const closeDocument = async (): Promise<boolean> => {
    const current = documentRef.current;
    if (!current || !await closeHandler.current()) return false;
    setActivity('opening'); setError(null);
    try {
      await engine.close(current.info.id);
      setSearchSelection(null);
      if (host.capabilities.platform === 'web') {
        setWebTabs(tabs => tabs.filter(tab => tab.id !== current.info.id));
        const nextId = [...inactiveWebDocuments.current.keys()].at(-1);
        if (nextId) {
          const next = inactiveWebDocuments.current.get(nextId)!;
          inactiveWebDocuments.current.delete(nextId);
          documentRef.current = next.loaded; setDocument(next.loaded);
          setHistory(next.history); setZoom(next.zoom); setSelectedIds(next.selectedIds);
          setTextDraftDirty(false); setParagraphDraftDirty(false);
          setNotice(`Switched to ${next.loaded.name}`);
          return true;
        }
      }
      documentRef.current = null; setDocument(null); setSelectedIds([]); setTextDraftDirty(false); setParagraphDraftDirty(false);
      setHistory({ canUndo: false, canRedo: false }); setNotice('Document closed');
      return true;
    } catch (caught) {
      setError(formatError(caught));
      return false;
    } finally { setActivity('idle'); }
  };
  const requestCloseDocument = useRef<() => Promise<boolean>>(async () => false);
  requestCloseDocument.current = closeDocument;
  useEffect(() => {
    if (!closeDocumentRef) return;
    const request = () => requestCloseDocument.current();
    closeDocumentRef.current = request;
    return () => { if (closeDocumentRef.current === request) closeDocumentRef.current = null; };
  }, [closeDocumentRef]);

  const transformObjects = async (
    objectIds: string[],
    matrix: [number, number, number, number, number, number],
  ): Promise<void> => {
    const current = documentRef.current;
    if (!current || isDraftDirty || activity !== 'idle' || editPending || externalBusy) return;
    setActivity('editing'); setError(null);
    try {
      const result = await new CommandRegistry(engine).execute({
        id: crypto.randomUUID(),
        docId: current.info.id,
        baseRevision: current.info.revision,
        source: 'manual',
        commands: [{
          type: 'objects.transform',
          pageId: current.page.id,
          objectIds,
          matrix,
        }],
      }, {
        document: current.info,
        pages: new Map([[current.page.id, current.page]]),
      });
      await handleCommitted(result);
    } catch (caught) { setError(formatError(caught)); }
    finally { setActivity('idle'); }
  };

  const moveObjects = async (objectIds: string[], dx: number, dy: number): Promise<void> => {
    return transformObjects(objectIds, [1, 0, 0, 1, dx, dy]);
  };

  const currentPageIndex = document ? document.info.pageOrder.indexOf(document.page.id) : -1;
  const selectedObjects = document
    ? document.page.objects.filter((object) => selectedIds.includes(object.id))
    : [];
  const operationBusy = activity !== 'idle' || editPending || externalBusy;
  const isBusy = operationBusy || isDraftDirty;
  useEffect(() => { onActivityChange?.(activity !== 'idle' || editPending || isDraftDirty); }, [activity, editPending, isDraftDirty, onActivityChange]);
  useEffect(() => { onDocumentChange?.({ document: document?.info ?? null, busy: operationBusy, draftDirty: isDraftDirty }); },
    [document?.info, operationBusy, isDraftDirty, onDocumentChange]);
  const closeHandler = useRef<() => Promise<boolean>>(async () => true);
  closeHandler.current = async () => {
    if (isDraftDirty) { setError('Apply or discard the current text draft before closing'); return false; }
    if (isBusy) { setError('Finish or stop the current operation before closing'); return false; }
    const current = documentRef.current;
    if (!current || current.info.revision === current.info.savedRevision) {
      if (current) {
        try {
          await discardRecoveryRecord(host, current.info.id);
        } catch {
          setError('Unable to clean up recovery session before closing');
          return false;
        }
      }
      return true;
    }
    if (window.confirm('This PDF has unsaved changes.\n\nOK: Save before closing\nCancel: Choose whether to discard changes')) {
      const saved = Boolean(await saveCurrentDocument(current, engine, host, updateSavedRevision, setError, setNotice, setActivity));
      if (saved) {
        try {
          await discardRecoveryRecord(host, current.info.id);
          return true;
        } catch {
          setError('Document saved, but recovery cleanup failed');
          return false;
        }
      }
      return false;
    }
    const discard = window.confirm('Close without saving the current PDF changes?');
    if (discard) {
      try {
        await discardRecoveryRecord(host, current.info.id);
        return true;
      } catch {
        setError('Unable to clean up recovery session before closing');
        return false;
      }
    }
    return false;
  };
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (host.onCloseRequested) {
      void host.onCloseRequested(async () => {
        if (!await closeHandler.current()) return false;
        const active = documentRef.current;
        if (!active) return true;
        try {
          await engine.close(active.info.id);
          documentRef.current = null;
          setDocument(null);
          return true;
        } catch (caught) {
          setError(`Could not close PDF session: ${formatError(caught)}`);
          return false;
        }
      }).then(cleanup => {
        if (disposed) cleanup(); else unlisten = cleanup;
      }).catch(() => setError('Unable to register the window close guard'));
    }
    return () => { disposed = true; unlisten?.(); };
  }, [host]);
  useEffect(() => {
    if (host.capabilities.platform !== 'web') return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const current = documentRef.current;
      if (isBusy || (current && current.info.revision !== current.info.savedRevision) ||
        [...inactiveWebDocuments.current.values()].some(session => session.loaded.info.revision !== session.loaded.info.savedRevision)) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [host, isBusy]);
  const lastExternalSource = useRef<DocumentSource | null>(null);
  useEffect(() => {
    if (!externalSource || externalSource === lastExternalSource.current) return;
    lastExternalSource.current = externalSource;
    void openDocument(externalSource).then(opened => onSourceConsumed?.(opened !== null), () => onSourceConsumed?.(false));
  }, [externalSource]);

  return (
    <main className={webTabs.length ? 'editor-shell editor-shell-with-tabs' : 'editor-shell'}>
      {passwordPrompt && <PasswordDialog prompt={passwordPrompt} />}
      <header className="editor-topbar">
        <div className="brand-lockup" aria-label={productName}>
          <span className="brand-mark" aria-hidden="true">K</span>
          <span>
            <strong>{productName}</strong>
            <small>{host.capabilities.platform === 'web' ? 'LOCAL WEB' : 'NATIVE DESK'}</small>
          </span>
        </div>

        {(host.capabilities.platform !== 'web' || !document) && <div className="document-title">
          <span className="eyebrow">Current Document</span>
          <strong>{document?.name ?? 'No PDF open'}</strong>
        </div>}

        <div className="topbar-actions">
          <button className="button button-quiet" type="button" disabled={!document || isBusy || zoom <= 0.25}
            onClick={() => void changeZoom(Math.max(0.25, zoom / 1.25))}>Zoom out</button>
          <button className="button button-quiet" type="button" disabled={!document || isBusy || zoom >= 4}
            onClick={() => void changeZoom(Math.min(4, zoom * 1.25))}>Zoom in</button>
          <button className="button button-quiet" type="button" onClick={() => void openDocument()} disabled={isBusy}>
            Open PDF
          </button>
          <button className="button button-quiet" type="button" onClick={() => void closeDocument()} disabled={!document || isBusy}>Close PDF</button>
          <button className="button button-quiet" type="button" onClick={() => void moveHistory('undo')} disabled={!document || !history.canUndo || isBusy}>
            Undo
          </button>
          <button className="button button-quiet" type="button" onClick={() => void moveHistory('redo')} disabled={!document || !history.canRedo || isBusy}>
            Redo
          </button>
          <button className="button button-primary" type="button" onClick={() => void saveDocument()} disabled={!document || isBusy}>
            {activity === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      {webTabs.length > 0 && <nav className="editor-document-tabs" aria-label="Open PDFs">
        {webTabs.map(tab => {
          const active = document?.info.id === tab.id;
          const info = active ? document.info : inactiveWebDocuments.current.get(tab.id)?.loaded.info;
          return <button key={tab.id} type="button" aria-current={active ? 'page' : undefined}
            disabled={active || isBusy} onClick={() => switchWebDocument(tab.id)}
            title={tab.name}>
            {tab.name}{info && info.revision !== info.savedRevision ? ' ●' : ''}
          </button>;
        })}
      </nav>}

      <section className="editor-commandbar" aria-label="Current editing capabilities">
        <div>
          <span className="command-index">01</span>
          <span>Reading Canvas</span>
        </div>
        <div>
          <span className="command-index">02</span>
          <span>Object Selection</span>
        </div>
        <div className={document?.info.capabilities.includes('text.replace') ? '' : 'command-muted'}>
          <span className="command-index">03</span>
          <span>{document?.info.capabilities.includes('content.insert') ? 'Native PDF Editing' : document?.info.capabilities.includes('text.replace') ? 'TextBlock Editing' : 'Read-only Document'}</span>
        </div>
        <span className="local-badge">{host.capabilities.ocr ? 'Local OCR' : 'No PDF Uploaded'}</span>
      </section>

      <div className="editor-workspace">
        <aside className="page-rail" aria-label="Pages">
          <div className="rail-heading">
            <span>Pages</span>
            <small>{document?.info.pageOrder.length ?? 0}</small>
          </div>
          <div className="page-list">
            {document ? document.info.pageOrder.map((pageId, index) => (
              <button
                type="button"
                className={pageId === document.page.id ? 'page-chip page-chip-active' : 'page-chip'}
                key={pageId}
                data-page-id={pageId}
                onClick={() => void switchPage(pageId)}
                disabled={isBusy}
                aria-label={`Open page ${index + 1}`}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <PageThumbnail engine={engine} docId={document.info.id} pageId={pageId} revision={document.info.revision} />
              </button>
            )) : (
              <div className="rail-empty">—</div>
            )}
          </div>
          {(outline.length > 0 || outlineError) && <nav className="bookmark-list" aria-label="PDF bookmarks">
            <strong>Bookmarks</strong>
            {outlineError ? <span role="status">Bookmarks could not be read</span> : outline.map((entry, index) =>
              <button type="button" key={`${index}-${entry.title}`} disabled={!entry.pageId || isBusy}
                style={{ paddingLeft: `${6 + Math.min(entry.level, 5) * 8}px` }}
                aria-label={`Go to bookmark ${entry.title || 'Untitled'}`}
                title={entry.title || 'Untitled'}
                onClick={() => { if (entry.pageId) void switchPage(entry.pageId); }}>
                {entry.title || 'Untitled'}
              </button>)}
          </nav>}
        </aside>

        <section ref={stageRef} className="canvas-stage" aria-label="PDF Canvas">
          {tileViewportLimited && document && !document.render.pixels.byteLength &&
            <div className="tile-limit-warning" role="alert"><span>
              This viewport exceeds the web bitmap budget. Some page edges are not rendered; zoom out or reduce the window size to see the full visible page.
            </span></div>}
          {pendingRecovery && !document ? (
            <aside className="recovery-banner" role="alert" aria-label="Recoverable session notice">
              <div className="recovery-info">
                <strong>Recover Unsaved Document</strong>
                <span>
                  "{pendingRecovery.name}" (Rev {pendingRecovery.revision}, {pendingRecovery.revision - pendingRecovery.savedRevision} unsaved change{pendingRecovery.revision - pendingRecovery.savedRevision === 1 ? '' : 's'})
                </span>
              </div>
              <div className="recovery-actions">
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => void restorePendingRecovery()}
                  disabled={isBusy}
                >
                  Restore
                </button>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => void discardPendingRecovery()}
                  disabled={isBusy}
                >
                  Discard
                </button>
              </div>
            </aside>
          ) : null}
          {!document ? (
            <EmptyCanvas busy={activity === 'opening'} isWeb={host.capabilities.platform === 'web'} onOpen={() => void openDocument()} />
          ) : (
            <div ref={pageWrapRef} className={document.render.pixels.byteLength ? 'page-wrap' : 'page-wrap page-wrap-tiled'}
              style={{ width: document.render.width, height: document.render.height }}
              onClick={() => {
                if (isDraftDirty) setError('Apply or discard the current text draft before changing selection');
                else { setSelectedIds([]); setSearchSelection(null); setInlineTextId(null); }
              }}>
              {document.render.pixels.byteLength
                ? <canvas ref={canvasRef} className="pdf-canvas" aria-label={`Page ${currentPageIndex + 1}`} />
                : <div ref={tileLayerRef} className="pdf-tile-layer" role="img" aria-label={`Page ${currentPageIndex + 1}`} />}
              <SelectionLayer
                page={document.page}
                render={document.render}
                selectedIds={selectedIds}
                onSelect={selectObject}
                onBoxSelect={ids => { setSelectedIds(ids); setSearchSelection(null); setInlineTextId(null); }}
                onEditText={id => {
                  const object = document.page.objects.find(item => item.id === id);
                  if (isBusy || !object?.textBlock || object.textBlock.editability === 'geometry-only' ||
                    !document.info.permissions.modify || !document.info.capabilities.includes('text.replace')) return;
                  setSelectedIds([id]); setSearchSelection(null); setInlineTextId(id);
                }}
                disabled={isBusy}
                canTransform={document.info.capabilities.includes('objects.transform')}
                onMove={moveObjects}
                onTransform={transformObjects}
              />
              <PdfLinkLayer
                annotations={pageAnnotations}
                page={document.page}
                render={document.render}
                pageOrder={document.info.pageOrder}
                disabled={isBusy || isDraftDirty}
                onNavigate={(targetPageId, targetTopPt) => void switchPage(targetPageId, targetTopPt)}
              />
            </div>
          )}
          {activity === 'rendering' ? <div className="stage-progress">Rendering page…</div> : null}
        </section>

        <aside className="inspector-panel" aria-label="Text editing, AI, and selection panel">
          <div className="panel-heading">
            <span>Edit & AI</span>
            <small>{document ? `REV ${document.info.revision}` : 'NO DOCUMENT'}</small>
          </div>

          <div className="selection-summary">
            <span className="eyebrow">Local Context</span>
            <strong>{selectedObjects.length > 0 ? `${selectedObjects.length} object${selectedObjects.length === 1 ? '' : 's'} selected` : 'No objects selected'}</strong>
            <p>{selectionDescription(selectedObjects)}</p>
          </div>

          <PdfSearchPanel document={document?.info ?? null} engine={engine} disabled={isBusy} onLocate={locateTextBlock} />

          {document && <ObjectEditPanel document={document.info} page={document.page} selectedIds={selectedIds}
            engine={engine} host={host} disabled={isBusy} onBusyChange={setEditPending}
            onSelectionChange={ids => { setSelectedIds(ids); setSearchSelection(null); }} onCommitted={handleCommitted} />}

          {document && <DocumentToolsPanel document={document.info} page={document.page} selectedIds={selectedIds}
            engine={engine} disabled={isBusy} onBusyChange={setEditPending} onCommitted={handleCommitted} />}
          {document && <SignaturePanel document={document.info} page={document.page}
            engine={engine} disabled={isBusy} onBusyChange={setEditPending} onCommitted={handleCommitted} />}

          {host.capabilities.ocr && document && <OcrPanel document={document.info} page={document.page} selectedIds={selectedIds}
            engine={engine} disabled={isBusy} onBusyChange={setEditPending} onCommitted={handleCommitted} />}

          <FontPanel engine={engine} host={host} disabled={operationBusy} onBusyChange={setEditPending} />
          {document && <ExportPanel disabled={isBusy} encrypted={document.info.permissions.encrypted} signed={document.info.permissions.signed} onExport={exportDocument} />}
          {document && (host.capabilities.platform === 'web' || host.printDocument) &&
            <PrintPanel disabled={isBusy} docId={document.info.id} pageIds={document.info.pageOrder}
              encrypted={document.info.permissions.encrypted} canPrint={document.info.permissions.print === true}
              engine={engine} host={host} onBusyChange={setEditPending} />}

          {document && (
            <ParagraphPanel
              document={document.info}
              page={document.page}
              selectedIds={selectedIds}
              engine={engine}
              disabled={operationBusy || textDraftDirty}
              onBusyChange={setEditPending}
              onDraftChange={setParagraphDraftDirty}
              onCommitted={handleCommitted}
            />
          )}

          <TextEditPanel
            document={document?.info ?? null}
            page={document?.page ?? null}
            selectedIds={selectedIds}
            searchSelection={searchSelection}
            inlineTextId={inlineTextId}
            inlineHost={inlineTextId ? pageWrapRef.current : null}
            render={document?.render ?? null}
            onInlineClose={() => setInlineTextId(null)}
            engine={engine}
            disabled={operationBusy || paragraphDraftDirty}
            onBusyChange={setEditPending}
            onDraftChange={setTextDraftDirty}
            onCommitted={handleCommitted}
          />

          {renderAiPanel ? renderAiPanel({ document: document?.info ?? null, page: document?.page ?? null,
            name: document?.name ?? null, selectedIds, engine, disabled: isBusy, onCommitted: handleCommitted,
            openDocument: source => openDocument(source), saveDocument }) : aiPanel ?? (
            <AiPanel
              key={document?.info.id ?? 'no-document'}
              document={document?.info ?? null}
              page={document?.page ?? null}
              selectedIds={selectedIds}
              engine={engine}
              disabled={isBusy}
              onBusyChange={setEditPending}
              onCommitted={handleCommitted}
              onLocate={locateTextBlock}
            />
          )}

          <div className="boundary-note">
            <span>Execution Boundary</span>
            <p>Manual and AI changes use the same command path; ABI 1 cores remain read-only and never return simulated edit success.</p>
          </div>
        </aside>
      </div>

      <footer className="editor-statusbar">
        <span className={error ? 'status-dot status-dot-error' : 'status-dot'} aria-hidden="true" />
        <span>{error ?? notice}</span>
        <span className="status-spacer" />
        <span>{document ? `${currentPageIndex + 1} / ${document.info.pageOrder.length}` : '0 / 0'}</span>
        <span>{document ? `${Math.round(zoom * 100)}%` : '—'}</span>
      </footer>
    </main>
  );
}

function EmptyCanvas({ busy, isWeb, onOpen }: { busy: boolean; isWeb: boolean; onOpen(): void }) {
  return (
    <div className="empty-canvas">
      <div className="empty-sheet" aria-hidden="true">
        <span>PDF</span>
        <i />
        <i />
        <i />
      </div>
      <span className="eyebrow">KOMOPDF · LOCAL PDF WORKSPACE</span>
      <h1>Edit your PDF<br />on your device.</h1>
      <p>{isWeb ? 'Open a PDF up to 50 MiB. Rendering, editing, and saving run in your browser.' : 'Open a local PDF without app-imposed file-size or page-count limits. Desktop editing and OCR run on your device.'}</p>
      <button className="button button-primary button-large" type="button" onClick={onOpen} disabled={busy}>
        {busy ? 'Opening…' : 'Choose Local PDF'}
      </button>
    </div>
  );
}

export async function replaceLoadedDocument(
  engine: EngineAdapter,
  previous: LoadedDocument | null,
  source: DocumentSource,
): Promise<LoadedDocument> {
  const loaded = await openLoadedDocument(engine, source);
  if (previous) await engine.close(previous.info.id).catch(() => undefined);
  return loaded;
}

export async function openLoadedDocument(
  engine: EngineAdapter,
  source: DocumentSource,
  password?: string,
): Promise<LoadedDocument> {
  const info = await (password === undefined ? engine.open(source) : engine.open(source, password));
  try {
    const firstPageId = info.pageOrder[0];
    if (!firstPageId) throw new EngineError('INVALID_REQUEST', 'Document has no displayable pages');
    return await loadPage(engine, info, source.name, firstPageId);
  } catch (error) {
    await engine.close(info.id).catch(() => undefined);
    throw error;
  }
}

async function loadPage(
  engine: EngineAdapter,
  info: DocumentInfo,
  name: string,
  pageId: string,
  scale = RENDER_SCALE,
): Promise<LoadedDocument> {
  const page = await engine.describePage(info.id, pageId);
  const render = await renderPage(engine, info.id, page, scale, info.revision);
  return { info, name, page, render };
}

async function saveCurrentDocument(
  current: LoadedDocument,
  engine: EngineAdapter,
  host: HostAdapter,
  updateSavedRevision: (docId: string, savedRevision: number) => void,
  setError: (message: string | null) => void,
  setNotice: (message: string) => void,
  setActivity: (activity: Activity) => void,
): Promise<SaveConfirmation | null> {
  setActivity('saving');
  setError(null);
  setNotice('Generating file from PDF core…');
  try {
    const result = await engine.save({ docId: current.info.id, protection: 'preserve' });
    const outcome = await host.saveDocument(result, current.name);
    if (outcome?.status === 'download-started') {
      setNotice(`Download started for rev ${result.savedRevision}; verify the downloaded file before closing`);
      return null;
    }
    const confirmed = await engine.confirmSave({ docId: result.docId, savedRevision: result.savedRevision });
    updateSavedRevision(result.docId, confirmed.savedRevision);
    setNotice(`Saved rev ${confirmed.savedRevision}`);
    return { docId: result.docId, savedRevision: result.savedRevision };
  } catch (caught) {
    setError(formatError(caught));
    setNotice('Save not completed');
    return null;
  } finally {
    setActivity('idle');
  }
}

function formatError(error: unknown): string {
  if (error instanceof EngineError) return `${error.code} · ${error.message}`;
  return error instanceof Error ? error.message : 'Operation failed';
}

function selectionDescription(objects: EditableObject[]): string {
  if (objects.length === 0) return 'Click logical objects on the page; Ctrl/Cmd or Shift to multi-select.';
  const types = [...new Set(objects.map((object) => objectTypeName(object.type)))];
  return types.join(', ');
}

function objectTypeName(type: EditableObject['type']): string {
  const names: Record<EditableObject['type'], string> = {
    text: 'Text',
    image: 'Image',
    path: 'Path',
    form: 'Form',
    group: 'Group',
  };
  return names[type];
}
