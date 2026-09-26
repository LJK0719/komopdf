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
import { DirectTextEditor, type TextEditorHandle } from './DirectTextEditor.js';
import { DocumentViewport, type PageView, type PointerTool } from './DocumentViewport.js';
import { EditorRibbon, type RibbonTab, type RibbonAction } from './EditorRibbon.js';
import { ImageCropOverlay } from './ImageCropOverlay.js';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Bookmark, Search, MessageSquare, PenLine, LayoutGrid } from 'lucide-react';
import { FontPanel } from './FontPanel.js';
import { ParagraphPanel } from './ParagraphPanel.js';
import { SaveChangesDialog, type SaveChoice, type SavePrompt } from './SaveChangesDialog.js';
import { PasswordDialog, type PasswordPrompt } from './PasswordDialog.js';
import { ExportPanel, type ExportSettings } from './ExportPanel.js';
import { PrintPanel } from './PrintPanel.js';
import { ObjectEditPanel } from './ObjectEditPanel.js';
import { DocumentToolsPanel } from './DocumentToolsPanel.js';
import { SignaturePanel } from './SignaturePanel.js';
import { OcrPanel } from './OcrPanel.js';
import { PdfSearchPanel } from './PdfSearchPanel.js';
import { PageThumbnail } from './PageThumbnail.js';
import { PageOrganizer, PageContextMenu, usePageTools, type PageAction } from './PageOrganizer.js';
import type { TextSelectionTarget } from './PdfTextLayer.js';
import { renderPage } from './draw-render.js';
import { ObjectSelectionLayer as SelectionLayer } from './ObjectSelectionLayer.js';
import { pickObject, selectionScope } from './object-selection.js';
import { PdfLinkLayer } from './PdfLinkLayer.js';
import { addImportedFont, useFontResources } from './font-resources.js';
import {
  checkRecoverableSessions,
  persistRecoverySnapshot,
  discardRecoveryRecord,
  restoreRecoveryRecord,
  type RecoverySessionMeta,
} from '../recovery/index.js';
import { EditorTopbar, ViewControls, IconButton, Tooltip, PanelRightClose, FilePlus2, toolNames, type EditorTool } from './EditorChrome.js';
import { useI18n, translate as t } from './i18n.js';
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
  headerActions?: ReactNode;
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
  source: externalSource, onSourceConsumed, onDocumentChange, closeDocumentRef, externalBusy = false, onActivityChange, headerActions }: EditorShellProps) {
  useI18n();
  const [activeTool, setActiveTool] = useState<EditorTool | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [railTab, setRailTab] = useState<'pages' | 'bookmarks'>('pages');
  const [tab, setTab] = useState<RibbonTab>('home');
  const [pointer, setPointer] = useState<PointerTool>('select');
  const [view, setView] = useState<PageView>('single');
  const [continuous, setContinuous] = useState(true);
  const [overviewWidth, setOverviewWidth] = useState(230);
  const [overviewColumns, setOverviewColumns] = useState(3);
  const [inlineRange, setInlineRange] = useState<[number, number] | null>(null);
  const [pagePanelSection, setPagePanelSection] = useState<'number' | 'watermark' | 'header' | null>(null);
  const objectContextPoint = useRef({ x: 36, y: 36 });
  const [pageHost, setPageHost] = useState<HTMLDivElement | null>(null);
  const [cropImage, setCropImage] = useState(false);
  const [cropPage, setCropPage] = useState(false);
  const [placement, setPlacement] = useState<{ kind: 'text' } | { kind: 'image'; resourceId: string; width: number; height: number } | null>(null);
  const [presenting, setPresenting] = useState(false);
  const beforePresentation = useRef({ view, continuous, pointer });
  const textEditor = useRef<TextEditorHandle | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const { fonts } = useFontResources(engine);
  const hasAi = Boolean(renderAiPanel || aiPanel);
  const [dragOver, setDragOver] = useState(false);
  const stageRef = useRef<HTMLElement>(null);
  const documentRef = useRef<LoadedDocument | null>(null);
  const inactiveWebDocuments = useRef(new Map<string, WebDocumentSession>());
  const [webTabs, setWebTabs] = useState<{ id: string; name: string }[]>([]);
  const [document, setDocument] = useState<LoadedDocument | null>(null);
  const [activity, setActivity] = useState<Activity>('idle');
  const [notice, setNotice] = useState('Ready');
  const [error, setError] = useState<string | null>(null);
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
  const [savePrompt, setSavePrompt] = useState<SavePrompt | null>(null);
  const saveResolver = useRef<((choice: SaveChoice) => void) | null>(null);
  const askSaveChanges = (name: string) => new Promise<SaveChoice>(resolve => {
    saveResolver.current?.('cancel');
    const answer = (choice: SaveChoice) => { saveResolver.current = null; setSavePrompt(null); resolve(choice); };
    saveResolver.current = answer; setSavePrompt({ name, resolve: answer });
  });
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState<RecoverySessionMeta | null>(null);
  const passwordResolver = useRef<((value: string | null) => void) | null>(null);
  const openSequence = useRef(0);
  useEffect(() => () => { openSequence.current++; passwordResolver.current?.(null); saveResolver.current?.('cancel'); }, []);

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
  useEffect(() => { setInlineTextId(id => document?.page.objects.some(object => object.id === id) ? id : null); }, [document?.info.id, document?.page.id]);
  useEffect(() => {
    stageRef.current?.parentElement?.querySelector('.page-chip-active')?.scrollIntoView({ block: 'nearest' });
  }, [document?.page.id]);


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
        setNotice('Ready');
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
      const choice = await askSaveChanges(previous.name);
      if (choice === 'cancel') return null;
      if (choice === 'save') {
        const saved = await saveCurrentDocument(previous, engine, host, updateSavedRevision, setError, setNotice, setActivity);
        if (!saved) return null;
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
      setActiveTool(null); setTab('home'); setPointer('select'); setPlacement(null);
      setSelectedIds([]);
      setSearchSelection(null);
      setTextDraftDirty(false);
      setParagraphDraftDirty(false);
      setHistory({ canUndo: false, canRedo: false });
      setZoom(RENDER_SCALE);
      setNotice('Ready');
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
    if (isDraftDirty && !await textEditor.current?.finish()) return;
    if (!document) return;
    if (document.page.id === pageId) { requestAnimationFrame(() => scrollToPage(pageId, targetTopPt)); return; }
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
      setNotice('Ready');
      requestAnimationFrame(() => scrollToPage(pageId, targetTopPt));
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setActivity('idle');
    }
  };

  const saveDocument = async (): Promise<SaveConfirmation | null> => {
    if (isDraftDirty && !await textEditor.current?.finish()) return null;
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
    setNotice(action === 'Undid to' ? 'Undone' : action === 'Redid to' ? 'Redone' : 'Changes applied');

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
      setSelectedIds((ids) => {
        const retained = ids.filter(id => refreshed.page.objects.some(object => object.id === id));
        if (action === 'Committed' || !retained.length) return retained;
        const selected = refreshed.page.objects.filter(object => retained.includes(object.id));
        const path = selected[0]!.locator.containerPath;
        if (!path.length || selected.some(object => object.locator.containerPath.length !== path.length ||
            object.locator.containerPath.some((part, index) => part !== path[index]))) return retained;
        const parent = refreshed.page.objects.find(object => object.type === 'group' &&
          object.locator.objectIndex === path.at(-1) && object.locator.containerPath.length === path.length - 1 &&
          object.locator.containerPath.every((part, index) => part === path[index]));
        return parent && !current.page.objects.some(object => object.id === parent.id) ? [parent.id] : retained;
      });
    } catch (caught) {
      setError(`Changes committed, but page refresh failed: ${formatError(caught)}`);
    } finally {
      setActivity('idle');
      requestAnimationFrame(() => triggerAutoRecovery(info, current.name));
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
        requestAnimationFrame(() => scrollToPage(pageId));
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
    if (isDraftDirty) { void textEditor.current?.finish().then(ok => { if (ok) { setSelectedIds([objectId]); setInlineTextId(null); } }); return; }
    setInlineTextId(null);
    setSearchSelection(null);
    setCropImage(false); setCropPage(false);
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
    setNotice('Ready');
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
    const choice = await askSaveChanges(current.name);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
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
    if (choice === 'discard') {
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

  const chooseTool = (tool: EditorTool) => {
    if (tool === 'edit') { chooseTab('edit'); return; }
    if (tool === 'ai' && !hasAi) return;
    if (isDraftDirty) { void textEditor.current?.finish().then(ok => { if (ok) setActiveTool(tool); }); return; }
    setActiveTool(tool);
  };
  const chooseTab = (next: RibbonTab) => {
    if (isDraftDirty) { void textEditor.current?.finish().then(ok => { if (ok) chooseTabAfterSave(next); }); return; }
    chooseTabAfterSave(next);
  };
  const chooseTabAfterSave = (next: RibbonTab) => {
    if (next === 'pages' && tab !== 'pages' && document) pageTools.select(document.page.id);
    setTab(next); setActiveTool(null); setCropImage(false); setCropPage(false); setPlacement(null);
    setPointer(next === 'edit' ? 'edit' : 'select');
    if (next !== 'edit') { setInlineTextId(null); setSelectedIds([]); }
  };
  const scrollToPage = (pageId: string, top = 0) => {
    const node = [...(stageRef.current?.querySelectorAll<HTMLElement>('[data-document-page]') ?? [])].find(item => item.dataset.documentPage === pageId);
    if (node && stageRef.current) {
      const root = stageRef.current;
      root.scrollTop += node.getBoundingClientRect().top - root.getBoundingClientRect().top - 24 + top * zoom;
    }
  };
  const activateVisiblePage = (loaded: LoadedDocument) => {
    if (isBusy || loaded.info.id !== documentRef.current?.info.id || loaded.info.revision !== documentRef.current.info.revision) return;
    const updated = { ...loaded, info: documentRef.current.info };
    documentRef.current = updated; setDocument(updated);
    setSelectedIds([]); setInlineTextId(null); setSearchSelection(null); setCropImage(false); setCropPage(false);
  };
  const fitPage = () => {
    if (!document || !stageRef.current || isBusy) return;
    const { clientWidth, clientHeight } = stageRef.current;
    void changeZoom(Math.min(4, Math.max(0.25, Math.min((clientWidth - 64) / (document.page.widthPt * (view === 'double' ? 2 : 1)), (clientHeight - 64) / document.page.heightPt))));
  };
  const executeCommands = async (commands: import('@pdf-editor/contracts').EditCommand[], resourceIds = new Set<string>()): Promise<boolean> => {
    const current = documentRef.current;
    if (!current || operationBusy || isDraftDirty) return false;
    setActivity('editing'); setError(null);
    try {
      const transaction = { id: crypto.randomUUID(), docId: current.info.id, baseRevision: current.info.revision, source: 'manual' as const, commands };
      await engine.previewTransaction(transaction);
      const result = await new CommandRegistry(engine).execute(transaction, { document: current.info, pages: new Map([[current.page.id, current.page]]),
        fontIds: new Set(fonts.map(font => font.id)), resourceIds,
        ...(host.capabilities.platform === 'web' ? { pageLimit: WEB_LIMITS.pagesPerDocument } : {}) });
      await handleCommitted(result); return true;
    } catch (caught) { setError(formatError(caught)); return false; }
    finally { setActivity('idle'); }
  };
  const pageTools = usePageTools({ document, engine, host, disabled: isBusy, execute: executeCommands,
    onBusy: setEditPending, onError: setError, onNotice: setNotice });
  const openOverviewPage = (id: string) => { chooseTab('home'); void switchPage(id); };
  const changeOverviewZoom = (scale: number) => {
    setOverviewColumns(0); setOverviewWidth(Math.max(100, Math.min(900, scale * 230)));
  };
  const wheelState = useRef({ tab, isBusy, zoom, overviewWidth, overviewColumns, changeZoom });
  wheelState.current = { tab, isBusy, zoom, overviewWidth, overviewColumns, changeZoom };
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let timer: ReturnType<typeof setTimeout>;
    let requested: number | null = null;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = wheelState.current;
      if (current.isBusy) return;
      const factor = Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.002);
      if (current.tab === 'pages') {
        const width = current.overviewColumns ? stage.querySelector('.organizer-page')?.getBoundingClientRect().width ?? current.overviewWidth : current.overviewWidth;
        setOverviewColumns(0); setOverviewWidth(Math.max(100, Math.min(900, width * factor)));
      } else {
        requested = Math.max(0.25, Math.min(4, (requested ?? current.zoom) * factor));
        clearTimeout(timer);
        timer = setTimeout(() => { const scale = requested; requested = null; if (scale !== null) void wheelState.current.changeZoom(scale); }, 100);
      }
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => { stage.removeEventListener('wheel', wheel); clearTimeout(timer); };
  }, []);
  const runRibbonAction = async (action: RibbonAction): Promise<void> => {
    const current = documentRef.current;
    if (!current || isBusy) return;
    const pageId = current.page.id;
    if (tab === 'pages' && ['blankPage', 'importPages', 'duplicatePage', 'deletePage', 'rotatePageLeft', 'rotatePageRight', 'copyPages', 'pastePages', 'extractPages'].includes(action)) {
      await pageTools.run(action as PageAction); return;
    }
    if (action === 'cropPage') { setCropPage(true); setCropImage(false); setPlacement(null); setSelectedIds([]); return; }
    if (action === 'pageNumbers' || action === 'watermark' || action === 'headerFooter') {
      setPagePanelSection(action === 'pageNumbers' ? 'number' : action === 'headerFooter' ? 'header' : 'watermark');
      chooseTool('pages'); return;
    }
    if (action === 'flipHorizontal' || action === 'flipVertical') {
      const object = selectedObjects[0];
      if (object) await transformObjects(selectedIds, action === 'flipHorizontal' ? [-1, 0, 0, 1, object.bounds.x * 2 + object.bounds.width, 0] : [1, 0, 0, -1, 0, object.bounds.y * 2 + object.bounds.height]);
      return;
    }
    if (action === 'fit') { if (tab === 'pages') setOverviewColumns(3); else fitPage(); return; }
    if (action === 'present') {
      try {
        beforePresentation.current = { view, continuous, pointer };
        await stageRef.current?.closest('main')?.requestFullscreen();
        setPresenting(true); setView('single'); setContinuous(false); setPointer('hand'); setActiveTool(null);
      } catch { setError(t('Full screen is not available in this browser.')); }
      return;
    }
    if (action === 'insertText') { setTab('edit'); setPointer('edit'); setSelectedIds([]); setPlacement({ kind: 'text' }); return; }
    if (action === 'cropImage') { setCropImage(true); return; }
    if (['insertImage', 'replaceImage', 'importPages'].includes(action)) {
      setEditPending(true); setError(null);
      try {
        const kind = action === 'importPages' ? 'pdf' : 'image';
        const source = await host.pickResource?.(kind);
        if (!source) return;
        const resource = await engine.registerResource({ docId: current.info.id, resourceId: crypto.randomUUID(), source });
        if (action === 'insertImage') {
          setTab('edit'); setPointer('edit'); setSelectedIds([]);
          setPlacement({ kind: 'image', resourceId: resource.id, width: resource.width ?? 200, height: resource.height ?? 150 });
        } else if (action === 'replaceImage') {
          await executeCommands([{ type: 'image.replace', pageId, objectId: selectedIds[0]!, resourceId: resource.id }], new Set([resource.id]));
        } else {
          const indices = Array.from({ length: resource.pageCount ?? 0 }, (_, index) => index);
          if (indices.length) await executeCommands([{ type: 'pages.import', resourceId: resource.id, pageIndices: indices, newPageIds: indices.map(() => crypto.randomUUID()), afterPageId: pageId }], new Set([resource.id]));
        }
      } catch (caught) { setError(formatError(caught)); }
      finally { setEditPending(false); }
      return;
    }
    if (action === 'blankPage') await executeCommands([{ type: 'pages.insert', pageId: crypto.randomUUID(), afterPageId: pageId, widthPt: current.page.widthPt, heightPt: current.page.heightPt }]);
    if (action === 'duplicatePage') await executeCommands([{ type: 'pages.duplicate', pageIds: [pageId], newPageIds: [crypto.randomUUID()], afterPageId: pageId }]);
    if (action === 'deletePage' && current.info.pageOrder.length > 1) await executeCommands([{ type: 'pages.delete', pageIds: [pageId] }]);
    if (action === 'rotatePageLeft' || action === 'rotatePageRight') await executeCommands([{ type: 'pages.rotate', pageIds: [pageId], degrees: action === 'rotatePageLeft' ? 270 : 90 }]);
    if (action === 'delete' && selectedIds.length) await executeCommands([{ type: 'objects.delete', pageId, objectIds: selectedIds }]);
    if (action === 'duplicate' && selectedIds.length) await executeCommands([{ type: 'objects.copy', pageId, objectIds: selectedIds, newObjectIds: selectedIds.map(() => crypto.randomUUID()), offset: { x: 12, y: 12 } }]);
    if ((action === 'rotateLeft' || action === 'rotateRight') && selectedObjects.length) {
      const left = Math.min(...selectedObjects.map(item => item.bounds.x)), top = Math.min(...selectedObjects.map(item => item.bounds.y));
      const right = Math.max(...selectedObjects.map(item => item.bounds.x + item.bounds.width)), bottom = Math.max(...selectedObjects.map(item => item.bounds.y + item.bounds.height));
      const cx = (left + right) / 2, cy = (top + bottom) / 2, sign = action === 'rotateRight' ? 1 : -1;
      await transformObjects(selectedIds, [0, sign, -sign, 0, cx + sign * cy, cy - sign * cx]);
    }
  };
  const editTextAt = (loaded: LoadedDocument, id: string, range: [number, number]) => {
    if (isBusy || loaded.info.revision !== documentRef.current?.info.revision) return;
    activateVisiblePage(loaded); setTab('edit'); setPointer('edit'); setSelectedIds([id]); setInlineRange(range); setInlineTextId(id);
  };
  const annotateSelection = async (loaded: LoadedDocument, targets: TextSelectionTarget[], action: 'highlight' | 'underline') => {
    if (isBusy || loaded.info.revision !== documentRef.current?.info.revision) return;
    activateVisiblePage(loaded);
    const commands: import('@pdf-editor/contracts').EditCommand[] = targets.flatMap<import('@pdf-editor/contracts').EditCommand>(target => {
      if (target.range[0] === target.range[1]) return [];
      if (action === 'underline') return [{ type: 'text.style', pageId: loaded.page.id, blockIds: [target.blockId], range: target.range, style: { underline: true } }];
      return target.rects.map(bounds => ({ type: 'annotation.add', pageId: loaded.page.id, annotationId: crypto.randomUUID(), subtype: 'highlight', bounds, color: [1, 0.85, 0.1], opacity: 0.4 }));
    });
    if (commands.length && await executeCommands(commands)) window.getSelection()?.removeAllRanges();
  };
  const insertTextAt = (loaded: LoadedDocument, point: { x: number; y: number }) => {
    if (isBusy || loaded.info.revision !== documentRef.current?.info.revision) return;
    activateVisiblePage(loaded); setTab('edit'); setPointer('edit');
    void placeObject(point.x, point.y, { kind: 'text' });
  };
  const placeObject = async (x: number, y: number, placementOverride = placement) => {
    const current = documentRef.current;
    const placement = placementOverride;
    if (!current || !placement || isBusy) return;
    x = Math.max(0, Math.min(x, current.page.widthPt - 40));
    y = Math.max(0, Math.min(y, current.page.heightPt - 28));
    const id = crypto.randomUUID();
    let command: import('@pdf-editor/contracts').EditCommand;
    let resources = new Set<string>();
    if (placement.kind === 'text') {
      const font = fonts[0];
      if (!font) { setError(t('No font is available. Import a font first.')); chooseTool('fonts'); return; }
      command = { type: 'text.insert', pageId: current.page.id, objectId: id,
        bounds: { x, y, width: Math.min(240, current.page.widthPt - x), height: Math.min(48, current.page.heightPt - y) }, text: t('New text'), style: { fontId: font.id, fontSize: 14, color: [0, 0, 0] } };
    } else {
      const scale = Math.min(1, 240 / placement.width, (current.page.widthPt - x) / placement.width, (current.page.heightPt - y) / placement.height);
      command = { type: 'image.insert', pageId: current.page.id, objectId: id, resourceId: placement.resourceId,
        bounds: { x, y, width: placement.width * scale, height: placement.height * scale } };
      resources = new Set([placement.resourceId]);
    }
    if (await executeCommands([command], resources)) {
      setPlacement(null);
      const inserted = documentRef.current?.page.objects.find(item => item.id === id || item.textBlock?.sourceObjectIds.includes(id));
      if (inserted) { setSelectedIds([inserted.id]); if (inserted.textBlock) setInlineTextId(inserted.id); }
    }
  };
  useEffect(() => {
    const change = () => {
      if (!globalThis.document.fullscreenElement && presenting) {
        setPresenting(false); setView(beforePresentation.current.view); setContinuous(beforePresentation.current.continuous); setPointer(beforePresentation.current.pointer);
      }
    };
    globalThis.document.addEventListener('fullscreenchange', change);
    return () => globalThis.document.removeEventListener('fullscreenchange', change);
  }, [presenting]);
  useEffect(() => { if (presenting) fitPage(); }, [presenting]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (!typing && event.key === 'Escape') { setPlacement(null); setCropImage(false); setCropPage(false); setSelectedIds([]); }
      const pageScope = tab === 'pages' || (event.target instanceof Element && Boolean(event.target.closest('.page-list')));
      const inMenu = event.target instanceof Element && Boolean(event.target.closest('[role="menu"]'));
      if (!typing && pageScope && !inMenu && !isBusy) {
        const modifier = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (modifier && key === 'a') { event.preventDefault(); pageTools.selectAll(); return; }
        if (modifier && (key === 'c' || key === 'v')) { event.preventDefault(); void pageTools.run(key === 'c' ? 'copyPages' : 'pastePages'); return; }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void pageTools.run('deletePage'); return; }
      }
      if (!typing && !inMenu && !isBusy && pointer === 'edit' && ['Enter', 'F2'].includes(event.key) && selectedObjects.length === 1 && selectedObjects[0]?.textBlock) {
        event.preventDefault(); setInlineRange(null); setInlineTextId(selectedIds[0]!); return;
      }
      if (!typing && !inMenu && pointer === 'edit' && (event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length) { event.preventDefault(); void runRibbonAction('delete'); return; }
      if (!typing && !inMenu && tab !== 'pages' && (presenting || !continuous) && ['ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', ' '].includes(event.key)) {
        event.preventDefault(); const step = ['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1;
        const id = document?.info.pageOrder[currentPageIndex + step * (view === 'double' ? 2 : 1)]; if (id) void switchPage(id); return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const input = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (!['o', 's', 'f', 'p', 'z', 'y'].includes(key) || (input && ['z', 'y'].includes(key))) return;
      event.preventDefault();
      if (key === 'f' && document) { chooseTool('search'); return; }
      if (key === 'p' && document) { chooseTool('print'); return; }
      if (key === 's' && !operationBusy) { void saveDocument(); return; }
      if (isBusy) return;
      if (key === 'o') void openDocument();
      if (key === 'z' && (event.shiftKey ? history.canRedo : history.canUndo)) void moveHistory(event.shiftKey ? 'redo' : 'undo');
      if (key === 'y' && history.canRedo) void moveHistory('redo');
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  return (
    <Tooltip.Provider delay={350}>
    <main className={`editor-shell ${webTabs.length ? 'editor-shell-with-tabs' : ''} ${presenting ? 'is-presenting' : ''}`}>
      {savePrompt && <SaveChangesDialog prompt={savePrompt} />}
      {passwordPrompt && <PasswordDialog prompt={passwordPrompt} />}
      <EditorTopbar productName={productName} name={document?.name} dirty={Boolean(document && document.info.revision !== document.info.savedRevision)}
        showAi={hasAi} busy={operationBusy} canUndo={history.canUndo} canRedo={history.canRedo} saving={activity === 'saving'} tool={activeTool}
        onTool={chooseTool} onOpen={() => void openDocument()} onClose={() => void closeDocument()}
        onSave={() => void saveDocument()} onUndo={() => void moveHistory('undo')} onRedo={() => void moveHistory('redo')} extra={headerActions} />

      {webTabs.length > 0 && <nav className="editor-document-tabs" aria-label={t("Open PDFs")}>
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

      <EditorRibbon tab={tab} onTab={chooseTab} pointer={pointer} onPointer={next => {
        if (isDraftDirty) { void textEditor.current?.finish().then(ok => { if (ok) setPointer(next); }); return; }
        if (tab === 'pages') chooseTabAfterSave('home');
        setPointer(next); setInlineTextId(null); setSelectedIds([]); setCropImage(false); setCropPage(false); setPlacement(null);
      }} pageTools={pageTools} overviewColumns={overviewColumns} onOverviewColumns={setOverviewColumns} onTool={chooseTool} onAction={action => void runRibbonAction(action)} view={view} continuous={continuous}
        onView={next => { if (!isBusy) { setView(next); requestAnimationFrame(() => scrollToPage(document?.page.id ?? '')); } }}
        onContinuous={() => { if (!isBusy) { setContinuous(value => !value); requestAnimationFrame(() => scrollToPage(document?.page.id ?? '')); } }}
        hasDocument={Boolean(document)} busy={operationBusy} ocr={host.capabilities.ocr} railOpen={railOpen} onToggleRail={() => setRailOpen(value => !value)}
        selection={selectedObjects.length === 1 ? selectedObjects[0]?.textBlock ? 'text' : selectedObjects[0]?.type === 'image' ? 'image' : 'objects' : selectedObjects.length ? 'objects' : null}>
        {document && <DirectTextEditor document={document.info} page={document.page} selectedIds={selectedIds} inlineId={inlineTextId}
          host={pageHost} render={document.render} engine={engine} disabled={operationBusy} handle={textEditor} initialRange={inlineRange}
          onClose={() => { setInlineTextId(null); setInlineRange(null); }} onEdit={() => { setInlineRange(null); setInlineTextId(selectedIds[0] ?? null); }} onManageFonts={() => chooseTool('fonts')}
          onParagraph={id => { setSelectedIds([id]); setInlineRange(null); setInlineTextId(id); }}
          onDraftChange={setTextDraftDirty} onBusyChange={setEditPending} onCommitted={handleCommitted} />}
      </EditorRibbon>

      <div className="editor-workspace" data-rail={railOpen && Boolean(document)} data-panel={Boolean(activeTool)} data-empty={!document}>
        <nav className="navigation-tools" aria-label={t('Document navigation')}>
          <IconButton label="Pages" aria-pressed={railOpen && railTab === 'pages'} onClick={() => { setRailTab('pages'); setRailOpen(!railOpen || railTab !== 'pages'); }}><LayoutGrid size={18} /></IconButton>
          <IconButton label="Bookmarks" aria-pressed={railOpen && railTab === 'bookmarks'} onClick={() => { setRailTab('bookmarks'); setRailOpen(!railOpen || railTab !== 'bookmarks'); }}><Bookmark size={18} /></IconButton>
          <IconButton label="Comment" disabled={!document} onClick={() => chooseTool('comment')}><MessageSquare size={18} /></IconButton>
          <IconButton label="Sign" disabled={!document} onClick={() => chooseTool('sign')}><PenLine size={18} /></IconButton>
        </nav>
        <aside className="page-rail"
 aria-label={t("Pages")} hidden={!railOpen || !document}>
          <div className="rail-heading">
            <span>{t(railTab === 'pages' ? "Pages" : "Bookmarks")}</span>
            <small>{document?.info.pageOrder.length ?? 0}</small>
          </div>
          <div className="page-list" hidden={railTab !== 'pages'}>
            {document ? document.info.pageOrder.map((pageId, index) => (
              <PageContextMenu key={pageId} tools={pageTools} onOpen={() => openOverviewPage(pageId)}>
                <ContextMenu.Trigger render={<button type="button" disabled={isBusy} />} className={`page-chip ${pageId === document.page.id ? 'page-chip-active' : ''} ${pageTools.ids.includes(pageId) ? 'page-chip-selected' : ''}`}
                  data-page-id={pageId} aria-pressed={pageTools.ids.includes(pageId)}
                  onClick={event => { pageTools.select(pageId, event); if (tab !== 'pages' && !event.ctrlKey && !event.metaKey && !event.shiftKey) void switchPage(pageId); }}
                  onContextMenu={() => pageTools.select(pageId, {}, true)}
                  aria-label={t('Open page {page}', { page: index + 1 })}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <PageThumbnail engine={engine} docId={document.info.id} pageId={pageId} revision={document.info.revision} />
                </ContextMenu.Trigger>
              </PageContextMenu>
            )) : (
              <div className="rail-empty">—</div>
            )}
          </div>
          <nav hidden={railTab !== 'bookmarks'} className="bookmark-list" aria-label={t("PDF bookmarks")}>
            <strong>{t("Bookmarks")}</strong>
            {outlineError ? <span role="status">{t("Bookmarks could not be read")}</span> : outline.map((entry, index) =>
              <button type="button" key={`${index}-${entry.title}`} disabled={!entry.pageId || isBusy}
                style={{ paddingLeft: `${6 + Math.min(entry.level, 5) * 8}px` }}
                aria-label={`Go to bookmark ${entry.title || t("Untitled")}`}
                title={entry.title || t("Untitled")}
                onClick={() => { if (entry.pageId) void switchPage(entry.pageId); }}>
                {entry.title || t("Untitled")}
              </button>)}
            {!outline.length && !outlineError && <span>{t("No bookmarks in this document.")}</span>}
          </nav>
        </aside>

        <section ref={stageRef} className={`canvas-stage ${dragOver ? 'is-dragging' : ''} ${pointer === 'hand' ? 'hand-tool' : ''}`}
          onPointerDown={event => {
            if (pointer !== 'hand' || event.button !== 0 || (event.target as HTMLElement).closest('button, input, textarea')) return;
            pan.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
            event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
          }}
          onPointerMove={event => { if (pan.current) { event.currentTarget.scrollLeft = pan.current.left + pan.current.x - event.clientX; event.currentTarget.scrollTop = pan.current.top + pan.current.y - event.clientY; } }}
          onPointerUp={() => { pan.current = null; }} onPointerCancel={() => { pan.current = null; }} aria-label={t('PDF canvas')}
          onDragOver={event => { if (host.capabilities.platform === 'web' && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }}
          onDrop={event => {
            event.preventDefault(); setDragOver(false);
            if (host.capabilities.platform !== 'web' || isBusy) return;
            const file = event.dataTransfer.files[0];
            if (!file) return;
            if (!file.name.toLowerCase().endsWith('.pdf')) { setError(t('Choose a PDF file.')); return; }
            if (file.size > WEB_LIMITS.inputBytes) { setError(t('This file is too large for the web editor. Use the desktop app.')); return; }
            void file.arrayBuffer().then(bytes => openDocument({ kind: 'bytes', sourceId: crypto.randomUUID(), name: file.name, bytes })).catch(() => setError(t('Unable to open this file.')));
          }}>
          {pendingRecovery && !document ? (
            <aside className="recovery-banner" role="alert" aria-label={t("Recoverable session notice")}>
              <div className="recovery-info">
                <strong>{t("Recover Unsaved Document")}</strong>
                <span>
                  {pendingRecovery.name}
                </span>
              </div>
              <div className="recovery-actions">
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => void restorePendingRecovery()}
                  disabled={isBusy}
                >{t("Restore")}</button>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => void discardPendingRecovery()}
                  disabled={isBusy}
                >{t("Discard")}</button>
              </div>
            </aside>
          ) : null}
          {!document ? (
            <EmptyCanvas busy={activity === 'opening'} isWeb={host.capabilities.platform === 'web'} onOpen={() => void openDocument()} />
          ) : tab === 'pages' ? (
            <PageOrganizer document={document} engine={engine} tools={pageTools} disabled={isBusy} width={overviewWidth} columns={overviewColumns} onOpen={openOverviewPage} />
          ) : (
            <DocumentViewport key={document.info.id} engine={engine} document={document} zoom={zoom} view={view} continuous={continuous}
              root={stageRef} locked={isBusy || cropImage || cropPage} pointer={pointer} onActive={activateVisiblePage} onHost={setPageHost}
              onEditText={editTextAt} onInsertText={insertTextAt} onAnnotate={annotateSelection} onError={setError}>
              {(shown) => <>
                {searchSelection?.pageId === shown.page.id && (() => {
                  const match = shown.page.objects.find(item => item.textBlock?.id === searchSelection.blockId);
                  return match && <div className="search-match-highlight" style={{ position: 'absolute', pointerEvents: 'none', zIndex: 2, background: '#ffda5044', outline: '2px solid #dca91b',
                    left: match.bounds.x * zoom, top: match.bounds.y * zoom, width: match.bounds.width * zoom, height: match.bounds.height * zoom }} />;
                })()}
                {pointer === 'edit' && !placement && !cropImage && !cropPage && <ContextMenu.Root>
                  <ContextMenu.Trigger className="page-object-tools" onContextMenu={event => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    objectContextPoint.current = { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
                    const point = objectContextPoint.current;
                    const id = pickObject(selectionScope(shown.page, selectedIds), point.x, point.y, 3 / zoom)?.id;
                    if (id && !selectedIds.includes(id)) selectObject(id, false);
                    if (!id && !(event.target as HTMLElement).closest('.selection-bounds')) setSelectedIds([]);
                  }}>
                    <SelectionLayer page={shown.page} render={shown.render} selectedIds={selectedIds} onSelect={selectObject}
                      onBoxSelect={ids => {
                        const select = () => { setSelectedIds(ids); setSearchSelection(null); setInlineTextId(null); };
                        if (isDraftDirty) { void textEditor.current?.finish().then(ok => { if (ok) select(); }); } else select();
                      }}
                      onEditText={id => { if (!isBusy) { setTab('edit'); setSelectedIds([id]); setInlineTextId(id); } }}
                      disabled={operationBusy} canTransform={shown.info.permissions.modify && shown.info.capabilities.includes('objects.transform')}
                      onMove={moveObjects} onTransform={transformObjects} />
                  </ContextMenu.Trigger>
                  <ContextMenu.Portal><ContextMenu.Positioner><ContextMenu.Popup className="ui-menu">
                    {selectedObjects.length === 1 && selectedObjects[0]?.textBlock && <>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => { setInlineRange(null); setInlineTextId(selectedIds[0]!); }}>{t('Edit text')}<kbd>Enter</kbd></ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={!shown.info.permissions.copy} onClick={() => void navigator.clipboard.writeText(selectedObjects[0]!.textBlock!.runs.map(run => run.text).join('')).catch(() => setError(t('Clipboard access was denied. Use Ctrl/Cmd+C to copy selected text.')))}>{t('Copy text')}</ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.annotate} onClick={() => void annotateSelection(shown, selectedObjects.map(object => ({ objectId: object.id, blockId: object.textBlock!.id, range: [0, object.textBlock!.runs.reduce((length, run) => length + run.text.length, 0)], text: '', rects: [object.bounds] })), 'highlight')}>{t('Highlight text')}</ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => void executeCommands([{ type: 'text.style', pageId: shown.page.id, blockIds: [selectedObjects[0]!.textBlock!.id], style: { underline: true } }])}>{t('Underline text')}</ContextMenu.Item>
                    </>}
                    {selectedObjects.length === 1 && selectedObjects[0]?.type === 'image' && <>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => void runRibbonAction('replaceImage')}>{t('Replace image')}</ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => void runRibbonAction('cropImage')}>{t('Crop image')}</ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => void runRibbonAction('flipHorizontal')}>{t('Flip horizontally')}</ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => void runRibbonAction('flipVertical')}>{t('Flip vertically')}</ContextMenu.Item>
                    </>}
                    {selectedIds.length > 0 && <>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => void runRibbonAction('rotateLeft')}>{t('Rotate left')}</ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => void runRibbonAction('rotateRight')}>{t('Rotate right')}</ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify || !shown.info.permissions.copy} onClick={() => void runRibbonAction('duplicate')}>{t('Duplicate')}</ContextMenu.Item>
                      {selectedIds.length > 1 && <ContextMenu.Item className="ui-menu-item" onClick={() => chooseTool('arrange')}>{t('Align & distribute')}</ContextMenu.Item>}
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => void runRibbonAction('delete')}>{t('Delete')}<kbd>Del</kbd></ContextMenu.Item>
                      <ContextMenu.Separator className="ui-menu-separator" />
                    </>}
                    <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => insertTextAt(shown, objectContextPoint.current)}>{t('Add text here')}</ContextMenu.Item>
                    <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => void runRibbonAction('insertImage')}>{t('Add image')}</ContextMenu.Item>
                    <ContextMenu.Item className="ui-menu-item" disabled={isBusy} onClick={() => chooseTab('pages')}>{t('Organize pages')}</ContextMenu.Item>
                  </ContextMenu.Popup></ContextMenu.Positioner></ContextMenu.Portal>
                </ContextMenu.Root>}
                {pointer === 'select' && <PdfLinkLayer annotations={pageAnnotations} page={shown.page} render={shown.render}
                  pageOrder={shown.info.pageOrder} disabled={isBusy} onNavigate={(id, top) => void switchPage(id, top)} />}
                {placement && <div className="placement-layer" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); void placeObject((event.clientX - rect.left) / zoom, (event.clientY - rect.top) / zoom); }}><span>{t('Click on the page to place it. Press Esc to cancel.')}</span></div>}
                {cropPage && <ImageCropOverlay page bounds={{ x: 0, y: 0, width: shown.page.widthPt, height: shown.page.heightPt }} scale={zoom} disabled={isBusy}
                  onCancel={() => setCropPage(false)} onCrop={bounds => void executeCommands([{ type: 'pages.crop', pageIds: [shown.page.id], bounds }]).then(ok => { if (ok) setCropPage(false); })} />}
                {cropImage && selectedObjects[0]?.type === 'image' && <ImageCropOverlay bounds={selectedObjects[0].bounds} scale={zoom} disabled={isBusy}
                  onCancel={() => setCropImage(false)} onCrop={bounds => void executeCommands([{ type: 'image.crop', pageId: shown.page.id, objectId: selectedIds[0]!, bounds }]).then(ok => { if (ok) setCropImage(false); setCropPage(false); })} />}
              </>}
            </DocumentViewport>
          )}
          {activity === 'rendering' ? <div className="stage-progress">{t("Rendering page…")}</div> : null}
        </section>

        <aside className="inspector-panel" hidden={!activeTool} aria-label={t(activeTool ? toolNames[activeTool] : "Tools")}>
          <div className="panel-heading"><strong>{t(activeTool ? toolNames[activeTool] : "Tools")}</strong>
            <IconButton label={t('Close panel')} disabled={isDraftDirty} onClick={() => setActiveTool(null)}><PanelRightClose size={17} /></IconButton>
          </div>
          <div className="panel-content">
          {!document && activeTool !== 'ai' && <div className="panel-empty"><FilePlus2 size={28} /><p>{t('Open a PDF to get started.')}</p></div>}
          <div hidden={activeTool !== 'search'}>
          <PdfSearchPanel document={document?.info ?? null} engine={engine} disabled={isBusy} onLocate={locateTextBlock} onCommitted={handleCommitted} onBusyChange={setEditPending} />
          </div>

          {document && <div hidden={activeTool !== 'arrange' && activeTool !== 'pages'}><ObjectEditPanel mode={activeTool === 'pages' ? 'pages' : 'arrange'} section={pagePanelSection} pageSelection={tab === 'pages' ? pageTools.ids : null} document={document.info} page={document.page} selectedIds={selectedIds}
            engine={engine} host={host} disabled={isBusy} onBusyChange={setEditPending}
            onSelectionChange={ids => { setSelectedIds(ids); setSearchSelection(null); }} onCommitted={handleCommitted} /></div>}

          {document && <div hidden={activeTool !== 'arrange'}><ParagraphPanel document={document.info} page={document.page} selectedIds={selectedIds}
            engine={engine} disabled={operationBusy || textDraftDirty} onBusyChange={setEditPending} onDraftChange={setParagraphDraftDirty} onCommitted={handleCommitted} /></div>}
          {document && <div hidden={activeTool !== 'comment' && activeTool !== 'forms'}><DocumentToolsPanel mode={activeTool === 'forms' ? 'forms' : 'comment'} document={document.info} page={document.page} selectedIds={selectedIds}
            engine={engine} disabled={isBusy} onBusyChange={setEditPending} onCommitted={handleCommitted} /></div>}
          {document && <div hidden={activeTool !== 'sign'}><SignaturePanel document={document.info} page={document.page}
            engine={engine} disabled={isBusy} onBusyChange={setEditPending} onCommitted={handleCommitted} /></div>}

          {host.capabilities.ocr && document && <div hidden={activeTool !== 'ocr'}><OcrPanel document={document.info} page={document.page} selectedIds={selectedIds}
            engine={engine} disabled={isBusy} onBusyChange={setEditPending} onCommitted={handleCommitted} /></div>}

          <div hidden={activeTool !== 'fonts'}><FontPanel engine={engine} host={host} disabled={operationBusy} onBusyChange={setEditPending} /></div>
          {document && <div hidden={activeTool !== 'export'}><ExportPanel disabled={isBusy} encrypted={document.info.permissions.encrypted} signed={document.info.permissions.signed} onExport={exportDocument} /></div>}
          {document && (host.capabilities.platform === 'web' || host.printDocument) &&
            <div hidden={activeTool !== 'print'}><PrintPanel disabled={isBusy} docId={document.info.id} pageIds={document.info.pageOrder}
              encrypted={document.info.permissions.encrypted} canPrint={document.info.permissions.print === true}
              engine={engine} host={host} onBusyChange={setEditPending} /></div>}

          {hasAi && <div hidden={activeTool !== 'ai'}>
            {renderAiPanel ? renderAiPanel({ document: document?.info ?? null, page: document?.page ?? null,
              name: document?.name ?? null, selectedIds, engine, disabled: isBusy, onCommitted: handleCommitted,
              openDocument: source => openDocument(source), saveDocument }) : aiPanel}
          </div>}
          </div>
        </aside>
        <nav className="utility-tools" aria-label={t('Quick tools')}>
          <IconButton label="Find & replace" disabled={!document} aria-pressed={activeTool === 'search'} onClick={() => chooseTool('search')}><Search size={18} /></IconButton>
        </nav>
      </div>

      <footer className="editor-statusbar">
        <span className={error ? 'status-dot status-dot-error' : 'status-dot'} aria-hidden="true" />
        <span className="status-message" role={error ? 'alert' : 'status'}>{t(error ?? notice)}</span>
        <span className="status-spacer" />
        <ViewControls page={tab === 'pages' && document ? Math.max(0, document.info.pageOrder.indexOf(pageTools.focus)) + 1 : currentPageIndex + 1} pages={document?.info.pageOrder.length ?? 0} zoom={tab === 'pages' ? overviewWidth / 230 : zoom} busy={isBusy}
          onPage={page => { const id = document?.info.pageOrder[page - 1]; if (id) { if (tab === 'pages') { pageTools.select(id); stageRef.current?.querySelector<HTMLElement>(`[data-organizer-page="${id}"]`)?.scrollIntoView({ block: 'nearest' }); } else void switchPage(id); } }}
          onZoom={scale => { if (tab === 'pages') changeOverviewZoom(scale); else void changeZoom(scale); }} onFit={() => { if (tab === 'pages') setOverviewColumns(3); else fitPage(); }} />
      </footer>
    </main>
    </Tooltip.Provider>
  );
}

function EmptyCanvas({ busy, isWeb, onOpen }: { busy: boolean; isWeb: boolean; onOpen(): void }) {
  useI18n();
  return <div className="empty-canvas">
    <div className="empty-sheet" aria-hidden="true"><span>PDF</span><i /><i /><i /></div>
    <span className="welcome-kicker">{t('A little less paperwork.')}</span>
    <h1>{t('Make your PDF')}<br /><em>{t('work for you.')}</em></h1>
    <p>{t('Edit, organize and bring your ideas to the page.')}<br />{t('One workspace. Everything you need.')}</p>
    <button className="button button-primary button-large" type="button" onClick={onOpen} disabled={busy}><FilePlus2 size={19} />{t(busy ? "Opening…" : "Open PDF")}</button>
    <span className="drop-hint">{t(isWeb ? "or drop a PDF here" : "Choose a file from your computer")}</span>
    <div className="welcome-features"><span>{t('Edit text & images')}</span><span>{t('Organize pages')}</span><span>{t('Read continuously')}</span></div>
  </div>;
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
  setNotice('Saving…');
  try {
    const result = await engine.save({ docId: current.info.id, protection: 'preserve' });
    const outcome = await host.saveDocument(result, current.name);
    if (outcome?.status === 'download-started') {
      setNotice('Download started');
      return null;
    }
    const confirmed = await engine.confirmSave({ docId: result.docId, savedRevision: result.savedRevision });
    updateSavedRevision(result.docId, confirmed.savedRevision);
    setNotice('Saved');
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
  if (error instanceof EngineError) return error.message;
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
    shading: 'Gradient',
  };
  return names[type];
}
