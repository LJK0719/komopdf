import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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
  render,
};

describe('Document replacement', () => {
  it('closes only new session when first-page load fails, keeping previous session open', async () => {
    const closed: string[] = [];
    const engine = {
      open: async () => documentInfo,
      describePage: async () => { throw new Error('render setup failed'); },
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

describe('Resizable AI inspector integration', () => {
  it('keeps renderAiPanel and exposes an accessible outer separator only for AI', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    expect(source).toContain("const aiPanelActive = hasAi && activeTool === 'ai'");
    expect(source).toContain('usePanelResize(aiPanelActive, railVisible)');
    expect(source).toContain("enabled: tab !== 'pages' && !panelResizing");
    expect(source).toContain('data-ai-panel={aiPanelActive}');
    expect(source).toContain('{aiPanelActive && <div ref={separatorRef}');
    expect(source).toContain('role="separator" tabIndex={0}');
    expect(source).toContain('aria-orientation="vertical"');
    expect(source).toContain("aria-label={t('Resize AI panel')}");
    expect(source).toContain('aria-valuemin={AI_PANEL_MIN_WIDTH}');
    expect(source).toContain('aria-valuemax={AI_PANEL_MAX_WIDTH}');
    expect(source).toContain('aria-valuenow={AI_PANEL_DEFAULT_WIDTH}');
    expect(source).toContain('event.target.closest(\'[role="separator"]\')');
    expect(source).toContain('renderAiPanel ? renderAiPanel({');
  });

  it('does not override the hidden column or the original non-AI inspector widths', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    const css = readFileSync(resolve(__dirname, '../src/ui/ribbon.css'), 'utf-8');
    expect(source).not.toContain("'--panel-size'");
    expect(css).toContain(".editor-workspace[data-panel='false'] { --panel-size: 0px; }");
    expect(css).toContain(".editor-workspace[data-panel='true'][data-ai-panel='true'] { --panel-size: var(--ai-panel-size, 400px); }");
    expect(css).toContain("[data-ai-overlay='true'] { --panel-size: 0px; }");
    expect(css).toContain('--panel-size: 320px');
    expect(css).toContain('--panel-size: 300px');
    expect(css).toContain('calc(100% - var(--navigation-size) - var(--utility-size))');
    expect(css).toContain('grid-column: 1 / -1; z-index: 11');
    expect(css).toContain('user-select: none !important');
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
    expect(source).toContain("const railVisible = railOpen && (railTab === 'files' ? hasWorkspace : Boolean(document))");
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
    expect(source).toContain('if (previewActive || (event.target instanceof Element');
    expect(source).toContain("event.key.toLowerCase() === 'o'");
    expect(source).toContain("event.target.closest('.workspace-rail-content')");
    expect(source).toContain("if (previewActive && tool !== 'ai') return");
    expect(source).toContain('hidden={!panelVisible}');
    expect(source).toContain("enabled: tab !== 'pages' && !panelResizing && !previewActive");
    expect(source).toContain('{!previewActive && <ViewControls');
    const aiRender = source.slice(source.indexOf('{renderAiPanel ?'), source.indexOf('}) : aiPanel}'));
    expect(aiRender).toContain('selectedIds, engine, disabled: isBusy, onCommitted: handleCommitted');
    expect(aiRender).not.toContain('disabled: isBusy || previewActive');
  });

  it('uses a separate Files width and places previews in the canvas column without a ribbon gap', () => {
    const css = readFileSync(resolve(__dirname, '../src/ui/ribbon.css'), 'utf-8');
    expect(css).toContain(".editor-workspace[data-rail='true'][data-rail-tab='files'] { --rail-size: 244px; }");
    expect(css).toContain('--rail-size: 156px');
    expect(css).toContain('.workspace-preview { grid-column: 3; grid-row: 1;');
    expect(css).toContain('.editor-shell.is-workspace-preview { grid-template-rows: 52px minmax(0, 1fr) 38px; }');
    expect(css).toContain('.is-workspace-preview > .editor-ribbon');
    expect(css).toContain(".editor-workspace[data-rail-tab='files'] .page-rail { width: min(244px, calc(100% - 72px)); }");
  });
});

describe('Brand entrances', () => {
  it('declares komopdf as default productName in EditorShell', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    expect(source).toContain("productName = 'komopdf'");
    expect(source).toContain('productName={productName}');
    const chrome = readFileSync(resolve(__dirname, '../src/ui/EditorChrome.tsx'), 'utf-8');
    expect(chrome).toContain('<span className="brand-mark" aria-hidden="true">k</span>');
  });

  it('declares recovery banner and actions in EditorShell', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    expect(source).toContain('recovery-banner');
    expect(source).toContain('Recover Unsaved Document');
    expect(source).toContain('restorePendingRecovery');
    expect(source).toContain('discardPendingRecovery');
  });
});
