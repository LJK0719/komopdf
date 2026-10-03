import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CommitResult, DocumentInfo, EngineAdapter, PageModel, PdfAnnotationInfo } from '@pdf-editor/contracts';
import { AnnotationDrawingLayer } from '../src/ui/AnnotationDrawingLayer.js';
import { DocumentToolsPanel } from '../src/ui/DocumentToolsPanel.js';
import { annotationPointFromClient, buildDrawnAnnotation, commitDrawnAnnotation, filterAnnotations,
  type AnnotationDrawingOptions } from '../src/ui/annotation-drawing.js';

const document: DocumentInfo = {
  id: 'doc-1', revision: 4, savedRevision: 3, pageOrder: ['page-1', 'page-2'], sourceIds: [],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false },
  capabilities: ['annotation.add', 'annotation.update', 'annotation.delete'],
};
const page: PageModel = { id: 'page-1', widthPt: 612, heightPt: 792, rotation: 0, objects: [] };
const options: AnnotationDrawingOptions = { tool: 'rectangle', color: '#336699', opacity: 0.7, strokeWidth: 3, text: '' };
const result: CommitResult = { docId: 'doc-1', revision: 5, changedPageIds: ['page-1'], pageOrder: document.pageOrder, canUndo: true, canRedo: false };
function mockEngine() {
  return { previewTransaction: vi.fn(async () => ({ docId: 'doc-1', baseRevision: 4, pageOrder: document.pageOrder, changedPageIds: ['page-1'] })),
    apply: vi.fn(async () => result), describeAnnotations: vi.fn(async () => []) } as unknown as EngineAdapter;
}

describe('direct PDF annotations', () => {
  it('maps actual CSS dimensions and scrolling offsets to top-left PDF page coordinates at any zoom', () => {
    expect(annotationPointFromClient(253, 248, { left: 100, top: 50, width: 306, height: 396 }, page)).toEqual([306, 396]);
    expect(annotationPointFromClient(559, 644, { left: 100, top: 50, width: 918, height: 1188 }, page)).toEqual([306, 396]);
    expect(annotationPointFromClient(-50, 9999, { left: 100, top: 50, width: 306, height: 396 }, page)).toEqual([0, 792]);
  });

  it('uses displayed rotated-page dimensions without a second rotation or Y flip', () => {
    const rotated = { ...page, widthPt: 792, heightPt: 612, rotation: 90 as const };
    expect(annotationPointFromClient(200, 250, { left: 100, top: 50, width: 792, height: 612 }, rotated)).toEqual([100, 200]);
  });

  it('normalizes a reverse rectangle drag and preserves PDF stroke width, opacity and RGB', () => {
    const command = buildDrawnAnnotation(page, options, [[250, 150], [50, 100]]);
    expect(command).toMatchObject({ type: 'annotation.add', pageId: 'page-1', subtype: 'rectangle',
      bounds: { x: 50, y: 100, width: 200, height: 50 }, color: [0.2, 0.4, 0.6], opacity: 0.7, strokeWidth: 3 });
    expect(command).not.toHaveProperty('points');
  });

  it('pads ink bounds for line width while clamping to the page', () => {
    const command = buildDrawnAnnotation(page, { ...options, tool: 'ink', strokeWidth: 4 }, [[0, 10], [20, 10], [30, 0]]);
    expect(command).toMatchObject({ subtype: 'ink', bounds: { x: 0, y: 0, width: 32, height: 12 },
      points: [[0, 10], [20, 10], [30, 0]], strokeWidth: 4 });
  });

  it('puts the note inside the page and keeps its actual entered content', () => {
    const command = buildDrawnAnnotation(page, { ...options, tool: 'text', text: '  Check this paragraph\n第二行  ' }, [[612, 792]]);
    expect(command).toMatchObject({ subtype: 'text', text: 'Check this paragraph\n第二行',
      bounds: { x: 588, y: 768, width: 24, height: 24 } });
  });

  it('ignores empty gestures and blank notes rather than creating undo entries', () => {
    expect(buildDrawnAnnotation(page, options, [])).toBeNull();
    expect(buildDrawnAnnotation(page, options, [[10, 10], [10, 50]])).toBeNull();
    expect(buildDrawnAnnotation(page, { ...options, tool: 'ink' }, [[10, 10]])).toBeNull();
    expect(buildDrawnAnnotation(page, { ...options, tool: 'ink' }, [[10, 10], [10, 10]])).toBeNull();
    expect(buildDrawnAnnotation(page, { ...options, tool: 'text', text: ' \n ' }, [[10, 10]])).toBeNull();
  });

  it('previews and commits exactly one real annotation.add transaction per completed gesture', async () => {
    const engine = mockEngine(), committed = vi.fn(async () => {});
    const command = buildDrawnAnnotation(page, options, [[10, 10], [80, 90]])!;
    await commitDrawnAnnotation(engine, document, page, command, () => true, committed);
    expect(engine.previewTransaction).toHaveBeenCalledOnce(); expect(engine.apply).toHaveBeenCalledOnce();
    expect(engine.apply).toHaveBeenCalledWith(expect.objectContaining({ docId: document.id, baseRevision: 4,
      source: 'manual', commands: [command] }));
    expect(committed).toHaveBeenCalledWith(result);
  });

  it('does not apply stale document/revision or Esc-cancelled drafts after asynchronous preview', async () => {
    const engine = mockEngine(), committed = vi.fn(async () => {});
    const command = buildDrawnAnnotation(page, options, [[10, 10], [80, 90]])!;
    let current = true;
    vi.mocked(engine.previewTransaction).mockImplementation(async () => { current = false; return {
      docId: 'doc-1', baseRevision: 4, pageOrder: document.pageOrder, changedPageIds: ['page-1'],
    }; });
    await commitDrawnAnnotation(engine, document, page, command, () => current, committed);
    expect(engine.apply).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
    await commitDrawnAnnotation(engine, document, page, command, () => false, committed);
    expect(engine.previewTransaction).toHaveBeenCalledOnce();
  });

  it('checks annotation permission before even requesting a preview', async () => {
    const engine = mockEngine();
    const command = buildDrawnAnnotation(page, options, [[10, 10], [80, 90]])!;
    await expect(commitDrawnAnnotation(engine, { ...document, permissions: { ...document.permissions, annotate: false } },
      page, command, () => true, async () => {})).rejects.toThrow('not permitted');
    expect(engine.previewTransaction).not.toHaveBeenCalled(); expect(engine.apply).not.toHaveBeenCalled();
  });

  it('does not mount an event-catching overlay unless an annotation tool is explicitly active', () => {
    const props = { document, page, engine: mockEngine(), options: null, disabled: false,
      onBusyChange: vi.fn(), onCommitted: vi.fn(async () => {}), onCancel: vi.fn() };
    expect(renderToStaticMarkup(createElement(AnnotationDrawingLayer, props))).toBe('');
    const html = renderToStaticMarkup(createElement(AnnotationDrawingLayer, { ...props, options }));
    expect(html).toContain('data-annotation-tool="rectangle"'); expect(html).toContain('viewBox="0 0 612 792"');
    expect(html).toContain('Drag to draw a rectangle. Esc cancels.');
    expect(renderToStaticMarkup(createElement(AnnotationDrawingLayer, { ...props, options,
      document: { ...document, permissions: { ...document.permissions, annotate: false } } }))).toBe('');
  });
});

describe('document annotation list', () => {
  const annotations: PdfAnnotationInfo[] = [
    { id: 'n1', pageId: 'page-1', subtype: 'text', text: 'Review the Summary', bounds: { x: 0, y: 0, width: 24, height: 24 }, color: [1, 1, 0], opacity: 1 },
    { id: 'n2', pageId: 'page-2', subtype: 'text', text: 'Review 方法', bounds: { x: 0, y: 0, width: 24, height: 24 }, color: [1, 1, 0], opacity: 1 },
    { id: 'r1', pageId: 'page-2', subtype: 'rectangle', text: 'Summary figure', bounds: { x: 0, y: 0, width: 100, height: 80 }, color: [0, 0, 0], opacity: 1 },
  ];
  it('shows every page by default, and combines page, subtype and case-insensitive text filters', () => {
    expect(filterAnnotations(annotations, { pageId: '', subtype: '', text: '' })).toEqual(annotations);
    expect(filterAnnotations(annotations, { pageId: 'page-2', subtype: 'text', text: ' REVIEW ' }).map(a => a.id)).toEqual(['n2']);
    expect(filterAnnotations(annotations, { pageId: '', subtype: '', text: '方法' }).map(a => a.id)).toEqual(['n2']);
    expect(filterAnnotations(annotations, { pageId: 'page-1', subtype: 'ink', text: '' })).toEqual([]);
  });

  it('offers accessible tool activation and all-document filtering without removing legacy tools', () => {
    const html = renderToStaticMarkup(createElement(DocumentToolsPanel, { document, page, engine: mockEngine(), selectedIds: [],
      disabled: false, drawing: options, onDrawingChange: vi.fn(), onNavigate: vi.fn(), onBusyChange: vi.fn(), onCommitted: vi.fn(async () => {}) }));
    expect(html).toContain('aria-label="Draw annotations"'); expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Document annotations'); expect(html).toContain('All pages'); expect(html).toContain('All types');
    expect(html).toContain('Find annotation text'); expect(html).toContain('Add highlight'); expect(html).toContain('Add ink');
    expect(html).toContain('Forms on this page'); expect(html).toContain('Use selection bounds');
  });
});
