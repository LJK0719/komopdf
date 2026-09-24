import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { DocumentInfo, EngineAdapter, PageModel, EditTransaction, TextBlock } from '@pdf-editor/contracts';
import { CommandRegistry } from '@pdf-editor/commands';
import { TextEditPanel, resolveSelectionFormatStyle, resolveSelectionFormatRuns } from '../src/ui/TextEditPanel.js';
import { type EditorFont } from '../src/ui/font-resources.js';
import { packCommands, EDIT_COMMAND_STRIDE } from '../src/worker/abi3-commands.js';

const sampleDocument: DocumentInfo = {
  id: 'doc-text-1',
  revision: 1,
  savedRevision: 0,
  pageOrder: ['page-1'],
  sourceIds: ['src-1'],
  permissions: {
    modify: true,
    copy: true,
    annotate: true,
    fillForms: true,
    encrypted: false,
    signed: false,
  },
  capabilities: ['text.replace', 'text.style'],
};

const mockFonts: EditorFont[] = [
  { id: 'noto-sans-cjk-sc-regular', family: 'Noto Sans CJK SC', style: 'Regular', weight: 400, italic: false, format: 'otf' },
  { id: 'noto-sans-cjk-sc-bold', family: 'Noto Sans CJK SC', style: 'Bold', weight: 700, italic: false, format: 'otf' },
  { id: 'liberation-sans-regular', family: 'Liberation Sans', style: 'Regular', weight: 400, italic: false, format: 'ttf' },
  { id: 'liberation-sans-bold', family: 'Liberation Sans', style: 'Bold', weight: 700, italic: false, format: 'ttf' },
  { id: 'liberation-sans-italic', family: 'Liberation Sans', style: 'Italic', weight: 400, italic: true, format: 'ttf' },
  { id: 'liberation-sans-bold-italic', family: 'Liberation Sans', style: 'Bold Italic', weight: 700, italic: true, format: 'ttf' },
  { id: 'restricted-font-bold', family: 'Restricted Font', style: 'Bold', weight: 700, italic: false, format: 'ttf', editableEmbedding: false },
];

const registeredBlock: TextBlock = {
  id: 'block-1',
  pageId: 'page-1',
  sourceObjectIds: ['text-obj-1'],
  bounds: { x: 50, y: 100, width: 200, height: 24 },
  transform: [1, 0, 0, 1, 0, 0],
  editability: 'direct',
  isParagraph: true,
  runs: [
    { text: 'Registered sample text', style: { fontId: 'liberation-sans-regular', fontSize: 16 }, sourceObjectIds: ['text-obj-1'] },
  ],
};

const unregisteredBlock: TextBlock = {
  id: 'block-unregistered',
  pageId: 'page-1',
  sourceObjectIds: ['text-obj-unregistered'],
  bounds: { x: 50, y: 150, width: 200, height: 24 },
  transform: [1, 0, 0, 1, 0, 0],
  editability: 'direct',
  runs: [
    { text: 'Unregistered font text', style: { fontId: 'F1', fontSize: 14 }, sourceObjectIds: ['text-obj-unregistered'] },
  ],
};

const mockPage: PageModel = {
  id: 'page-1',
  widthPt: 612,
  heightPt: 792,
  rotation: 0,
  objects: [
    {
      id: 'text-obj-1',
      pageId: 'page-1',
      type: 'text',
      bounds: { x: 50, y: 100, width: 200, height: 24 },
      transform: [1, 0, 0, 1, 0, 0],
      locator: { pageId: 'page-1', containerPath: [], objectIndex: 0 },
      textBlock: registeredBlock,
    },
    {
      id: 'text-obj-unregistered',
      pageId: 'page-1',
      type: 'text',
      bounds: { x: 50, y: 150, width: 200, height: 24 },
      transform: [1, 0, 0, 1, 0, 0],
      locator: { pageId: 'page-1', containerPath: [], objectIndex: 1 },
      textBlock: unregisteredBlock,
    },
  ],
};

class TestAllocator {
  private next = 1;
  readonly strings = new Map<number, string>();
  readonly buffers = new Map<number, Uint8Array>();

  string(value: string): number {
    const ptr = this.next++;
    this.strings.set(ptr, value);
    return ptr;
  }

  bytes(value: Uint8Array): number {
    const ptr = this.next++;
    this.buffers.set(ptr, value.slice());
    return ptr;
  }
}

describe('TextEditPanel - Real Font Face Selection', () => {
  it('formats mixed paragraph faces without flattening preserved posture or family', () => {
    const block: TextBlock = { ...registeredBlock, runs: [
      { text: 'Normal ', style: { fontId: 'liberation-sans-regular' }, sourceObjectIds: ['text-obj-1'] },
      { text: 'italic ', style: { fontId: 'liberation-sans-italic' }, sourceObjectIds: ['text-obj-1'] },
      { text: '中文', style: { fontId: 'noto-sans-cjk-sc-regular' }, sourceObjectIds: ['text-obj-1'] },
    ] };
    const formats = resolveSelectionFormatRuns({ block, range: [2, 16], fonts: mockFonts, formatWeight: 700 });
    expect(formats.map(part => [part.range, part.style.fontId])).toEqual([
      [[2, 7], 'liberation-sans-bold'],
      [[7, 14], 'liberation-sans-bold-italic'],
      [[14, 16], 'noto-sans-cjk-sc-bold'],
    ]);
    expect(() => resolveSelectionFormatRuns({ block, range: [0, 16], fonts: mockFonts, formatItalic: 'on' }))
      .toThrow('No exact weight 400 italic face');
  });

  beforeEach(() => {
    vi.stubGlobal('location', { href: 'http://localhost/editor/', origin: 'http://localhost' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockFonts,
    }));
  });

  it('renders real weight and posture selection controls in Format selected text region', () => {
    const engine = {
      previewText: vi.fn(),
      previewTransaction: vi.fn(),
      apply: vi.fn(),
    } as unknown as EngineAdapter;

    const html = renderToString(
      React.createElement(TextEditPanel, {
        document: sampleDocument,
        page: mockPage,
        selectedIds: ['text-obj-1'],
        engine,
        onCommitted: vi.fn(),
      })
    );

    expect(html).toContain('Selection font');
    expect(html).toContain('Selection weight');
    expect(html).toContain('Selection posture');
    expect(html).toContain('Regular (400)');
    expect(html).toContain('Bold (700)');
    expect(html).toContain('Regular (Upright)');
    expect(html).toContain('Italic');
  });

  it('resolves exact face ID from selected weight and italic and writes only fontId into text.style', async () => {
    const { style, resolvedFontId } = resolveSelectionFormatStyle({
      block: registeredBlock,
      range: [0, 10],
      fonts: mockFonts,
      formatFontId: '', // Preserve family from selection ('Liberation Sans')
      formatWeight: 700,
      formatItalic: 'on',
      formatSize: '18',
      formatColor: '#112233',
      formatUnderline: 'on',
    });

    expect(resolvedFontId).toBe('liberation-sans-bold-italic');
    expect(style.fontId).toBe('liberation-sans-bold-italic');
    expect(style.fontSize).toBe(18);
    expect(style.underline).toBe(true);
    // Crucial: Must NOT include raw weight or italic in TextStyle sent to ABI3
    expect('weight' in style).toBe(false);
    expect('italic' in style).toBe(false);

    const appliedTransactions: EditTransaction[] = [];
    const engine = {
      previewTransaction: vi.fn(async (tx: EditTransaction) => ({
        docId: tx.docId,
        baseRevision: tx.baseRevision,
        pageOrder: ['page-1'],
        changedPageIds: ['page-1'],
      })),
      apply: vi.fn(async (tx: EditTransaction) => {
        appliedTransactions.push(tx);
        return {
          docId: tx.docId,
          revision: tx.baseRevision + 1,
          changedPageIds: ['page-1'],
          pageOrder: ['page-1'],
          canUndo: true,
          canRedo: false,
        };
      }),
    } as unknown as EngineAdapter;

    const registry = new CommandRegistry(engine);
    const tx: EditTransaction = {
      id: 'tx-style-1',
      docId: sampleDocument.id,
      baseRevision: sampleDocument.revision,
      source: 'manual',
      commands: [{ type: 'text.style', pageId: 'page-1', blockIds: [registeredBlock.id], range: [0, 10], style }],
    };

    await engine.previewTransaction(tx);
    await registry.execute(tx, {
      document: sampleDocument,
      pages: new Map([['page-1', mockPage]]),
      fontIds: new Set([resolvedFontId!]),
    });

    expect(appliedTransactions).toHaveLength(1);
    const allocator = new TestAllocator();
    const ptr = packCommands(allocator, appliedTransactions[0]!.commands);
    expect(ptr).toBeGreaterThan(0);
    expect(allocator.buffers.get(ptr)?.byteLength).toBe(EDIT_COMMAND_STRIDE);
  });

  it('rejects clearly and preserves layout when no exact face matches requested weight/italic', () => {
    expect(() =>
      resolveSelectionFormatStyle({
        block: registeredBlock,
        range: [0, 10],
        fonts: mockFonts,
        formatFontId: 'noto-sans-cjk-sc-regular',
        formatWeight: 700,
        formatItalic: 'on', // Noto Sans CJK SC has no italic face
      })
    ).toThrow(/No exact weight 700 italic face registered for "Noto Sans CJK SC".*Synthetic bold\/italic is not supported; original typesetting preserved/);
  });

  it('rejects clearly when applying weight/italic to an unregistered PDF font without choosing a registered family', () => {
    expect(() =>
      resolveSelectionFormatStyle({
        block: unregisteredBlock,
        range: [0, 12],
        fonts: mockFonts,
        formatFontId: '',
        formatWeight: 700,
      })
    ).toThrow(/Cannot apply weight or italic without selecting a registered font/);
  });

  it('rejects clearly when target font face forbids editable embedding', () => {
    expect(() =>
      resolveSelectionFormatStyle({
        block: registeredBlock,
        range: [0, 10],
        fonts: mockFonts,
        formatFontId: 'restricted-font-bold',
      })
    ).toThrow(/restricted from editable embedding/);
  });
});
