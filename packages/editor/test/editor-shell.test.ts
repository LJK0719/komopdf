import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useDocumentSessions } from '../src/ui/use-document-sessions.js';
import { matchesPageRender, pageRenderGeometry } from '../src/ui/draw-render.js';
import type { DocumentInfo, EngineAdapter, PageModel, RenderResult } from '@pdf-editor/contracts';
import { mergeSavedRevision, replaceLoadedDocument, type LoadedDocument } from '../src/ui/EditorShell.js';

const documentInfo: DocumentInfo = {
  id: 'new-doc',
  revision: 0,
  savedRevision: 0,
  pageOrder: ['page-1'],
  sourceIds: ['source-new'],
  permissions: {
    modify: true,
    copy: true,
    annotate: true,
    fillForms: true,
    encrypted: false,
    signed: false,
  },
  capabilities: [],
};

const page: PageModel = {
  id: 'page-old',
  widthPt: 612,
  heightPt: 792,
  rotation: 0,
  objects: [],
};

const render: RenderResult = {
  width: 1,
  height: 1,
  stride: 4,
  format: 'rgba',
  pixels: new ArrayBuffer(4),
  revision: 0,
};

const previous: LoadedDocument = {
  info: { ...documentInfo, id: 'old-doc', pageOrder: ['page-old'] },
  name: 'old.pdf',
  page,
  render: { ...pageRenderGeometry(page, 1.25, 0, 1), bitmap: render },
};

describe('Document replacement', () => {
  it('closes only new session when first-page load fails, keeping previous session open', async () => {
    const closed: string[] = [];
    const engine = {
      open: async () => documentInfo,
      describePageMetrics: async () => { throw new Error('render setup failed'); },
      close: async (docId: string) => { closed.push(docId); },
    } as unknown as EngineAdapter;

    await expect(replaceLoadedDocument(
      engine,
      previous,
      { kind: 'bytes', sourceId: 'source-new', name: 'new.pdf', bytes: new ArrayBuffer(4) },
    )).rejects.toThrow('render setup failed');

    expect(closed).toEqual(['new-doc']);
  });

  it('merges a completed save into the latest document without rolling revision back', () => {
    const edited: LoadedDocument = {
      ...previous,
      info: { ...previous.info, revision: 5, savedRevision: 0 },
    };

    const saved = mergeSavedRevision(edited, 3);

    expect(saved.info.revision).toBe(5);
    expect(saved.info.savedRevision).toBe(3);
    expect(saved.page).toBe(edited.page);
    expect(saved.render).toBe(edited.render);
  });
});

describe('Inactive document bitmaps', () => {
  it('releases background pixels while retaining page metadata and view state', () => {
    let sessions!: ReturnType<typeof useDocumentSessions>;
    function Capture() { sessions = useDocumentSessions(); return null; }
    renderToStaticMarkup(createElement(Capture));
    sessions.add(previous);
    sessions.setSelectedIds(['selected-object']);
    const next = { ...previous, info: { ...previous.info, id: 'second-doc' }, name: 'second.pdf' };
    sessions.add(next);
    const inactive = sessions.current.current.documents.get(previous.info.id)!;
    expect(inactive.loaded.render.bitmap).toBeNull();
    expect(inactive.loaded.page).toEqual({ id: previous.page.id, widthPt: 612, heightPt: 792, rotation: 0 });
    expect(inactive.loaded.page).not.toHaveProperty('objects');
    expect(inactive.loaded.model.status).toBe('unloaded');
    expect(inactive.loaded.info).toBe(previous.info);
    expect(inactive.selectedIds).toEqual(['selected-object']);
    sessions.activate(previous.info.id);
    expect(sessions.current.current.activeId).toBe(previous.info.id);
    expect(sessions.current.current.documents.get('second-doc')!.loaded.render.bitmap).toBeNull();
    expect(matchesPageRender(inactive.loaded.render, inactive.zoom, 1)).toBe(false);
  });
});

describe('explicit page interaction ownership', () => {
  it('keeps a still-visible editing or geometric-placement page ahead of viewport-center tracking', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/DocumentViewport.tsx'), 'utf-8');
    const visible = source.indexOf('if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;');
    const ownership = source.indexOf("if ((current.pointer === 'edit' || current.drawing) && id === current.document.page.id) return;");
    const center = source.indexOf('const delta = middle < rect.top');
    expect(visible).toBeGreaterThanOrEqual(0);
    expect(ownership).toBeGreaterThan(visible);
    expect(ownership).toBeLessThan(center);
  });
});

describe('insert-and-edit readiness', () => {
  it('awaits the committed model before locating and opening newly inserted text or images', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    const insertion = source.slice(source.indexOf('if (await executeCommands([command], resources))'), source.indexOf('  useEffect(() => {\n    const change = () => {'));
    expect(insertion).toContain('const active = await ensureEditable(committed);');
    expect(insertion.indexOf('const active = await ensureEditable(committed);')).toBeLessThan(insertion.indexOf('let inserted = active.page.objects.find'));
    expect(insertion).toContain('setInlineRange(null); setInlineRangeIsLogical(false); setInlineHit(null); setInlineTextId(inserted.id);');
    expect(insertion).not.toContain('const active = loadedDocument(documentRef.current)');
  });

  it('keeps text/image placement clickable on the geometry overlay before an editing model is ready', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    const overlay = source.slice(source.indexOf('renderDisplayOverlay='), source.indexOf('renderOverlay='));
    expect(overlay).toContain('className="placement-layer"');
    expect(source).toContain('drawing={Boolean(annotationDrawing || pendingSignature || pagePlacement || placement)}');
  });
});

describe('Resizable AI inspector integration', () => {
  it('keeps renderAiPanel and exposes an accessible outer separator only for AI', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    expect(source).toContain("const aiPanelActive = hasAi && activeTool === 'ai'");
    expect(source).toContain('usePanelResize(aiPanelActive, railVisible)');
    expect(source).toContain('renderPaused={viewInteracting || panelResizing}');
    expect(source).toContain('data-ai-panel={aiPanelActive}');
    expect(source).toContain('{aiPanelActive && <div ref={separatorRef}');
    expect(source).toContain('role="separator" tabIndex={0}');
    expect(source).toContain('aria-orientation="vertical"');
    expect(source).toContain("aria-label={t('Resize AI panel')}");
    expect(source).toContain('aria-valuemin={AI_PANEL_MIN_WIDTH}');
    expect(source).toContain('aria-valuemax={AI_PANEL_MAX_WIDTH}');
    expect(source).toContain('aria-valuenow={AI_PANEL_DEFAULT_WIDTH}');
    expect(source).toContain('event.target.closest(\'[role="separator"], .ai-floating-window\')');
    expect(source).toContain('renderAiPanel ? renderAiPanel({');
  });

  it('keeps workspace columns in one stylesheet and scopes resizing to AI', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    const css = readFileSync(resolve(__dirname, '../src/ui/workspace.css'), 'utf-8');
    const ribbon = readFileSync(resolve(__dirname, '../src/ui/ribbon.css'), 'utf-8');
    expect(source).not.toContain("'--panel-size'");
    expect(css).toContain(".editor-workspace[data-panel='false'] { --panel-size: 0px; }");
    expect(css).toContain(".editor-workspace[data-panel='true'][data-ai-panel='true'] { --panel-size: var(--ai-panel-size, 400px); }");
    expect(css).toContain("[data-ai-overlay='true'] { --panel-size: 0px; }");
    expect(css).toContain('--panel-size: 320px');
    expect(css).toContain('--panel-size: 344px');
    expect(css).toContain('calc(100% - var(--navigation-size))');
    expect(css).toContain('grid-column: 1 / -1; inset: 0 0 0 auto; z-index: 20');
    expect(ribbon).toContain('user-select: none !important');
    expect(ribbon).not.toContain('--rail-size: 156px');
  });
});

describe('Host workspace slots', () => {
  it('keeps Files opt-in, exposes the agreed slots and opens a newly selected workspace', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    expect(source).toContain('workspacePanel?: ReactNode');
    expect(source).toContain('workspaceId?: string | null');
    expect(source).toContain('workspacePreview?: { name: string; content: ReactNode } | null');
    expect(source).toContain('const hasWorkspace = workspacePanel != null');
    expect(source).toContain("{hasWorkspace && <IconButton label=\"Files\"");
    expect(source).toContain("if (hasWorkspace && workspaceId) { setRailTab('files'); setRailOpen(true); }");
    expect(source).toContain("}, [hasWorkspace, workspaceId])");
    expect(source).toContain("const railVisible = railOpen && (railTab === 'files' ? hasWorkspace : Boolean(document) && tab !== 'pages')");
    expect(source).toContain('data-rail={railVisible} data-rail-tab={railTab}');
    expect(source).toContain("<div className=\"workspace-rail-content\" hidden={railTab !== 'files'}>{workspacePanel}</div>");
  });

  it('keeps the PDF mounted under a hidden stage and does not disable AI for a text preview', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    expect(source).toContain('<section ref={stageRef} hidden={previewActive}');
    expect(source).toContain('<DocumentViewport key={document.info.id}');
    expect(source).toContain('locked={previewActive || navigationBusy');
    expect(source).toContain('{workspacePreview && <section className="workspace-preview"');
    expect(source).toContain('{workspacePreview.content}');
    expect(source).toContain('name={workspacePreview?.name ?? document?.name}');
    expect(source).toContain('busy={operationBusy} documentActionsDisabled={previewActive}');
    expect(source).toContain('if (!previewActive) void saveDocument()');
    expect(source).toContain('if (previewActive) return;');
    expect(source.indexOf("if (modifier && ['s', 'f', 'p'].includes(key))")).toBeLessThan(source.indexOf('if (inFiles ||'));
    expect(source).toContain("if (modifier && key === 'o')");
    expect(source).toContain("event.target.closest('.workspace-rail-content')");
    expect(source).toContain("if (previewActive && tool !== 'ai') return");
    expect(source).toContain('hidden={!panelVisible}');
    expect(source).toContain("enabled: tab !== 'pages' && !previewActive");
    expect(source).toContain('{!previewActive && <ViewControls');
    const aiRender = source.slice(source.indexOf('{renderAiPanel ?'), source.indexOf('}) : aiPanel}'));
    expect(aiRender).toContain('selectedIds: aiSession?.selectedIds ?? selectedIds, engine, disabled: operationBusy');
    expect(aiRender).toContain('draftDirty: isDraftDirty, finishDrafts');
    expect(aiRender).toContain('saveDocument: () => saveDocument(false, aiDocument?.info.id)');
    expect(aiRender).not.toContain('disabled: operationBusy || previewActive');
  });

  it('places file navigation and previews in the shared workspace grid', () => {
    const css = readFileSync(resolve(__dirname, '../src/ui/workspace.css'), 'utf-8');
    expect(css).toContain(".editor-workspace[data-rail-tab='files'] { --rail-size: 244px; }");
    expect(css).toContain('--rail-size: 180px');
    expect(css).toContain('.workspace-preview { grid-column: 3; grid-row: 1;');
    expect(css).toContain("grid-template-areas: 'topbar' 'tabs' 'ribbon' 'workspace' 'status'");
    expect(css).toContain('.is-workspace-preview .editor-ribbon');
    expect(css).toContain('width: min(260px, calc(100% - 36px))');
  });
});

describe('Brand entrances', () => {
  it('declares komopdf as default productName in EditorShell', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    expect(source).toContain("productName = 'komopdf'");
    expect(source).toContain('productName={productName}');
    const chrome = readFileSync(resolve(__dirname, '../src/ui/EditorChrome.tsx'), 'utf-8');
    expect(chrome).toContain('<span className="komopdf-logo" aria-hidden="true" />');
    const brand = readFileSync(resolve(__dirname, '../brand/brand.css'), 'utf-8');
    expect(brand).toContain("url('./logo-full.svg')");
    expect(brand).toContain("url('./icon.svg')");
  });

  it('lists all recoverable documents with explicit actions', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    expect(source).toContain('recovery-list');
    expect(source).toContain('pendingRecovery.map(item =>');
    expect(source).toContain('Recover Unsaved Document');
    expect(source).toContain('restorePendingRecovery');
    expect(source).toContain('discardPendingRecovery');
  });
});
