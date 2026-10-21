import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentInfo, EngineAdapter, HostAdapter, PageModel } from '@pdf-editor/contracts';
import { DocumentToolsPanel } from '../src/ui/DocumentToolsPanel.js';
import { ExportPanel } from '../src/ui/ExportPanel.js';
import { PrintPanel } from '../src/ui/PrintPanel.js';
import { OcrPanel } from '../src/ui/OcrPanel.js';
import { PdfSearchPanel } from '../src/ui/PdfSearchPanel.js';
import { ObjectEditPanel } from '../src/ui/ObjectEditPanel.js';
import { parsePageIndices } from '../src/ui/page-import-utils.js';

const document: DocumentInfo = {
  id: 'doc-panels', revision: 1, savedRevision: 1, pageOrder: ['page-1'], sourceIds: [],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false, print: true },
  capabilities: ['form.fill', 'form.update', 'annotation.add', 'objects.transform', 'text.insert'],
};
const page: PageModel = { id: 'page-1', widthPt: 612, heightPt: 792, rotation: 0, objects: [] };
const engine = { recognizeOcr: vi.fn(), apply: vi.fn() } as unknown as EngineAdapter;
const host = { capabilities: { platform: 'web' } } as HostAdapter;
const onBusyChange = vi.fn();
const onCommitted = vi.fn(async () => {});

function expectFooterAction(html: string, action: string) {
  expect(html).toContain('task-panel-body');
  const footer = html.slice(html.indexOf('<footer'));
  expect(footer).toContain('task-panel-footer');
  expect(footer).toContain(action);
}

describe('task panel layout and delivery', () => {
  it('keeps export in the footer and links the desktop-only conversion handoff', () => {
    const onExport = vi.fn();
    const html = renderToStaticMarkup(<ExportPanel disabled={false} encrypted={false} signed={false}
      wordAvailable={false} onExport={onExport} />);
    expectFooterAction(html, 'Export PDF');
    expect(html).toContain('href="/download/"');
    expect(html).toContain('Save a PDF copy first');
    expect(html).toContain('do not transfer automatically');
    expect(onExport).not.toHaveBeenCalled();
  });

  it('keeps the print action in the footer without changing the browser print workflow', () => {
    const html = renderToStaticMarkup(<PrintPanel disabled={false} docId={document.id} pageIds={document.pageOrder}
      encrypted={false} canPrint engine={engine} host={host} onBusyChange={onBusyChange} />);
    expectFooterAction(html, 'Open print dialog');
    expect(html).toContain('browser print dialog');
  });

  it('keeps search continuation and replacement reachable in the fixed footer', () => {
    const html = renderToStaticMarkup(<PdfSearchPanel document={{ ...document, capabilities: ['text.replace'] }}
      engine={engine} disabled={false} onLocate={vi.fn()} onCommitted={onCommitted} />);
    expectFooterAction(html, 'Next match');
    expectFooterAction(html, 'Replace selected match');
    expect(html).toContain('Search options');
    expect(html).toContain('aria-keyshortcuts="Enter Shift+Enter F3 Shift+F3"');
  });

  it('shows forms and object editing as separate titled tasks with footer actions', () => {
    const forms = renderToStaticMarkup(<DocumentToolsPanel mode="forms" document={document} page={page}
      selectedIds={[]} engine={engine} disabled={false} onBusyChange={onBusyChange} onCommitted={onCommitted} />);
    expect(forms).toContain('<h2>Forms</h2>');
    expectFooterAction(forms, 'Apply all form changes');
    const objects = renderToStaticMarkup(<ObjectEditPanel mode="arrange" document={document} page={page}
      selectedIds={[]} engine={engine} host={host} disabled={false} onBusyChange={onBusyChange}
      onCommitted={onCommitted} onSelectionChange={vi.fn()} />);
    expect(objects).toContain('Scale and rotation');
    expectFooterAction(objects, 'Move');
  });

  it('places OCR execution in the footer and uses the existing strict range rules', () => {
    const html = renderToStaticMarkup(<OcrPanel document={document} page={page} selectedIds={[]}
      engine={engine} disabled={false} onBusyChange={onBusyChange} onCommitted={onCommitted} />);
    expectFooterAction(html, 'Run OCR on page');
    expect(html).toContain('Current page (page 1)');
    expect(html).toContain('Text layer options');
    for (const value of ['1junk', '1,', '0', '1-2', '2-1']) {
      expect(() => parsePageIndices(value, 1)).toThrow();
    }
    expect(parsePageIndices('all', 1)).toEqual([0]);
    expect(engine.apply).not.toHaveBeenCalled();
  });
});
