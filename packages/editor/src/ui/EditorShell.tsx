import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  type SaveOutcome,
  type TextStyle,
  type TextAction,
  type KolmoDocumentInput,
  type KolmoFile,
} from '@pdf-editor/contracts';
import { DirectTextEditor, type TextEditorHandle } from './DirectTextEditor.js';
import { DocumentViewport, type PageView, type PointerTool, type ViewportSize } from './DocumentViewport.js';
import { useViewZoom } from './use-view-zoom.js';
import { usePanelResize, AI_PANEL_DEFAULT_WIDTH, AI_PANEL_MIN_WIDTH, AI_PANEL_MAX_WIDTH } from './usePanelResize.js';
import { captureReadingZoomAnchor, readingZoomScrollDelta, type ReadingZoomAnchor } from './view-zoom.js';
import { AnnotationLayer, type CommentSelection } from './AnnotationLayer.js';
import { AnnotationPopup } from './AnnotationPopup.js';
import { AnnotationDrawingLayer, type AnnotationDraftHandle } from './AnnotationDrawingLayer.js';
import type { AnnotationDrawingOptions } from './annotation-drawing.js';
import { SignaturePlacementLayer } from './SignaturePlacementLayer.js';
import type { SignatureDraft } from './signature-placement.js';
import { ImportPagesDialog } from './ImportPagesDialog.js';
import { EditorRibbon, type RibbonTab, type RibbonAction } from './EditorRibbon.js';
import { ImageCropOverlay } from './ImageCropOverlay.js';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Bookmark, Search, MessageSquare, PenLine, LayoutGrid, Folder, X, Languages } from 'lucide-react';
import { FontPanel } from './FontPanel.js';
import { ParagraphPanel, type ParagraphDraftHandle } from './ParagraphPanel.js';
import { SaveChangesDialog, type SaveChoice, type SavePrompt } from './SaveChangesDialog.js';
import { PasswordDialog, type PasswordPrompt } from './PasswordDialog.js';
import { ExportPanel, type ExportSettings, type ExportOutcome } from './ExportPanel.js';
import { PrintPanel } from './PrintPanel.js';
import { ObjectEditPanel } from './ObjectEditPanel.js';
import { DocumentToolsPanel, type DocumentToolsDraftHandle } from './DocumentToolsPanel.js';
import { SignaturePanel } from './SignaturePanel.js';
import { OcrPanel } from './OcrPanel.js';
import { PdfSearchPanel } from './PdfSearchPanel.js';
import { PageThumbnail } from './PageThumbnail.js';
import { PageOrganizer, PageContextMenu, usePageTools, type PageAction } from './PageOrganizer.js';
import { captureReadingSelection, type TextSelectionTarget } from './PdfTextLayer.js';
import { textActionSelection, textActionTarget, selectionMaterial, type TextActionSelection, type AiMaterial, type AiHandoff } from './text-actions.js';
import { TextActionPanel } from './TextActionPanel.js';
import { AiFloatingWindow } from './AiFloatingWindow.js';
import { TextActionMenuItems } from './TextActionMenu.js';
import { KolmoTranslationPanel } from './KolmoTranslationPanel.js';
import './ai-tools.css';
import { mergeTextRects, type TextHit } from './text-geometry.js';
import { adjacentPageId } from './page-navigation.js';
import { readingRegions } from './reading-order.js';
import { renderPage } from './draw-render.js';
import { ObjectSelectionLayer as SelectionLayer } from './ObjectSelectionLayer.js';
import { normalizeSelection, objectSelectionIds, pickObject, selectionScope } from './object-selection.js';
import { detectParagraph, selectedTextObject } from './paragraph-detection.js';
import { PdfLinkLayer } from './PdfLinkLayer.js';
import { addImportedFont, useFontResources, ensureEditorFont } from './font-resources.js';
import { resolveSourceFont } from './font-face-matcher.js';
import {
  checkRecoverableSessions,
  persistRecoverySnapshot,
  discardRecoveryRecord,
  restoreRecoveryRecord,
  type RecoverySessionMeta,
} from '../recovery/index.js';
import { EditorTopbar, ViewControls, IconButton, Tooltip, PanelRightClose, FilePlus2, toolNames, type EditorTool } from './EditorChrome.js';
import { useI18n, translate as t } from './i18n.js';
import { AppDialog } from './AppDialog.js';
import { StartPage, readWebRecent, writeWebRecent, type RecentFileEntry } from './StartPage.js';
import { DocumentTabs } from './DocumentTabs.js';
import { useDocumentSessions } from './use-document-sessions.js';
import './editor.css';

const RENDER_SCALE = 1.25;

type EditorShellProps = {
  engine: EngineAdapter;
  host: HostAdapter;
  productName?: string;
  preferenceOwner?: string | null | undefined;
  aiPanel?: ReactNode;
  renderAiPanel?: (context: EditorAiContext) => ReactNode;
  source?: DocumentSource | null;
  sources?: DocumentSource[] | null;
  onSourcesConsumed?: () => void;
  onOpenFolder?: () => void;
  recentFiles?: RecentFileEntry[];
  onOpenRecent?: (entry: RecentFileEntry) => void;
  onForgetRecent?: (id: string) => void;
  onRequestRecent?: () => void;
  onActivateDocument?: (id: string) => void;
  onClosePreview?: () => void;
  onSourceConsumed?: (opened: boolean) => void;
  onSaved?: (docId: string, outcome?: SaveOutcome) => void;
  onResultsReady?: () => void;
  onDocumentChange?: (state: { document: DocumentInfo | null; busy: boolean; draftDirty: boolean; name?: string; identity?: string; location?: string }) => void;
  closeDocumentRef?: { current: (() => Promise<boolean>) | null };
  externalBusy?: boolean;
  allowReadOnlyNavigation?: boolean;
  headerActions?: ReactNode;
  workspacePanel?: ReactNode;
  workspaceId?: string | null;
  workspacePreview?: { name: string; content: ReactNode } | null;
  onActivityChange?: (busy: boolean) => void;
};

export type EditorAiContext = {
  documents?: { id: string; name: string; info?: DocumentInfo; identity?: string }[];
  handoff?: AiHandoff | null;
  onHandoffConsumed?(id: string): void;
  getDocumentInfo?(id: string): DocumentInfo | null;
  locateMaterial?(material: AiMaterial): Promise<void>;
  draftDirty?: boolean;
  finishDrafts?(): Promise<boolean>;
  document: DocumentInfo | null;
  page: PageModel | null;
  name: string | null;
  selectedIds: string[];
  engine: EngineAdapter;
  disabled: boolean;
  onCommitted(result: CommitResult): Promise<void>;
  openDocument(source: DocumentSource): Promise<DocumentInfo | null>;
  saveDocument(): Promise<SaveConfirmation | null>;
  navigationDisabled?: boolean;
  showAiPanel?(): void;
  navigatePage?(pageId: string): Promise<void>;
  locateText?(pageId: string, blockId: string, range?: { start: number; end: number }): void;
};

export type LoadedDocument = {
  info: DocumentInfo;
  name: string;
  page: PageModel;
  render: RenderResult;
  pageVersion?: number;
};

export function mergeSavedRevision(current: LoadedDocument, savedRevision: number): LoadedDocument {
  return { ...current, info: { ...current.info, savedRevision } };
}

type Activity = 'idle' | 'opening' | 'rendering' | 'saving' | 'editing';

export function EditorShell({ engine, host, preferenceOwner, productName = 'komopdf', aiPanel, renderAiPanel,
  source: externalSource, sources: externalSources, onSourcesConsumed, onSourceConsumed, onSaved, onResultsReady, onDocumentChange, closeDocumentRef, externalBusy = false, allowReadOnlyNavigation = false, onActivityChange, headerActions,
  onOpenFolder, recentFiles, onOpenRecent, onForgetRecent, onRequestRecent, onActivateDocument, onClosePreview,
  workspacePanel, workspaceId, workspacePreview }: EditorShellProps) {
  useI18n();
  const sessions = useDocumentSessions();
  const { document, documentRef, setDocument, history, setHistory, zoom, setZoom, selectedIds, setSelectedIds,
    view, setView, continuous, setContinuous, pointer, setPointer, tab, setTab } = sessions;
  const [startOpen, setStartOpen] = useState(false);
  const [webRecent, setWebRecent] = useState<RecentFileEntry[]>(readWebRecent);
  const batchOpening = useRef(false);
  const openFailure = useRef<string | null>(null);
  const [activeTool, setActiveTool] = useState<EditorTool | null>(null);
  const [textSelections, setTextSelections] = useState<Record<string, TextActionSelection>>({});
  const [textWindowOpen, setTextWindowOpen] = useState(false);
  const [documentTranslationOpen, setDocumentTranslationOpen] = useState(false);
  const [textHelp, setTextHelp] = useState<'selection' | 'scan' | null>(null);
  const [aiHandoff, setAiHandoff] = useState<AiHandoff | null>(null);
  const [aiContextDocumentId, setAiContextDocumentId] = useState<string | null>(null);
  const capturedTextSelection = useRef<TextActionSelection | null>(null);
  const activeTextSelection = document ? textSelections[document.info.id] ?? null : null;
  useEffect(() => {
    setTextSelections(previous => Object.keys(previous).some(id => !sessions.state.documents.has(id))
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => sessions.state.documents.has(id))) : previous);
  }, [sessions.state.documents]);
  const [railOpen, setRailOpen] = useState(true);
  const [railTab, setRailTab] = useState<'pages' | 'bookmarks' | 'files'>('pages');
  const hasWorkspace = workspacePanel != null;
  const previewActive = Boolean(workspacePreview);
  useEffect(() => {
    if (hasWorkspace && workspaceId) { setRailTab('files'); setRailOpen(true); }
  }, [hasWorkspace, workspaceId]);
  const [overviewWidth, setOverviewWidth] = useState(230);
  const [overviewColumns, setOverviewColumns] = useState(3);
  const [inlineRange, setInlineRange] = useState<[number, number] | null>(null);
  const [inlineRangeIsLogical, setInlineRangeIsLogical] = useState(false);
  const [inlineHit, setInlineHit] = useState<TextHit | null>(null);
  const [pagePanelSection, setPagePanelSection] = useState<'number' | 'watermark' | 'header' | null>(null);
  const objectContextPoint = useRef({ x: 36, y: 36 });
  const [pageHost, setPageHost] = useState<HTMLDivElement | null>(null);
  const [cropImage, setCropImage] = useState(false);
  const [cropPage, setCropPage] = useState(false);
  const [placement, setPlacement] = useState<{ kind: 'text' } | { kind: 'image'; resourceId: string; width: number; height: number } | null>(null);
  const [annotationDrawing, setAnnotationDrawing] = useState<AnnotationDrawingOptions | null>(null);
  const [reusableSignature, setReusableSignature] = useState<SignatureDraft | null>(null);
  const [pendingSignature, setPendingSignature] = useState<SignatureDraft | null>(null);
  const [viewSize, setViewSize] = useState<ViewportSize | null>(null);
  const zoomAnchor = useRef<{ pageId: string; position: ReadingZoomAnchor; scale: number } | null>(null);
  const [presenting, setPresenting] = useState(false);
  const beforePresentation = useRef({ view, continuous, pointer });
  const textEditor = useRef<TextEditorHandle | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const { fonts } = useFontResources(engine, host);
  const hasAi = Boolean(renderAiPanel || aiPanel);
  const aiPanelActive = hasAi && activeTool === 'ai';
  const [dragOver, setDragOver] = useState(false);
  const stageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const faces = new Map((document?.page.objects ?? []).flatMap(object => object.textBlock?.runs ?? [])
      .map(run => resolveSourceFont(fonts, run.style)).filter(font => font?.systemId && font.editableEmbedding !== false)
      .map(font => [font!.id, font!]));
    for (const face of faces.values()) void ensureEditorFont(engine, face).catch(() => undefined);
  }, [engine, document?.page, fonts]);
  const railVisible = railOpen && (railTab === 'files' ? hasWorkspace : Boolean(document) && tab !== 'pages');
  const panelVisible = Boolean(activeTool) && (!previewActive || activeTool === 'ai');
  const { workspaceRef, separatorRef, resizing: panelResizing } = usePanelResize(aiPanelActive, railVisible);
  const [activity, setActivity] = useState<Activity>('idle');
  const [notice, setNotice] = useState('Ready');
  const [error, setError] = useState<string | null>(null);
  const [inlineTextId, setInlineTextId] = useState<string | null>(null);
  const [copiedTextFormat, setCopiedTextFormat] = useState<TextStyle | null>(null);
  const [searchSelection, setSearchSelection] = useState<{ docId: string; revision: number; pageId: string; blockId: string; start: number; end: number; key: number } | null>(null);
  const searchLocationSequence = useRef(0);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [outlineError, setOutlineError] = useState(false);
  const [pageAnnotations, setPageAnnotations] = useState<import('@pdf-editor/contracts').PdfAnnotationInfo[]>([]);
  const [editPending, setEditPending] = useState(false);
  const [textDraftDirty, setTextDraftDirty] = useState(false);
  const [paragraphDraftDirty, setParagraphDraftDirty] = useState(false);
  const [commentSelection, setCommentSelection] = useState<CommentSelection | null>(null);
  const commentDraft = useRef<AnnotationDraftHandle | null>(null);
  const [commentDirty, setCommentDirty] = useState(false);
  const [noteDraftPage, setNoteDraftPage] = useState<string | null>(null);
  const noteDraft = useRef<{ pageId: string; handle: AnnotationDraftHandle } | null>(null);
  const [formDraftDirty, setFormDraftDirty] = useState(false);
  const formDraft = useRef<DocumentToolsDraftHandle | null>(null);
  const paragraphDraft = useRef<ParagraphDraftHandle | null>(null);
  const isTextDraftDirty = textDraftDirty || paragraphDraftDirty;
  const isDraftDirty = isTextDraftDirty || formDraftDirty || noteDraftPage !== null || commentDirty;
  const registerNoteDraft = useCallback((pageId: string, handle: AnnotationDraftHandle | null) => {
    if (handle) { noteDraft.current = { pageId, handle }; setNoteDraftPage(pageId); }
    else if (noteDraft.current?.pageId === pageId) { noteDraft.current = null; setNoteDraftPage(null); }
  }, []);
  const finishDrafts = async (): Promise<boolean> => {
    if (textDraftDirty && !await textEditor.current?.finish()) { setTab('edit'); return false; }
    if (paragraphDraftDirty && !await paragraphDraft.current?.finish()) {
      setActiveTool('arrange'); setError(t('Apply or discard the paragraph draft to continue.')); return false;
    }
    if (formDraftDirty && !await formDraft.current?.finish()) {
      setActiveTool('forms'); setError(t('Check the form fields before continuing.')); return false;
    }
    if (noteDraft.current && !await noteDraft.current.handle.finish()) { setActiveTool('comment'); return false; }
    if (commentDraft.current && !await commentDraft.current.finish()) return false;
    return true;
  };
  const [savePrompt, setSavePrompt] = useState<SavePrompt | null>(null);
  const saveResolver = useRef<((choice: SaveChoice) => void) | null>(null);
  const askSaveChanges = (name: string, downloaded = false) => new Promise<SaveChoice>(resolve => {
    saveResolver.current?.('cancel');
    const answer = (choice: SaveChoice) => { saveResolver.current = null; setSavePrompt(null); resolve(choice); };
    saveResolver.current = answer; setSavePrompt({ name, resolve: answer, web: host.capabilities.platform === 'web', downloaded });
  });
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState<RecoverySessionMeta[]>([]);
  const passwordResolver = useRef<((value: string | null) => void) | null>(null);
  const openSequence = useRef(0);
  useEffect(() => () => { openSequence.current++; passwordResolver.current?.(null); saveResolver.current?.('cancel'); }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    void checkRecoverableSessions(host).then((sessions) => {
      if (!cancelled) setPendingRecovery(sessions.filter(session => session.revision !== session.savedRevision).reverse());
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

  useEffect(() => { setInlineTextId(id => document?.page.objects.some(object => object.id === id) ? id : null); }, [document?.info.id, document?.page.id]);
  useEffect(() => { setAnnotationDrawing(null); setPendingSignature(null); setCommentSelection(null); }, [document?.info.id]);
  useEffect(() => { setPendingSignature(null); }, [document?.page.id, document?.info.revision]);
  useEffect(() => {
    if (activeTool !== 'comment') setAnnotationDrawing(null);
    if (activeTool !== 'sign') setPendingSignature(null);
  }, [activeTool]);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current, root = stageRef.current;
    if (!anchor || !root || anchor.scale !== zoom) return;
    zoomAnchor.current = null;
    const page = [...root.querySelectorAll<HTMLElement>('[data-document-page]')].find(node => node.dataset.documentPage === anchor.pageId);
    if (!page) return;
    const delta = readingZoomScrollDelta(anchor.position, page.getBoundingClientRect(), root.getBoundingClientRect(), zoom);
    root.scrollTop += delta.top;
    root.scrollLeft += delta.left;
  }, [zoom]);
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
    for (const session of sessions.current.current.documents.values()) void engine.close(session.loaded.info.id).catch(() => undefined);
  }, [engine]);

  const captureView = () => {
    const active = documentRef.current, stage = stageRef.current;
    if (active && stage) sessions.patch(active.info.id, { scroll: { top: stage.scrollTop, left: stage.scrollLeft } });
  };
  useLayoutEffect(() => {
    const active = sessions.current.current.activeId;
    const view = active ? sessions.current.current.documents.get(active) : undefined;
    if (view && stageRef.current) { stageRef.current.scrollTop = view.scroll.top; stageRef.current.scrollLeft = view.scroll.left; }
  }, [document?.info.id]);
  const rememberOpened = (name: string) => {
    if (host.capabilities.platform !== 'web') return;
    setWebRecent(previous => {
      const next = [{ id: name, name, kind: 'pdf' as const, location: '', updatedAt: Date.now() }, ...previous.filter(entry => entry.name !== name)].slice(0, 12);
      writeWebRecent(next); return next;
    });
  };

  const triggerAutoRecovery = (docInfo: DocumentInfo, name: string): void => {
    void persistRecoverySnapshot(engine, host, { info: docInfo, name }).catch(() => {
      setNotice('Auto-recovery snapshot unavailable for current changes');
    });
  };

  const updateSavedRevision = (docId: string, savedRevision: number, name?: string, outcome?: SaveOutcome): void => {
    sessions.save(docId, savedRevision, { status: 'written', ...outcome, ...(name ? { name } : {}) });
    const updated = sessions.current.current.documents.get(docId)?.loaded;
    if (updated) triggerAutoRecovery(updated.info, updated.name);
    onSaved?.(docId, outcome);
  };
  const recordDownload = (docId: string, revision: number) => sessions.patch(docId, { downloadedRevision: revision });

  const restorePendingRecovery = async (targetSession: RecoverySessionMeta): Promise<void> => {
    if (isDraftDirty) {
      setError('Apply or discard the current text draft before restoring');
      return;
    }
    if (host.capabilities.platform === 'web' && sessions.current.current.documents.size >= WEB_LIMITS.openDocuments) {
      setError(t('Close a PDF before restoring another document.')); return;
    }
    captureView(); setStartOpen(false);
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
        sessions.add(loaded);
        setSelectedIds([]);
        setSearchSelection(null);
        setTextDraftDirty(false);
        setParagraphDraftDirty(false);
        setHistory({ canUndo: info.revision > 0, canRedo: false });
        setZoom(RENDER_SCALE);
        setNotice('Ready');
        setPendingRecovery(items => items.filter(item => item.docId !== targetSession.docId));
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

  const discardPendingRecovery = async (docId: string): Promise<void> => {
    try {
      await discardRecoveryRecord(host, docId);
      setPendingRecovery(items => items.filter(item => item.docId !== docId));
      setNotice('Discarded uncommitted session');
    } catch { setError('Unable to clean up discarded recovery session'); }
  };

  const openDocument = async (suppliedSource?: DocumentSource): Promise<DocumentInfo | null> => {
    if (!suppliedSource) return openDocuments();
    openFailure.current = null;
    if (isDraftDirty && !await finishDrafts()) return null;
    const existing = suppliedSource.identity && [...sessions.current.current.documents.values()].find(session =>
      (session.saveIdentity ?? session.identity) === suppliedSource.identity);
    if (existing) {
      captureView(); sessions.activate(existing.loaded.info.id); onActivateDocument?.(existing.loaded.info.id);
      setStartOpen(false); return existing.loaded.info;
    }
    const web = host.capabilities.platform === 'web';
    if (web && sessions.current.current.documents.size >= WEB_LIMITS.openDocuments) {
      const message = t('The web editor can keep only {count} PDFs open. Close one before opening another.', { count: WEB_LIMITS.openDocuments });
      openFailure.current = message; setError(message); return null;
    }
    const previous = documentRef.current;
    captureView(); setError(null);
    const sequence = ++openSequence.current;
    passwordResolver.current?.(null);
    setActivity('opening'); setNotice('Opening…');
    try {
      const source = suppliedSource;
      let password: string | undefined;
      let loaded: LoadedDocument;
      for (;;) {
        try {
          const attempt = source.kind === 'bytes' ? { ...source, bytes: source.bytes.slice(0) } : source;
          loaded = await openLoadedDocument(engine, attempt, password); break;
        } catch (caught) {
          if (sequence !== openSequence.current) return null;
          if (!(caught instanceof EngineError) || caught.code !== 'PASSWORD_REQUIRED') throw caught;
          const answer = await askPassword(source.name, password !== undefined);
          if (answer === null || sequence !== openSequence.current) { setNotice('Open cancelled'); return null; }
          password = answer;
        }
      }
      if (sequence !== openSequence.current) { await engine.close(loaded.info.id); return null; }
      if (web && loaded.info.pageOrder.length > WEB_LIMITS.pagesPerDocument) {
        await engine.close(loaded.info.id);
        throw new EngineError('RESOURCE_LIMIT', 'The web editor supports at most 200 pages per PDF');
      }
      sessions.add(loaded, source);
      setStartOpen(false); setActiveTool(null); setPlacement(null); setInlineTextId(null);
      setSearchSelection(null); setTextDraftDirty(false); setParagraphDraftDirty(false); setFormDraftDirty(false);
      setNotice('Ready'); rememberOpened(source.name);
      triggerAutoRecovery(loaded.info, loaded.name);
      return loaded.info;
    } catch (caught) {
      if (sequence === openSequence.current) {
        openFailure.current = formatError(caught); setError(openFailure.current);
        setNotice(previous ? 'New document not opened; current document retained' : 'Document not opened');
      }
      return null;
    } finally { if (sequence === openSequence.current) setActivity('idle'); }
  };

  const openDocuments = async (suppliedSources?: DocumentSource[]): Promise<DocumentInfo | null> => {
    if (batchOpening.current || (isDraftDirty && !await finishDrafts())) return null;
    if (host.capabilities.platform === 'web' && !suppliedSources && sessions.current.current.documents.size >= WEB_LIMITS.openDocuments) {
      setError(t('The web editor can keep only {count} PDFs open. Close one before opening another.', { count: WEB_LIMITS.openDocuments })); return null;
    }
    batchOpening.current = true;
    try {
      const selected = suppliedSources ?? (host.pickDocuments ? await host.pickDocuments() : [await host.pickDocument()].filter((source): source is DocumentSource => source !== null));
      if (!selected.length) { setNotice('No file selected'); return null; }
      const newCount = selected.filter(source => !source.identity || ![...sessions.current.current.documents.values()].some(session => (session.saveIdentity ?? session.identity) === source.identity)).length;
      if (host.capabilities.platform === 'web' && sessions.current.current.documents.size + newCount > WEB_LIMITS.openDocuments) {
        setError(t('The web editor can keep only {count} PDFs open. Close one before opening another.', { count: WEB_LIMITS.openDocuments })); return null;
      }
      const failures: string[] = [];
      let last: DocumentInfo | null = null;
      for (const source of selected) {
        const opened = await openDocument(source);
        if (opened) last = opened;
        else failures.push(source.name + ': ' + (openFailure.current ?? t('Open cancelled')));
      }
      if (failures.length) setError(failures.join('\n'));
      return last;
    } catch (caught) { setError(formatError(caught)); return null; }
    finally { batchOpening.current = false; }
  };

  const switchPage = async (pageId: string, targetTopPt?: number): Promise<void> => {
    if (previewActive || navigationBusy) return;
    if (isDraftDirty && !await finishDrafts()) return;
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

  const saveDocument = async (saveAs = false, targetId?: string): Promise<SaveConfirmation | null> => {
    if (isDraftDirty && !await finishDrafts()) return null;
    const current = targetId ? sessions.current.current.documents.get(targetId)?.loaded : documentRef.current;
    if (!current) return null;
    return saveCurrentDocument(current, engine, host, updateSavedRevision, setError, setNotice, setActivity, saveAs, recordDownload);
  };

  const exportDocument = async (options: ExportSettings, signal: AbortSignal,
    progress: (value: import('@pdf-editor/contracts').ConversionProgress) => void): Promise<ExportOutcome> => {
    if (isDraftDirty && !await finishDrafts()) throw new Error('Apply or discard the text draft before exporting');
    const current = documentRef.current;
    if (!current) throw new Error('Open a PDF first');
    signal.throwIfAborted();
    setActivity('saving'); setError(null); setNotice('Exporting a local copy…');
    try {
      if (options.format === 'pdf') {
        const { format: _format, ...settings } = options;
        const result = await engine.save({ docId: current.info.id, ...settings });
        signal.throwIfAborted();
        const suffix = options.protection === 'set' ? 'protected' : options.protection === 'remove' ? 'unprotected' : options.optimize ? 'optimized' : 'copy';
        const name = `${current.name.replace(/\.pdf$/i, '')}-${suffix}.pdf`;
        const outcome = host.saveExport ? await host.saveExport({ ...result, jobId: crypto.randomUUID(),
          extension: 'pdf', mimeType: 'application/pdf', warnings: [], pageIndices: current.info.pageOrder.map((_, index) => index) }, name)
          : await host.saveDocument(result, name);
        if (outcome?.status === 'cancelled') { setNotice('Export cancelled'); return { status: 'cancelled', warnings: [], format: 'PDF', pageCount: 0 }; }
        setNotice(outcome?.status === 'download-started' ? 'Export download started; active document unchanged' : 'Exported PDF copy; active document unchanged');
        return { ...outcome, status: outcome?.status ?? 'written', name: outcome?.name ?? name, warnings: [], format: 'PDF', pageCount: current.info.pageOrder.length };
      }
      if (!current.info.permissions.copy) throw new EngineError('UNSUPPORTED_CAPABILITY', 'This PDF does not allow copying its content');
      if (!host.saveExport) throw new EngineError('UNSUPPORTED_CAPABILITY', 'This host does not support format conversion');
      const { conversionPages, convertInBrowser, BROWSER_EXPORT_LIMITS } = await import('./document-conversion.js');
      const request = { jobId: crypto.randomUUID(), format: options.format,
        pageIndices: conversionPages(options.pages, current.info.pageOrder.length, current.info.pageOrder.indexOf(current.page.id),
          host.convertDocument ? Infinity : BROWSER_EXPORT_LIMITS.pageInstances),
        dpi: options.dpi, quality: options.quality };
      const result = host.convertDocument
        ? await host.convertDocument(await engine.save({ docId: current.info.id, protection: 'remove' }), request, progress, signal)
        : await convertInBrowser(engine, current.info, current.name, request, progress, signal);
      try {
        signal.throwIfAborted();
        const outcome = await host.saveExport(result, `${current.name.replace(/\.pdf$/i, '')}.${result.extension}`);
        if (outcome?.status === 'cancelled') { setNotice('Export cancelled'); return { status: 'cancelled', warnings: [], format: request.format.toUpperCase(), pageCount: 0 }; }
        setNotice(outcome?.status === 'download-started' ? 'Export download started; active document unchanged' : 'Exported local copy; active document unchanged');
        return { ...outcome, status: outcome?.status ?? 'written', name: outcome?.name ?? current.name.replace(/\.pdf$/i, '') + '.' + result.extension,
          format: request.format.toUpperCase(), pageCount: result.pageIndices.length,
          warnings: result.warnings.map(warning => warning.message + (warning.pageIndices.length ? ' (' + warning.pageIndices.map(index => index + 1).join(', ') + ')' : '')) };
      } finally { await host.releaseExport?.(result); }
      // Export never confirms the active document as saved.
    } catch (caught) {
      setNotice(signal.aborted ? 'Conversion cancelled' : 'Export not completed'); throw caught;
    } finally { setActivity('idle'); }
  };

  const handleCommitted = async (result: CommitResult, action = 'Committed'): Promise<void> => {
    const current = documentRef.current;
    const target = sessions.current.current.documents.get(result.docId);
    if (!target || result.revision <= target.loaded.info.revision) return;
    if (!current || current.info.id !== result.docId) {
      const info = { ...target.loaded.info, revision: result.revision, pageOrder: result.pageOrder };
      const pageId = info.pageOrder.includes(target.loaded.page.id) ? target.loaded.page.id : info.pageOrder[0];
      if (!pageId) return;
      const loaded = await loadPage(engine, info, target.loaded.name, pageId, target.zoom);
      sessions.patch(result.docId, { loaded, history: { canUndo: result.canUndo, canRedo: result.canRedo } });
      triggerAutoRecovery(info, loaded.name); return;
    }
    const info: DocumentInfo = {
      ...current.info,
      revision: result.revision,
      pageOrder: result.pageOrder,
    };
    const committed = { ...current, info };
    documentRef.current = committed;
    setHistory({ canUndo: result.canUndo, canRedo: result.canRedo });
    setNotice(action === 'Undid to' ? 'Undone' : action === 'Redid to' ? 'Redone' : 'Changes applied');

    const pageId = result.pageOrder.includes(current.page.id) ? current.page.id : result.pageOrder[0];
    if (!pageId) {
      setError('Changes committed, but document has no displayable pages');
      return;
    }
    setActivity('rendering');
    try {
      const unchanged = pageId === current.page.id && !result.changedPageIds.includes(pageId)
        && current.pageVersion !== undefined && current.pageVersion === engine.getPageVersion?.(info.id, pageId);
      const loaded = unchanged ? { ...current, info } : await loadPage(engine, info, current.name, pageId, zoom);
      const latest = documentRef.current;
      if (!latest || latest.info.id !== result.docId || latest.info.revision !== result.revision) return;
      const refreshed = { ...loaded, info: latest.info };
      documentRef.current = refreshed;
      setDocument(refreshed);
      setSelectedIds((ids) => {
        const retained = normalizeSelection(refreshed.page, [...new Set(ids
          .filter(id => refreshed.page.objects.some(object => object.id === id))
          .flatMap(id => objectSelectionIds(refreshed.page, id)))]);
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
      setDocument(committed);
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
    if (previewActive || navigationBusy) return;
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
        requestAnimationFrame(() => scrollToPage(pageId, target?.bounds.y ?? 0));
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
    const select = () => {
      const page = documentRef.current?.page;
      if (!page || !page.objects.some(object => object.id === objectId)) return;
      const ids = objectSelectionIds(page, objectId);
      setInlineTextId(null); setInlineRange(null);
      setSearchSelection(null);
      setCropImage(false); setCropPage(false);
      setSelectedIds(current => normalizeSelection(page, !additive ? ids : ids.every(id => current.includes(id))
        ? current.filter(id => !ids.includes(id)) : [...new Set([...current, ...ids])]));
    };
    if (isDraftDirty) { void finishDrafts().then(ok => { if (ok) select(); }); return; }
    select();
  };

  const changeZoom = async (scale: number): Promise<void> => {
    const current = documentRef.current;
    if (!current || navigationBusy) return;
    setActivity('rendering'); setError(null);
    try {
      const render = await renderPage(engine, current.info.id, current.page, scale, current.info.revision);
      const latest = documentRef.current;
      if (!latest || latest.info.id !== current.info.id || latest.page.id !== current.page.id || latest.info.revision !== current.info.revision) return;
      const root = stageRef.current;
      const page = [...(root?.querySelectorAll<HTMLElement>('[data-document-page]') ?? [])].find(node => node.dataset.documentPage === current.page.id);
      if (root && page) {
        zoomAnchor.current = { pageId: current.page.id, scale,
          position: captureReadingZoomAnchor(page.getBoundingClientRect(), root.getBoundingClientRect(), zoom) };
      }
      const updated = { ...latest, render };
      documentRef.current = updated; setDocument(updated); setZoom(scale);
    } catch (caught) { setError(formatError(caught)); }
    finally { setActivity('idle'); }
  };

  const switchDocument = async (docId: string): Promise<void> => {
    if (activity !== 'idle' || editPending || externalBusy || (isDraftDirty && !await finishDrafts())) return;
    captureView(); sessions.activate(docId); onActivateDocument?.(docId);
    setAiContextDocumentId(null); capturedTextSelection.current = null;
    setSearchSelection(null); setInlineTextId(null); setPlacement(null); setCropImage(false); setCropPage(false);
    setActiveTool(null); setError(null); setNotice('Ready');
  };

  const closeDocument = async (docId = documentRef.current?.info.id): Promise<boolean> => {
    if (!docId || !await closeHandler.current(docId)) return false;
    const wasActive = docId === documentRef.current?.info.id;
    setActivity('opening'); setError(null);
    try {
      await engine.close(docId);
      sessions.remove(docId);
      if (wasActive) {
        setSearchSelection(null); setTextDraftDirty(false); setParagraphDraftDirty(false); setFormDraftDirty(false);
        setInlineTextId(null); setPlacement(null); setCropImage(false); setCropPage(false); setActiveTool(null);
        const next = sessions.current.current.activeId;
        if (next) onActivateDocument?.(next);
      }
      try { await discardRecoveryRecord(host, docId); } catch { setNotice('Recovery cleanup will be retried next time'); }
      setPendingRecovery(items => items.filter(item => item.docId !== docId));
      setNotice('Document closed'); return true;
    } catch (caught) { setError(formatError(caught)); return false; }
    finally { setActivity('idle'); }
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

  const resizeTextFrames = async (objectIds: string[], frame: import('@pdf-editor/contracts').Rect): Promise<void> => {
    const current = documentRef.current;
    if (!current || isDraftDirty || activity !== 'idle' || editPending || externalBusy) return;
    setActivity('editing'); setError(null);
    let targetPage = current.page;
    let targets = objectIds.map(id => targetPage.objects.find(object => object.id === id)!);
    try {
      const flow = targets[0]?.textBlock?.flow;
      if (flow && flow.start !== 0) {
        for (const pageId of current.info.pageOrder) {
          const page = pageId === current.page.id ? current.page : await engine.describePage(current.info.id, pageId);
          const anchor = page.objects.find(object => object.textBlock?.flow?.id === flow.id && object.textBlock.flow.start === 0);
          if (anchor) { targetPage = page; targets = [anchor]; break; }
        }
      }
      const blockIds = targets.map(object => object?.textBlock?.id);
      if (blockIds.some(id => !id)) throw new Error('The selected text frame is unavailable');
      const result = await new CommandRegistry(engine).execute({
        id: crypto.randomUUID(), docId: current.info.id, baseRevision: current.info.revision,
        source: 'manual', commands: [{ type: 'text.resize', pageId: targetPage.id, blockIds: blockIds as string[], frame }],
      }, { document: current.info, pages: new Map([[targetPage.id, targetPage]]) });
      documentRef.current = { ...current, page: targetPage };
      setSelectedIds([targets[0]!.id]);
      await handleCommitted(result);
    } catch (caught) { setError(formatError(caught)); }
    finally { setActivity('idle'); }
  };

  const currentPageIndex = document ? document.info.pageOrder.indexOf(document.page.id) : -1;
  const selectedObjects = useMemo(() => {
    const ids = new Set(selectedIds);
    return document?.page.objects.filter(object => ids.has(object.id)) ?? [];
  }, [document?.page, selectedIds]);
  const selectedText = useMemo(() => document ? selectedTextObject(document.page, selectedIds)?.textBlock : undefined,
    [document?.page, selectedIds]);
  const modalOpen = Boolean(savePrompt || passwordPrompt);
  const operationBusy = activity !== 'idle' || editPending || externalBusy || modalOpen;
  const isBusy = operationBusy || isDraftDirty;
  const navigationBusy = activity !== 'idle' || editPending || modalOpen || isDraftDirty || (externalBusy && !allowReadOnlyNavigation);
  useEffect(() => { onActivityChange?.(activity !== 'idle' || editPending || isDraftDirty); }, [activity, editPending, isDraftDirty, onActivityChange]);
  useEffect(() => { onDocumentChange?.({ document: document?.info ?? null, busy: operationBusy, draftDirty: isDraftDirty,
    ...(document ? { name: document.name } : {}),
    ...(sessions.active?.saveIdentity ?? sessions.active?.identity ? { identity: sessions.active?.saveIdentity ?? sessions.active?.identity } : {}),
    ...(sessions.active?.saveLocation ?? sessions.active?.location ? { location: sessions.active?.saveLocation ?? sessions.active?.location } : {}) }); },
    [document?.info, document?.name, operationBusy, isDraftDirty, sessions.active?.saveIdentity, sessions.active?.identity, sessions.active?.saveLocation, sessions.active?.location, onDocumentChange]);
  const closeHandler = useRef<(docId?: string, continuing?: boolean) => Promise<boolean>>(async () => true);
  closeHandler.current = async (docId = documentRef.current?.info.id, continuing = false) => {
    if (docId === documentRef.current?.info.id && isDraftDirty && !await finishDrafts()) return false;
    if (!continuing && operationBusy) { setError('Finish or stop the current operation before closing'); return false; }
    const session = docId ? sessions.current.current.documents.get(docId) : undefined;
    const current = session?.loaded;
    if (!current || current.info.revision === current.info.savedRevision) return true;
    let downloaded = session?.downloadedRevision === current.info.revision;
    for (;;) {
      const choice = await askSaveChanges(current.name, downloaded);
      if (choice === 'cancel') return false;
      if (choice === 'discard') return true;
      const saved = await saveCurrentDocument(current, engine, host, updateSavedRevision, setError, setNotice, setActivity, false, recordDownload);
      if (saved) return true;
      downloaded = sessions.current.current.documents.get(current.info.id)?.downloadedRevision === current.info.revision;
      if (host.capabilities.platform !== 'web' || !downloaded) return false;
    }
  };
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (host.onCloseRequested) {
      void host.onCloseRequested(async () => {
        const ids = [...sessions.current.current.documents.keys()];
        if (!ids.length) return closeHandler.current();
        for (let index = 0; index < ids.length; index++) if (!await closeHandler.current(ids[index], index > 0)) return false;
        try {
          for (const id of ids) {
            await engine.close(id); sessions.remove(id);
            await discardRecoveryRecord(host, id).catch(() => undefined);
          }
          return true;
        } catch (caught) { setError('Could not close PDF session: ' + formatError(caught)); return false; }
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
      if (isBusy || (current && current.info.revision !== current.info.savedRevision && sessions.current.current.documents.get(current.info.id)?.downloadedRevision !== current.info.revision) ||
        [...sessions.current.current.documents.values()].some(session => session.loaded.info.revision !== session.loaded.info.savedRevision && session.downloadedRevision !== session.loaded.info.revision)) {
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

  const lastExternalSources = useRef<DocumentSource[] | null>(null);
  useEffect(() => {
    if (!externalSources || externalSources === lastExternalSources.current) return;
    lastExternalSources.current = externalSources;
    void openDocuments(externalSources).finally(() => onSourcesConsumed?.());
  }, [externalSources]);

  const captureTextSelection = () => {
    const loaded = documentRef.current;
    if (!loaded || !loaded.info.permissions.copy) { capturedTextSelection.current = null; return null; }
    const draft = textEditor.current?.captureSelection?.();
    if (inlineTextId && !draft) { capturedTextSelection.current = null; return null; }
    const reading = draft ?? captureReadingSelection(loaded.info.id);
    const targets = loaded.page.objects.filter(object => selectedIds.includes(object.id)).flatMap(object => {
      const target = textActionTarget(object, loaded.info.pageOrder.indexOf(loaded.page.id) + 1);
      return target ? [target] : [];
    });
    capturedTextSelection.current = reading ?? (targets.length ? textActionSelection(loaded.info, loaded.name, targets, 'translate', [loaded.page]) : null);
    return capturedTextSelection.current;
  };
  const discussMaterial = (material: AiMaterial) => {
    if (!hasAi) return;
    setTextWindowOpen(false);
    setAiContextDocumentId(sessions.current.current.documents.has(material.documentId) ? material.documentId : documentRef.current?.info.id ?? null);
    setAiHandoff({ id: crypto.randomUUID(), materials: [material] }); setActiveTool('ai');
  };
  const openTextAction = (selection: TextActionSelection, action: TextAction | 'ask') => {
    if (!host.aiServices) return;
    if (operationBusy) { setNotice('Finish the current editor operation before using AI tools.'); return; }
    if (!selection.targets.length) {
      const page = documentRef.current?.page;
      setTextHelp(page?.objects.some(object => object.textBlock?.runs.some(run => run.text.trim())) ? 'selection' : 'scan'); return;
    }
    if (action === 'ask') { discussMaterial(selectionMaterial(selection)); return; }
    const next = { ...selection, action, id: crypto.randomUUID() };
    setTextSelections(previous => ({ ...previous, [selection.documentId]: next }));
    setDocumentTranslationOpen(false); setTextWindowOpen(true);
  };
  const requestTextAction = (action: TextAction | 'ask') => {
    const saved = capturedTextSelection.current;
    const current = documentRef.current;
    const selection = saved && current && saved.documentId === current.info.id && saved.revision === current.info.revision ? saved : captureTextSelection();
    if (selection) openTextAction(selection, action);
    else if (current) setTextHelp(current.page.objects.some(object => object.textBlock?.runs.some(run => run.text.trim())) ? 'selection' : 'scan');
  };
  const openComment = async (selection: CommentSelection) => {
    if (operationBusy || !await finishDrafts()) return;
    setAnnotationDrawing(null); setTextWindowOpen(false);
    if (documentRef.current?.info.id !== selection.documentId) return;
    if (documentRef.current.page.id !== selection.pageId) await switchPage(selection.pageId);
    setCommentSelection(selection);
  };
  const commentCreated = (documentId: string, pageId: string, id: string) => {
    if (documentRef.current?.info.id !== documentId) return;
    setAnnotationDrawing(null); setTextWindowOpen(false);
    setCommentSelection({ documentId, pageId, id });
  };
  const prepareTranslation = async (): Promise<KolmoDocumentInput | null> => {
    if (operationBusy || !await finishDrafts()) return null;
    const loaded = documentRef.current;
    if (!loaded || !loaded.info.permissions.copy) return null;
    setActivity('saving');
    try {
      const snapshot = await engine.save({ docId: loaded.info.id, protection: 'remove' });
      if (documentRef.current?.info.id !== loaded.info.id || documentRef.current.info.revision !== loaded.info.revision) throw new Error('The document changed. Confirm the current version before uploading.');
      return { name: loaded.name, pageCount: loaded.info.pageOrder.length, documentId: loaded.info.id, revision: loaded.info.revision, snapshot,
        ...(workspaceId ? { workspaceId } : {}) };
    } finally { setActivity('idle'); }
  };
  const openTranslation = async (file: KolmoFile, jobId: string) => {
    const origin = { sourceId: crypto.randomUUID(), name: file.name, identity: file.identity ?? `kolmopdf:${jobId}:${file.name}`,
      ...(file.location ? { location: file.location } : {}) };
    const opened = await openDocument(file.kind === 'bytes'
      ? { ...origin, kind: 'bytes', bytes: file.bytes.slice(0) }
      : { ...origin, kind: 'native-file', handle: file.handle });
    if (!opened) throw new Error('Save the translated file or close a document before opening it.');
  };
  const locateMaterial = async (material: AiMaterial) => {
    const source = sessions.current.current.documents.get(material.documentId);
    if (!source) throw new Error('Open the source PDF to view this reference.');
    if (source.loaded.info.revision !== material.revision) throw new Error('The source document changed. This reference belongs to an earlier version.');
    if (operationBusy || !await finishDrafts()) return;
    const owner = aiContextDocumentId ?? documentRef.current?.info.id ?? material.documentId;
    const location = material.locations[0];
    const pageId = location?.pageId ?? source.loaded.info.pageOrder[0];
    if (!pageId) return;
    setActivity('rendering');
    try {
      const loaded = await loadPage(engine, source.loaded.info, source.loaded.name, pageId, source.zoom);
      captureView(); sessions.patch(material.documentId, { loaded }); sessions.activate(material.documentId); onActivateDocument?.(material.documentId);
      setAiContextDocumentId(owner); setActiveTool('ai'); setTab('home'); setPointer('select'); setInlineTextId(null);
      const target = loaded.page.objects.find(object => object.textBlock?.id === location?.blockId);
      setSelectedIds([]);
      setSearchSelection(location?.blockId && location.range ? { docId: material.documentId, revision: material.revision, pageId,
        blockId: location.blockId, start: location.range[0], end: location.range[1], key: ++searchLocationSequence.current } : null);
      requestAnimationFrame(() => scrollToPage(pageId, target?.bounds.y ?? 0));
    } finally { setActivity('idle'); }
  };
  const chooseTool = (tool: EditorTool) => {
    if (previewActive && tool !== 'ai') return;
    if (tool === 'edit') { chooseTab('edit'); return; }
    if (tool === 'text-ai') { captureTextSelection(); requestTextAction('translate'); return; }
    if (tool === 'ai') { if (hasAi) { setAiContextDocumentId(documentRef.current?.info.id ?? null); setActiveTool('ai'); } return; }
    if (tool === 'translate-document') { setTextWindowOpen(false); setDocumentTranslationOpen(true); return; }
    if (isDraftDirty) { void finishDrafts().then(ok => { if (ok) setActiveTool(tool); }); return; }
    setActiveTool(tool);
  };
  const chooseTab = (next: RibbonTab) => {
    if (previewActive) return;
    if (isDraftDirty) { void finishDrafts().then(ok => { if (ok) chooseTabAfterSave(next); }); return; }
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
    if (previewActive || navigationBusy || loaded.info.id !== documentRef.current?.info.id || loaded.info.revision !== documentRef.current.info.revision) return;
    const updated = { ...loaded, info: documentRef.current.info };
    documentRef.current = updated; setDocument(updated);
    setSelectedIds([]); setInlineTextId(null); setSearchSelection(null); setCropImage(false); setCropPage(false);
  };
  const fittedSize = document && viewSize?.docId === document.info.id && viewSize.pageId === document.page.id && viewSize.view === view
    ? viewSize : document && view === 'single' ? { widthPt: document.page.widthPt, heightPt: document.page.heightPt, columns: 1 as const } : null;
  const viewZoom = useViewZoom({ root: stageRef, documentKey: document?.info.id, pageKey: document?.page.id,
    size: fittedSize, zoom, busy: navigationBusy, enabled: tab !== 'pages' && !panelResizing && !previewActive, onZoom: changeZoom });
  const fitPage = viewZoom.fitPage;
  const startAnnotation = (next: AnnotationDrawingOptions | null) => {
    if (isBusy) return;
    setAnnotationDrawing(next); setPendingSignature(null); setPlacement(null); setCropImage(false); setCropPage(false);
    setInlineTextId(null); setSelectedIds([]); setCommentSelection(null);
    if (next) { setPointer('select'); setActiveTool('comment'); window.getSelection()?.removeAllRanges(); }
  };
  const startSignature = (draft: SignatureDraft | null) => {
    if (isBusy) return;
    setPendingSignature(draft); setAnnotationDrawing(null); setPlacement(null); setCropImage(false); setCropPage(false);
    setInlineTextId(null); setSelectedIds([]);
    if (draft) { setPointer('select'); window.getSelection()?.removeAllRanges(); }
  };
  const executeCommands = async (commands: import('@pdf-editor/contracts').EditCommand[], resourceIds = new Set<string>()): Promise<boolean> => {
    const current = documentRef.current;
    if (!current || operationBusy || isDraftDirty) return false;
    setActivity('editing'); setError(null);
    try {
      const transaction = { id: crypto.randomUUID(), docId: current.info.id, baseRevision: current.info.revision, source: 'manual' as const, commands };
      const result = await new CommandRegistry(engine).execute(transaction, { document: current.info, pages: new Map([[current.page.id, current.page]]),
        fontIds: new Set(fonts.map(font => font.id)), resourceIds,
        ...(host.capabilities.platform === 'web' ? { pageLimit: WEB_LIMITS.pagesPerDocument } : {}) });
      await handleCommitted(result); return true;
    } catch (caught) { setError(formatError(caught)); return false; }
    finally { setActivity('idle'); }
  };
  const pageTools = usePageTools({ document, engine, host, disabled: isBusy || previewActive, execute: executeCommands,
    onBusy: setEditPending, onError: setError, onNotice: setNotice });
  const openOverviewPage = (id: string) => { chooseTab('home'); void switchPage(id); };
  const changeOverviewZoom = (scale: number) => {
    setOverviewColumns(0); setOverviewWidth(Math.max(100, Math.min(900, scale * 230)));
  };
  const wheelState = useRef({ tab, isBusy: navigationBusy || previewActive, zoom, overviewWidth, overviewColumns, changeZoom: viewZoom.manualZoom, exitFitMode: viewZoom.exitFitMode });
  wheelState.current = { tab, isBusy: navigationBusy || previewActive, zoom, overviewWidth, overviewColumns, changeZoom: viewZoom.manualZoom, exitFitMode: viewZoom.exitFitMode };
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
        current.exitFitMode();
        requested = Math.max(0.25, Math.min(4, (requested ?? current.zoom) * factor));
        clearTimeout(timer);
        timer = setTimeout(() => { const scale = requested; requested = null; if (scale !== null) void wheelState.current.changeZoom(scale); }, 100);
      }
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => { stage.removeEventListener('wheel', wheel); clearTimeout(timer); };
  }, []);
  const runRibbonAction = async (action: RibbonAction): Promise<void> => {
    if (previewActive) return;
    const current = documentRef.current;
    if (!current) return;
    if (action === 'fit' || action === 'fitWidth') {
      if (navigationBusy) return;
      if (tab === 'pages') setOverviewColumns(3);
      else if (action === 'fitWidth') viewZoom.fitWidth(); else fitPage();
      return;
    }
    if (isBusy) return;
    const pageId = current.page.id;
    if (action === 'note' || action === 'rectangle' || action === 'ink') {
      if (!current.info.permissions.annotate || !current.info.capabilities.includes('annotation.add')) return;
      startAnnotation({ tool: action === 'note' ? 'text' : action, color: action === 'note' ? '#fff176' : '#226044', opacity: 1, strokeWidth: 2, text: '' });
      return;
    }
    setAnnotationDrawing(null); setPendingSignature(null);
    if (tab === 'pages' && ['blankPage', 'importPages', 'duplicatePage', 'deletePage', 'rotatePageLeft', 'rotatePageRight', 'copyPages', 'pastePages', 'extractPages'].includes(action)) {
      await pageTools.run(action as PageAction); return;
    }
    if (action === 'cropPage') { setTab('edit'); setCropPage(true); setCropImage(false); setPlacement(null); setSelectedIds([]); return; }
    if (action === 'pageNumbers' || action === 'watermark' || action === 'headerFooter') {
      setPagePanelSection(action === 'pageNumbers' ? 'number' : action === 'headerFooter' ? 'header' : 'watermark');
      chooseTool('pages'); return;
    }
    if (action === 'flipHorizontal' || action === 'flipVertical') {
      const object = selectedObjects[0];
      if (object) await transformObjects(selectedIds, action === 'flipHorizontal' ? [-1, 0, 0, 1, object.bounds.x * 2 + object.bounds.width, 0] : [1, 0, 0, -1, 0, object.bounds.y * 2 + object.bounds.height]);
      return;
    }
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
    if (action === 'importPages') { await pageTools.openImport(pageId); return; }
    if (['insertImage', 'replaceImage'].includes(action)) {
      setEditPending(true); setError(null);
      try {
        const source = await host.pickResource?.('image');
        if (!source) return;
        const resource = await engine.registerResource({ docId: current.info.id, resourceId: crypto.randomUUID(), source });
        if (action === 'insertImage') {
          setTab('edit'); setPointer('edit'); setSelectedIds([]);
          setPlacement({ kind: 'image', resourceId: resource.id, width: resource.width ?? 200, height: resource.height ?? 150 });
        } else if (action === 'replaceImage') {
          await executeCommands([{ type: 'image.replace', pageId, objectId: selectedIds[0]!, resourceId: resource.id }], new Set([resource.id]));
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
  const editTextAt = (loaded: LoadedDocument, id: string, range: [number, number] | null = null, rangeIsLogical = false, hit?: TextHit) => {
    if (isBusy || loaded.info.revision !== documentRef.current?.info.revision) return;
    setInlineHit(hit ?? null);
    const flow = loaded.page.objects.find(object => object.id === id)?.textBlock?.flow;
    const activate = (target: LoadedDocument, objectId: string, selection: [number, number] | null) => {
      activateVisiblePage(target); setTab('edit'); setPointer('edit'); setSelectedIds(objectSelectionIds(target.page, objectId)); setInlineRange(selection); setInlineRangeIsLogical(rangeIsLogical); setInlineTextId(objectId);
    };
    if (!flow || flow.start === 0) { activate(loaded, id, range); return; }
    setActivity('rendering'); setError(null);
    void (async () => {
      try {
        const position = loaded.info.pageOrder.indexOf(loaded.page.id);
        const candidates = [...loaded.info.pageOrder.slice(0, position).reverse(), ...loaded.info.pageOrder.slice(position + 1)];
        for (const pageId of candidates) {
          const page = await engine.describePage(loaded.info.id, pageId);
          const first = page.objects.find(object => object.textBlock?.flow?.id === flow.id && object.textBlock.flow.start === 0);
          if (!first) continue;
          const target = await loadPage(engine, loaded.info, loaded.name, pageId, zoom);
          if (documentRef.current?.info.id !== loaded.info.id || documentRef.current.info.revision !== loaded.info.revision) return;
          setInlineHit(null);
          activate(target, first.id, range ? [range[0] + flow.start, range[1] + flow.start] : null);
          requestAnimationFrame(() => scrollToPage(pageId, first.bounds.y));
          return;
        }
        throw new Error('The first frame of this linked paragraph is no longer available');
      } catch (caught) { setError(formatError(caught)); }
      finally { setActivity('idle'); }
    })();
  };
  const annotateSelection = async (loaded: LoadedDocument, targets: TextSelectionTarget[], action: 'highlight' | 'underline') => {
    if (isBusy || loaded.info.revision !== documentRef.current?.info.revision) return;
    activateVisiblePage(loaded);
    const selected = targets.filter(target => target.range[0] !== target.range[1]);
    let commands: import('@pdf-editor/contracts').EditCommand[];
    if (action === 'underline') commands = selected.map(target => ({ type: 'text.style', pageId: loaded.page.id,
      blockIds: [target.blockId], range: target.range, style: { underline: true } }));
    else {
      const regionIds = new Map(readingRegions(loaded.page).flatMap((region, index) => region.objects.map(object => [object.id, index] as const)));
      const groups = new Map<number | string, import('@pdf-editor/contracts').Rect[]>();
      for (const target of selected) {
        const key = regionIds.get(target.objectId) ?? target.objectId;
        const rects = groups.get(key);
        if (rects) rects.push(...target.rects); else groups.set(key, [...target.rects]);
      }
      commands = [...groups.values()].flatMap(rects => mergeTextRects(rects, loaded.page.rotation % 180 !== 0))
        .map<import('@pdf-editor/contracts').EditCommand>(bounds => ({ type: 'annotation.add', pageId: loaded.page.id,
          annotationId: crypto.randomUUID(), subtype: 'highlight', bounds, color: [1, 0.85, 0.1], opacity: 0.4 }));
    }
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
      const font = fonts.find(item => item.id === copiedTextFormat?.fontId) ?? fonts[0];
      if (!font) { setError(t('No font is available. Import a font first.')); chooseTool('fonts'); return; }
      command = { type: 'text.insert', pageId: current.page.id, objectId: id, paragraph: true,
        bounds: { x, y, width: Math.min(240, current.page.widthPt - x), height: Math.min(48, current.page.heightPt - y) },
        text: t('New text'), style: { fontSize: 14, color: [0, 0, 0], lineHeight: 1.2, ...copiedTextFormat, fontId: font.id } };
    } else {
      const scale = Math.min(1, 240 / placement.width, (current.page.widthPt - x) / placement.width, (current.page.heightPt - y) / placement.height);
      command = { type: 'image.insert', pageId: current.page.id, objectId: id, resourceId: placement.resourceId,
        bounds: { x, y, width: placement.width * scale, height: placement.height * scale } };
      resources = new Set([placement.resourceId]);
    }
    if (await executeCommands([command], resources)) {
      setPlacement(null);
      const active = documentRef.current;
      let inserted = active?.page.objects.find(item => item.id === id || item.textBlock?.sourceObjectIds.includes(id));
      if (!inserted && active && command.type === 'text.insert') {
        setActivity('rendering');
        try {
          for (const pageId of active.info.pageOrder) {
            if (pageId === active.page.id) continue;
            const page = await engine.describePage(active.info.id, pageId);
            inserted = page.objects.find(item => item.id === id);
            if (!inserted) continue;
            const target = await loadPage(engine, active.info, active.name, pageId, zoom);
            activateVisiblePage(target);
            requestAnimationFrame(() => scrollToPage(pageId, inserted?.bounds.y));
            break;
          }
        } catch (caught) { setError(formatError(caught)); }
        finally { setActivity('idle'); }
      }
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
      if (event.defaultPrevented || modalOpen || globalThis.document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const modifier = (event.ctrlKey || event.metaKey) && !event.altKey, key = event.key.toLowerCase();
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      const inFiles = event.target instanceof Element && Boolean(event.target.closest('.workspace-rail-content'));
      const inMenu = event.target instanceof Element && Boolean(event.target.closest('[role="menu"]'));
      if (modifier && key === 'o') {
        event.preventDefault();
        if (!operationBusy) { if (event.shiftKey && onOpenFolder) onOpenFolder(); else void openDocuments(); }
        return;
      }
      if (host.capabilities.nativeFiles && modifier && key === 'w') { event.preventDefault(); if (!operationBusy) { if (previewActive) onClosePreview?.(); else void closeDocument(); } return; }
      if (host.capabilities.nativeFiles && event.ctrlKey && key === 'tab') {
        event.preventDefault(); const ids = [...sessions.current.current.documents.keys()], index = ids.indexOf(documentRef.current?.info.id ?? '');
        const next = ids[(index + (event.shiftKey ? -1 : 1) + ids.length) % ids.length]; if (next) void switchDocument(next); return;
      }
      if (previewActive) return;
      if (modifier && ['s', 'f', 'p'].includes(key)) {
        event.preventDefault();
        if (key === 's' && !operationBusy) void saveDocument(event.shiftKey);
        if (key === 'f' && document) chooseTool('search');
        if (key === 'p' && document) chooseTool('print');
        return;
      }
      if (modifier && ['z', 'y'].includes(key) && !typing) {
        event.preventDefault(); if (!isBusy) void moveHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo'); return;
      }
      if (inFiles || (event.target instanceof Element && event.target.closest('[role="separator"], .ai-floating-window'))) return;
      if (!typing && event.key === 'Escape') { setPlacement(null); setCropImage(false); setCropPage(false); setSelectedIds([]); }
      const pageScope = tab === 'pages' || (event.target instanceof Element && Boolean(event.target.closest('.page-list')));
      if (!typing && pageScope && !inMenu && !isBusy) {
        if (modifier && key === 'a') { event.preventDefault(); pageTools.selectAll(); return; }
        if (modifier && (key === 'c' || key === 'v')) { event.preventDefault(); void pageTools.run(key === 'c' ? 'copyPages' : 'pastePages'); return; }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void pageTools.run('deletePage'); return; }
      }
      if (!typing && !inMenu && !isBusy && pointer === 'edit' && ['Enter', 'F2'].includes(event.key) && selectedText) {
        event.preventDefault(); if (document) editTextAt(document, selectedIds[0]!); return;
      }
      if (!typing && !inMenu && pointer === 'edit' && (event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length) { event.preventDefault(); void runRibbonAction('delete'); return; }
      if (!typing && !inMenu && tab !== 'pages' && (presenting || !continuous) && ['ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', ' '].includes(event.key)) {
        event.preventDefault(); const step = ['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1;
        const id = document && adjacentPageId(document.info.pageOrder, currentPageIndex, step, view); if (id) void switchPage(id);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
  const aiSession = (aiContextDocumentId ? sessions.state.documents.get(aiContextDocumentId) : undefined) ?? sessions.active;
  const aiDocument = aiSession?.loaded ?? document;
  const tabs = [...sessions.state.documents.values()].map(session => ({ id: session.loaded.info.id, name: session.loaded.name,
    ...(session.saveLocation ?? session.location ? { location: session.saveLocation ?? session.location } : {}),
    dirty: session.loaded.info.revision !== session.loaded.info.savedRevision || (session.loaded.info.id === document?.info.id && isDraftDirty) }));
  const showStart = () => { if (!operationBusy) { onRequestRecent?.(); setStartOpen(true); } };
  const startPage = <StartPage busy={operationBusy} isWeb={host.capabilities.platform === 'web'} onOpen={() => void openDocuments()}
    {...(onOpenFolder ? { onOpenFolder: () => { setStartOpen(false); onOpenFolder(); } } : {})}
    recent={recentFiles ?? webRecent} onOpenRecent={entry => { if (onOpenRecent) { setStartOpen(false); onOpenRecent(entry); } else void openDocuments(); }}
    onForgetRecent={id => { if (onForgetRecent) onForgetRecent(id); else setWebRecent(previous => { const next = previous.filter(entry => entry.id !== id); writeWebRecent(next); return next; }); }}>
    {pendingRecovery.length > 0 && <section className="recovery-list" aria-label={t('Recoverable session notice')}>
      <h2>{t('Recover Unsaved Document')}</h2>
      {pendingRecovery.map(item => <div className="recovery-row" key={item.docId}><span><strong>{item.name}</strong><small>{t('Unsaved changes')}</small></span>
        <button className="button button-quiet" type="button" onClick={() => void discardPendingRecovery(item.docId)} disabled={operationBusy}>{t('Discard')}</button>
        <button className="button button-primary" type="button" onClick={() => void restorePendingRecovery(item)} disabled={operationBusy}>{t('Restore')}</button>
      </div>)}
    </section>}
  </StartPage>;

  return (
    <Tooltip.Provider delay={350}>
    <main className={'editor-shell ' + (tabs.length || workspacePreview ? 'editor-shell-with-tabs ' : '') + (presenting ? 'is-presenting ' : '') + (previewActive ? 'is-workspace-preview ' : '') + (!document && !previewActive ? 'is-start-page' : '')}>
      {savePrompt && <SaveChangesDialog prompt={savePrompt} />}
      {passwordPrompt && <PasswordDialog prompt={passwordPrompt} />}
      <ImportPagesDialog {...pageTools.importDialogProps} />
      <AppDialog open={startOpen} onOpenChange={setStartOpen} title={t('Open documents')}>{startPage}</AppDialog>
      <AppDialog open={textHelp !== null} onOpenChange={open => { if (!open) setTextHelp(null); }} title={t(textHelp === 'scan' ? 'Translate scanned PDF' : 'Select text')} className="ai-owned-focus">
        <p>{t(textHelp === 'scan' ? 'This page has no selectable text. Use KOLMOPDF to translate the scanned PDF while preserving its layout.' : 'Select text on the page, then choose an AI tool from the right-click menu or toolbar.')}</p>
        {textHelp === 'scan' && <div className="kolmo-links"><button type="button" className="button button-primary" onClick={() => { setTextHelp(null); chooseTool('translate-document'); }}>{t('Translate entire PDF…')}</button>
          <a className="button" href="https://www.kolmopdf.com" target="_blank" rel="noopener noreferrer">{t('Use KOLMOPDF website')}</a></div>}
      </AppDialog>
      {host.aiServices && <AiFloatingWindow title={t('Translate entire PDF')} hidden={!documentTranslationOpen} onClose={() => setDocumentTranslationOpen(false)}>
        <KolmoTranslationPanel active={documentTranslationOpen} document={document?.info ?? null} name={document?.name ?? null}
          services={host.aiServices} host={host} disabled={operationBusy} prepareDocument={prepareTranslation} onOpen={openTranslation} onResultsReady={onResultsReady} />
      </AiFloatingWindow>}
      {commentSelection && document?.info.id === commentSelection.documentId && !previewActive && <AnnotationPopup
        key={commentSelection.documentId + ':' + commentSelection.pageId + ':' + commentSelection.id}
        selection={commentSelection} document={document.info} engine={engine} disabled={operationBusy} draftRef={commentDraft}
        onDirty={setCommentDirty} onBusyChange={setEditPending} onCommitted={handleCommitted} onClose={() => setCommentSelection(null)} />}
      {host.aiServices && Object.values(textSelections).map(selection => {
        const session = sessions.state.documents.get(selection.documentId);
        return session && <TextActionPanel key={selection.id} preferenceOwner={preferenceOwner} selection={selection} document={session.loaded.info} engine={engine} services={host.aiServices!} fonts={fonts}
          active={textWindowOpen && document?.info.id === selection.documentId && !previewActive} onClose={() => setTextWindowOpen(false)}
          disabled={operationBusy} onBusyChange={setEditPending} onCommitted={handleCommitted} onBeforeWrite={finishDrafts} onDiscuss={discussMaterial}
          onCommentCreated={(pageId, id) => commentCreated(selection.documentId, pageId, id)}
          getDocument={() => sessions.current.current.documents.get(selection.documentId)?.loaded.info ?? session.loaded.info}
          onAdjustSource={target => {
            void (async () => { if (!await finishDrafts()) return; await switchPage(target.pageId); setTab('edit'); setPointer('edit'); setSelectedIds([target.objectId]); setTextWindowOpen(false); })();
          }} />;
      })}
      <EditorTopbar platform={host.capabilities.platform} hasSaveTarget={sessions.active?.hasSaveTarget ?? false}
        downloaded={sessions.active?.downloadedRevision === document?.info.revision && document !== null && !isDraftDirty}
        onStart={showStart} {...(onOpenFolder ? { onOpenFolder } : {})} productName={productName} name={workspacePreview?.name ?? document?.name} dirty={!previewActive && Boolean(document && (isDraftDirty || document.info.revision !== document.info.savedRevision))}
        showAi={hasAi} busy={operationBusy} documentActionsDisabled={previewActive} canUndo={!previewActive && history.canUndo} canRedo={!previewActive && history.canRedo} saving={activity === 'saving'} tool={activeTool}
        onTool={chooseTool} onOpen={() => void openDocuments()} onClose={() => { if (previewActive) onClosePreview?.(); else void closeDocument(); }}
        onSave={() => { if (!previewActive) void saveDocument(); }} {...(host.capabilities.nativeFiles && !previewActive ? { onSaveAs: () => void saveDocument(true) } : {})}
        onUndo={() => { if (!previewActive) void moveHistory('undo'); }} onRedo={() => { if (!previewActive) void moveHistory('redo'); }} extra={headerActions} />

      {(tabs.length > 0 || workspacePreview) && <DocumentTabs tabs={tabs} activeId={document?.info.id ?? null} disabled={operationBusy}
        {...(workspacePreview ? { previewName: workspacePreview.name } : {})}
        onActivate={id => void switchDocument(id)} onClose={id => void closeDocument(id)} onOpen={() => void openDocuments()} />}

      <EditorRibbon tab={tab} onTab={chooseTab} pointer={pointer} onCaptureSelection={() => { captureTextSelection(); }}
        onTextAction={host.aiServices ? requestTextAction : undefined} onPointer={next => {
        if (isDraftDirty) { void finishDrafts().then(ok => { if (ok) setPointer(next); }); return; }
        if (next === 'edit') setTab('edit');
        else if (tab === 'pages') chooseTabAfterSave('home');
        setPointer(next); setInlineTextId(null); setSelectedIds([]); setCropImage(false); setCropPage(false); setPlacement(null); setAnnotationDrawing(null); setPendingSignature(null);
      }} annotationTool={annotationDrawing?.tool ?? null} canAnnotate={Boolean(document?.info.permissions.annotate && document.info.capabilities.includes('annotation.add'))}
        zoomMode={viewZoom.mode} pageTools={pageTools} overviewColumns={overviewColumns} onOverviewColumns={setOverviewColumns} onTool={chooseTool} onAction={action => void runRibbonAction(action)} view={view} continuous={continuous}
        onView={next => { if (!isBusy) { setView(next); requestAnimationFrame(() => scrollToPage(document?.page.id ?? '')); } }}
        onContinuous={() => { if (!isBusy) { setContinuous(value => !value); requestAnimationFrame(() => scrollToPage(document?.page.id ?? '')); } }}
        hasDocument={Boolean(document)} busy={operationBusy} ocr={host.capabilities.ocr} railOpen={railOpen} onToggleRail={() => setRailOpen(value => !value)}
        selection={selectedText ? 'text' : selectedObjects.length === 1 && selectedObjects[0]?.type === 'image' ? 'image' : selectedObjects.length ? 'objects' : null}>
        {document && <DirectTextEditor document={document.info} name={document.name} page={document.page} selectedIds={selectedIds} inlineId={inlineTextId}
          onTextAction={host.aiServices ? openTextAction : undefined} host={pageHost} render={document.render} engine={engine} disabled={operationBusy} handle={textEditor} initialRange={inlineRange} initialRangeIsLogical={inlineRangeIsLogical} initialHit={inlineHit}
          onClose={() => { setInlineTextId(null); setInlineRange(null); setInlineHit(null); }} onEdit={() => { if (selectedIds[0]) editTextAt(document, selectedIds[0]); }} onManageFonts={() => chooseTool('fonts')}
          onParagraph={id => { setSelectedIds([id]); setInlineRange(null); setInlineHit(null); setInlineTextId(id); }}
          copiedFormat={copiedTextFormat} onCopyFormat={setCopiedTextFormat}
          onDraftChange={setTextDraftDirty} onBusyChange={setEditPending} onCommitted={handleCommitted} />}
      </EditorRibbon>

      <div id="document-workspace" ref={workspaceRef} className="editor-workspace" data-rail={railVisible} data-rail-tab={railTab} data-panel={panelVisible} data-ai-panel={aiPanelActive} data-empty={!document}>
        <nav className="navigation-tools" aria-label={t('Document navigation')}>
          {hasWorkspace && <IconButton label="Files" aria-pressed={railOpen && railTab === 'files'} onClick={() => { setRailTab('files'); setRailOpen(!railOpen || railTab !== 'files'); }}><Folder size={18} /></IconButton>}
          <IconButton label="Pages" disabled={!document} aria-pressed={railOpen && railTab === 'pages'} onClick={() => { setRailTab('pages'); setRailOpen(!railOpen || railTab !== 'pages'); }}><LayoutGrid size={18} /></IconButton>
          <IconButton label="Bookmarks" disabled={!document} aria-pressed={railOpen && railTab === 'bookmarks'} onClick={() => { setRailTab('bookmarks'); setRailOpen(!railOpen || railTab !== 'bookmarks'); }}><Bookmark size={18} /></IconButton>
        </nav>
        <aside className="page-rail" aria-label={t(railTab === 'files' ? 'Files' : 'Pages')} hidden={!railVisible}>
          {hasWorkspace && <div className="workspace-rail-content" hidden={railTab !== 'files'}>{workspacePanel}</div>}
          <div className="rail-heading" hidden={railTab === 'files'}>
            <span>{t(railTab === 'pages' ? "Pages" : "Bookmarks")}</span>
            <small>{document?.info.pageOrder.length ?? 0}</small>
          </div>
          <div className="page-list" hidden={railTab !== 'pages'}>
            {document ? document.info.pageOrder.map((pageId, index) => (
              <PageContextMenu key={pageId} tools={pageTools} onOpen={() => openOverviewPage(pageId)}>
                <ContextMenu.Trigger render={<button type="button" disabled={navigationBusy || previewActive} />} className={`page-chip ${pageId === document.page.id ? 'page-chip-active' : ''} ${pageTools.ids.includes(pageId) ? 'page-chip-selected' : ''}`}
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
              <button type="button" key={`${index}-${entry.title}`} disabled={!entry.pageId || navigationBusy || previewActive}
                style={{ paddingLeft: `${6 + Math.min(entry.level, 5) * 8}px` }}
                aria-label={`Go to bookmark ${entry.title || t("Untitled")}`}
                title={entry.title || t("Untitled")}
                onClick={() => { if (entry.pageId) void switchPage(entry.pageId); }}>
                {entry.title || t("Untitled")}
              </button>)}
            {!outline.length && !outlineError && <span>{t("No bookmarks in this document.")}</span>}
          </nav>
        </aside>

        <section ref={stageRef} hidden={previewActive} className={`canvas-stage ${dragOver ? 'is-dragging' : ''} ${pointer === 'hand' ? 'hand-tool' : ''}`}
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
            const files = Array.from(event.dataTransfer.files);
            if (!files.length) return;
            if (files.some(file => !file.name.toLowerCase().endsWith('.pdf'))) { setError(t('Choose PDF files only.')); return; }
            if (files.some(file => file.size > WEB_LIMITS.inputBytes)) { setError(t('This file is too large for the web editor. Use the desktop app.')); return; }
            if (files.length + sessions.current.current.documents.size > WEB_LIMITS.openDocuments) {
              setError(t('The web editor can keep only {count} PDFs open. Close one before opening another.', { count: WEB_LIMITS.openDocuments })); return;
            }
            void Promise.all(files.map(async file => ({ kind: 'bytes' as const, sourceId: crypto.randomUUID(), name: file.name, bytes: await file.arrayBuffer() })))
              .then(sources => openDocuments(sources)).catch(() => setError(t('Unable to open this file.')));
          }}>
          {!document ? (
            startPage
          ) : tab === 'pages' ? (
            <PageOrganizer document={document} engine={engine} tools={pageTools} disabled={isBusy} width={overviewWidth} columns={overviewColumns} onOpen={openOverviewPage} />
          ) : (
            <DocumentViewport key={document.info.id} engine={engine} document={document} zoom={zoom} view={view} continuous={continuous}
              root={stageRef} locked={previewActive || navigationBusy || cropImage || cropPage || Boolean(pendingSignature)} pointer={pointer} onActive={activateVisiblePage} onHost={setPageHost}
              onViewSize={setViewSize} drawing={Boolean(annotationDrawing || pendingSignature)}
              renderOverlay={shown => <>
                {!annotationDrawing && !pendingSignature && !placement && !cropImage && !cropPage && !inlineTextId && <AnnotationLayer
                  document={shown.info} page={shown.page} render={shown.render} engine={engine} disabled={operationBusy}
                  selected={commentSelection} onOpen={selection => void openComment(selection)} />}
                {annotationDrawing && <AnnotationDrawingLayer document={shown.info} page={shown.page} engine={engine}
                  options={annotationDrawing} disabled={operationBusy || isTextDraftDirty || commentDirty || (noteDraftPage !== null && noteDraftPage !== shown.page.id)} onBusyChange={setEditPending}
                  onDraftChange={registerNoteDraft} onCreated={(pageId, id) => commentCreated(shown.info.id, pageId, id)}
                  onCommitted={handleCommitted} onCancel={() => setAnnotationDrawing(null)} />}
              </>}
              onEditText={editTextAt} onInsertText={insertTextAt} onAnnotate={annotateSelection} onError={setError}
              onTextAction={host.aiServices ? openTextAction : undefined} aiSelection={textWindowOpen ? activeTextSelection : null}>
              {(shown) => <>
                {searchSelection?.pageId === shown.page.id && (() => {
                  const match = shown.page.objects.find(item => item.textBlock?.id === searchSelection.blockId);
                  return match && <div className="search-match-highlight" style={{ position: 'absolute', pointerEvents: 'none', zIndex: 2, background: '#ffda5044', outline: '2px solid #dca91b',
                    left: match.bounds.x * zoom, top: match.bounds.y * zoom, width: match.bounds.width * zoom, height: match.bounds.height * zoom }} />;
                })()}
                {pendingSignature && <SignaturePlacementLayer key={`${shown.info.id}:${shown.page.id}:${shown.info.revision}`} document={shown.info} page={shown.page}
                  draft={pendingSignature} engine={engine} disabled={isBusy} onBusyChange={setEditPending}
                  onCommitted={handleCommitted} onCancel={() => setPendingSignature(null)} />}
                {pointer === 'edit' && !annotationDrawing && !pendingSignature && !placement && !cropImage && !cropPage && <ContextMenu.Root>
                  <ContextMenu.Trigger className="page-object-tools" onContextMenuCapture={event => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    objectContextPoint.current = { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
                    const point = objectContextPoint.current;
                    const id = pickObject(selectionScope(shown.page, selectedIds), point.x, point.y, 3 / zoom)?.id;
                    const ids = id && !selectedIds.includes(id) ? [id] : selectedIds;
                    const targets = shown.page.objects.filter(object => ids.includes(object.id)).flatMap(object => {
                      const target = textActionTarget(object, shown.info.pageOrder.indexOf(shown.page.id) + 1); return target ? [target] : [];
                    });
                    capturedTextSelection.current = targets.length ? { ...textActionSelection(shown.info, shown.name, targets, 'translate', [shown.page]),
                      anchor: { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY } } : null;
                    if (id && !selectedIds.includes(id)) selectObject(id, false);
                    if (!id && !(event.target as HTMLElement).closest('.selection-bounds')) setSelectedIds([]);
                  }}>
                    <SelectionLayer page={shown.page} render={shown.render} selectedIds={selectedIds} onSelect={selectObject}
                      onBoxSelect={ids => {
                        const select = () => { setSelectedIds(ids); setSearchSelection(null); setInlineTextId(null); };
                        if (isDraftDirty) { void finishDrafts().then(ok => { if (ok) select(); }); } else select();
                      }}
                      onEditText={(id, hit) => editTextAt(shown, id, hit ? [hit.offset, hit.offset] : null, false, hit)}
                      disabled={operationBusy} canTransform={shown.info.permissions.modify && shown.info.capabilities.includes('objects.transform')}
                      onMove={moveObjects} onTransform={transformObjects}
                      onResizeText={shown.info.capabilities.includes('text.resize') ? resizeTextFrames : undefined} />
                  </ContextMenu.Trigger>
                  <ContextMenu.Portal><ContextMenu.Positioner className="ui-menu-positioner"><ContextMenu.Popup className="ui-menu ai-owned-focus">
                    {selectedText && <>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => editTextAt(shown, selectedIds[0]!)}>{t('Edit text')}<kbd>Enter</kbd></ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={!shown.info.permissions.copy} onClick={() => void navigator.clipboard.writeText(detectParagraph(shown.page, selectedIds[0]!)?.text ?? selectedText.runs.map(run => run.text).join('')).catch(() => setError(t('Clipboard access was denied. Use Ctrl/Cmd+C to copy selected text.')))}>{t('Copy text')}</ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.annotate} onClick={() => void annotateSelection(shown, selectedObjects.map(object => ({ objectId: object.id, blockId: object.textBlock!.id, range: [0, object.textBlock!.runs.reduce((length, run) => length + run.text.length, 0)], text: '', rects: [object.bounds] })), 'highlight')}>{t('Highlight text')}</ContextMenu.Item>
                      <ContextMenu.Item className="ui-menu-item" disabled={isBusy || !shown.info.permissions.modify} onClick={() => void executeCommands([{ type: 'text.style', pageId: shown.page.id, blockIds: selectedObjects.map(object => object.textBlock!.id), style: { underline: true } }])}>{t('Underline text')}</ContextMenu.Item>
                    </>}
                    {host.aiServices && selectedObjects.some(object => object.textBlock) && <TextActionMenuItems disabled={operationBusy || !shown.info.permissions.copy} onAction={requestTextAction} />}
                    {host.aiServices && !selectedObjects.some(object => object.textBlock) && <ContextMenu.Item className="ui-menu-item" disabled={operationBusy} onClick={() => requestTextAction('translate')}>{t('AI translate')}</ContextMenu.Item>}
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
                {pointer === 'select' && !annotationDrawing && !pendingSignature && <PdfLinkLayer annotations={pageAnnotations} page={shown.page} render={shown.render}
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

        {workspacePreview && <section className="workspace-preview" aria-label={workspacePreview.name}>
          <header className="workspace-preview-heading"><strong>{workspacePreview.name}</strong><span>{t('Read-only preview')}</span>{onClosePreview && <IconButton label={t('Close preview')} disabled={operationBusy} onClick={onClosePreview}><X size={17} /></IconButton>}</header>
          <div className="workspace-preview-content">{workspacePreview.content}</div>
        </section>}

        <aside className={'inspector-panel' + (activeTool === 'ai' ? ' ai-owned-focus' : '')} hidden={!panelVisible} aria-label={t(activeTool ? toolNames[activeTool] : "Tools")}>
          {aiPanelActive && <div ref={separatorRef} className="ai-panel-separator" role="separator" tabIndex={0}
            aria-orientation="vertical" aria-label={t('Resize AI panel')}
            aria-valuemin={AI_PANEL_MIN_WIDTH} aria-valuemax={AI_PANEL_MAX_WIDTH} aria-valuenow={AI_PANEL_DEFAULT_WIDTH}
            title={t('Drag to resize. Use Left/Right arrows; Home or double-click to reset.')} />}
          <div className={'panel-heading' + (aiPanelActive ? ' panel-heading-ai' : '')}><strong>{t(activeTool ? toolNames[activeTool] : "Tools")}</strong>
            <IconButton label={t('Close panel')} disabled={operationBusy} onClick={() => {
              if (activeTool === 'ai') { setActiveTool(null); return; }
              void finishDrafts().then(ok => { if (ok) setActiveTool(null); });
            }}><PanelRightClose size={17} /></IconButton>
          </div>
          <div className="panel-content" data-tool={activeTool}>
          {!document && activeTool !== 'ai' && <div className="panel-empty"><FilePlus2 size={28} /><p>{t('Open a PDF to get started.')}</p></div>}

          <div hidden={activeTool !== 'search'}>
          <PdfSearchPanel document={document?.info ?? null} engine={engine} disabled={isBusy} onLocate={locateTextBlock} onCommitted={handleCommitted} onBusyChange={setEditPending} />
          </div>

          {document && <div hidden={activeTool !== 'arrange' && activeTool !== 'pages'}><ObjectEditPanel mode={activeTool === 'pages' ? 'pages' : 'arrange'} section={pagePanelSection} pageSelection={pageTools.ids} document={document.info} page={document.page} selectedIds={selectedIds}
            engine={engine} host={host} disabled={isBusy} onBusyChange={setEditPending}
            onImportPages={() => void pageTools.openImport(document.page.id)}
            onSelectionChange={ids => { setSelectedIds(ids); setSearchSelection(null); }} onCommitted={handleCommitted} /></div>}

          {document && <div hidden={activeTool !== 'arrange'}><ParagraphPanel document={document.info} page={document.page} selectedIds={selectedIds}
            engine={engine} draftRef={paragraphDraft} disabled={operationBusy || textDraftDirty} onBusyChange={setEditPending} onDraftChange={setParagraphDraftDirty} onCommitted={handleCommitted} /></div>}
          {document && <div hidden={activeTool !== 'comment' && activeTool !== 'forms'}><DocumentToolsPanel mode={activeTool === 'forms' ? 'forms' : 'comment'} document={document.info} page={document.page} selectedIds={selectedIds}
            selectedCommentId={commentSelection?.documentId === document.info.id ? commentSelection.id : null} onCommentCreated={(pageId, id) => commentCreated(document.info.id, pageId, id)} active={activeTool === 'comment' || activeTool === 'forms'} drawing={annotationDrawing} onDrawingChange={startAnnotation} onNavigate={annotation => {
              void openComment({ documentId: document.info.id, pageId: annotation.pageId, id: annotation.id });
            }} engine={engine} draftRef={formDraft} onDraftDirtyChange={setFormDraftDirty} disabled={operationBusy || isTextDraftDirty || noteDraftPage !== null || commentDirty} onBusyChange={setEditPending} onCommitted={handleCommitted} /></div>}
          {document && <div hidden={activeTool !== 'sign'}><SignaturePanel document={document.info} disabled={isBusy}
            draft={reusableSignature} onDraftChange={setReusableSignature} placing={Boolean(pendingSignature)} onPlacementRequest={startSignature} /></div>}

          {host.capabilities.ocr && document && <div hidden={activeTool !== 'ocr'}><OcrPanel document={document.info} page={document.page} selectedIds={selectedIds}
            engine={engine} disabled={isBusy} onBusyChange={setEditPending} onCommitted={handleCommitted} /></div>}

          <div hidden={activeTool !== 'fonts'}><FontPanel engine={engine} host={host} disabled={operationBusy} onBusyChange={setEditPending} /></div>
          {document && <div hidden={activeTool !== 'export'}><ExportPanel disabled={isBusy} encrypted={document.info.permissions.encrypted} signed={document.info.permissions.signed} wordAvailable={Boolean(host.convertDocument)} onExport={exportDocument} {...(host.openSavedFile ? { onOpenFile: (handle, reveal) => host.openSavedFile!(handle, reveal) } : {})} /></div>}
          {document && (host.capabilities.platform === 'web' || host.printDocument) &&
            <div hidden={activeTool !== 'print'}><PrintPanel disabled={isBusy} docId={document.info.id} pageIds={document.info.pageOrder} currentPageId={document.page.id}
              encrypted={document.info.permissions.encrypted} canPrint={document.info.permissions.print === true}
              engine={engine} host={host} onBusyChange={setEditPending} /></div>}

          {hasAi && <div hidden={activeTool !== 'ai'}>
            {renderAiPanel ? renderAiPanel({ documents: [...sessions.state.documents.values()].map(session => {
                const identity = session.saveIdentity ?? session.identity;
                return { id: session.loaded.info.id, name: session.loaded.name, info: session.loaded.info, ...(identity ? { identity } : {}) };
              }),
              document: aiDocument?.info ?? null, page: aiDocument?.page ?? null, name: aiDocument?.name ?? null,
              selectedIds: aiSession?.selectedIds ?? selectedIds, engine, disabled: operationBusy, draftDirty: isDraftDirty, finishDrafts, onCommitted: handleCommitted,
              handoff: aiHandoff, onHandoffConsumed: id => setAiHandoff(previous => previous?.id === id ? null : previous),
              getDocumentInfo: id => sessions.current.current.documents.get(id)?.loaded.info ?? null, locateMaterial,
              openDocument: async source => { const info = await openDocument(source); if (info) setAiContextDocumentId(info.id); return info; }, saveDocument: () => saveDocument(false, aiDocument?.info.id),
              navigationDisabled: navigationBusy || previewActive,
              navigatePage: async pageId => { if (aiDocument) await locateMaterial({ id: 'navigation', kind: 'selection', documentId: aiDocument.info.id, revision: aiDocument.info.revision,
                name: aiDocument.name, text: '', locations: [{ pageId, pageNumber: aiDocument.info.pageOrder.indexOf(pageId) + 1 }] }); },
              locateText: (pageId, blockId, range) => { if (aiDocument) void locateMaterial({ id: 'citation', kind: 'selection', documentId: aiDocument.info.id,
                revision: aiDocument.info.revision, name: aiDocument.name, text: '', locations: [{ pageId, pageNumber: aiDocument.info.pageOrder.indexOf(pageId) + 1,
                  blockId, ...(range ? { range: [range.start, range.end] as [number, number] } : {}) }] }).catch(caught => setError(formatError(caught))); },
              showAiPanel: () => setActiveTool('ai') }) : aiPanel}
          </div>}
          </div>
        </aside>
        <nav className="utility-tools" aria-label={t('Quick tools')}>
          <IconButton label="Find & replace" disabled={!document || previewActive} aria-pressed={activeTool === 'search'} onClick={() => chooseTool('search')}><Search size={18} /></IconButton>
        </nav>
      </div>

      <footer className="editor-statusbar">
        <span className={error ? 'status-dot status-dot-error' : 'status-dot'} aria-hidden="true" />
        <span className="status-message" title={t(error ?? notice)} role={error ? 'alert' : 'status'}>{t(error ?? notice)}</span>
        <span className="status-spacer" />
        {!previewActive && <ViewControls page={tab === 'pages' && document ? Math.max(0, document.info.pageOrder.indexOf(pageTools.focus)) + 1 : currentPageIndex + 1} pages={document?.info.pageOrder.length ?? 0} zoom={tab === 'pages' ? overviewWidth / 230 : zoom} busy={navigationBusy}
          onPage={page => { const id = document?.info.pageOrder[page - 1]; if (id) { if (tab === 'pages') { pageTools.select(id); stageRef.current?.querySelector<HTMLElement>(`[data-organizer-page="${id}"]`)?.scrollIntoView({ block: 'nearest' }); } else void switchPage(id); } }}
          onZoom={scale => { if (tab === 'pages') changeOverviewZoom(scale); else void viewZoom.manualZoom(scale); }}
          zoomMode={tab === 'pages' ? 'manual' : viewZoom.mode} {...(tab === 'pages' ? {} : { onFitWidth: viewZoom.fitWidth })}
          onFit={() => { if (tab === 'pages') setOverviewColumns(3); else fitPage(); }} />}
      </footer>
    </main>
    </Tooltip.Provider>
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
  const pageVersion = engine.getPageVersion?.(info.id, pageId) ?? info.revision;
  const page = await engine.describePage(info.id, pageId);
  const render = await renderPage(engine, info.id, page, scale, info.revision);
  if (pageVersion !== (engine.getPageVersion?.(info.id, pageId) ?? render.revision)) {
    throw new EngineError('STALE_REVISION', 'Page changed while rendering');
  }
  return { info, name, page, render, pageVersion };
}

async function saveCurrentDocument(
  current: LoadedDocument,
  engine: EngineAdapter,
  host: HostAdapter,
  updateSavedRevision: (docId: string, savedRevision: number, name?: string, outcome?: SaveOutcome) => void,
  setError: (message: string | null) => void,
  setNotice: (message: string) => void,
  setActivity: (activity: Activity) => void,
  saveAs = false,
  onDownload?: (docId: string, revision: number) => void,
): Promise<SaveConfirmation | null> {
  setActivity('saving');
  setError(null);
  setNotice('Saving…');
  try {
    const result = await engine.save({ docId: current.info.id, protection: 'preserve' });
    const outcome = await host.saveDocument(result, current.name, { mode: saveAs ? 'save-as' : 'save' });
    if (outcome?.status === 'cancelled') { setNotice('Save cancelled'); return null; }
    if (outcome?.status === 'download-started') {
      onDownload?.(result.docId, result.savedRevision);
      setNotice('Download started');
      return null;
    }
    const confirmed = await engine.confirmSave({ docId: result.docId, savedRevision: result.savedRevision });
    updateSavedRevision(result.docId, confirmed.savedRevision, outcome?.name, outcome || undefined);
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
