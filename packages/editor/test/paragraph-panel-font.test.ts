import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { DocumentInfo, EngineAdapter, PageModel, EditCommand, EditTransaction } from '@pdf-editor/contracts';
import { CommandRegistry, validateTransaction } from '@pdf-editor/commands';
import { ParagraphPanel, buildParagraphStyle } from '../src/ui/ParagraphPanel.js';
import { resolveExactFontFace, type EditorFont } from '../src/ui/font-resources.js';
import { packCommands, EDIT_COMMAND_STRIDE } from '../src/worker/abi3-commands.js';

const sampleDocument: DocumentInfo = {
  id: 'doc-para-1',
  revision: 2,
  savedRevision: 1,
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
  capabilities: ['text.reflow', 'text.insert'],
};

const mockFonts: EditorFont[] = [
  { id: 'noto-sans-cjk-sc-regular', family: 'Noto Sans CJK SC', style: 'Regular', weight: 400, italic: false, format: 'otf' },
  { id: 'noto-sans-cjk-sc-bold', family: 'Noto Sans CJK SC', style: 'Bold', weight: 700, italic: false, format: 'otf' },
  { id: 'liberation-sans-regular', family: 'Liberation Sans', style: 'Regular', weight: 400, italic: false, format: 'ttf' },
  { id: 'liberation-sans-bold', family: 'Liberation Sans', style: 'Bold', weight: 700, italic: false, format: 'ttf' },
  { id: 'liberation-sans-italic', family: 'Liberation Sans', style: 'Italic', weight: 400, italic: true, format: 'ttf' },
  { id: 'liberation-sans-bold-italic', family: 'Liberation Sans', style: 'Bold Italic', weight: 700, italic: true, format: 'ttf' },
];

const mockPage: PageModel = {
  id: 'page-1',
  widthPt: 612,
  heightPt: 792,
  rotation: 0,
  objects: [
    {
      id: 'obj-line-1',
      pageId: 'page-1',
      type: 'text',
      bounds: { x: 36, y: 100, width: 200, height: 20 },
      transform: [1, 0, 0, 1, 0, 0],
      locator: { pageId: 'page-1', containerPath: [], objectIndex: 0 },
      textBlock: {
        id: 'block-line-1',
        pageId: 'page-1',
        sourceObjectIds: ['obj-line-1'],
        bounds: { x: 36, y: 100, width: 200, height: 20 },
        transform: [1, 0, 0, 1, 0, 0],
        editability: 'direct',
        runs: [{ text: 'Line 1', style: { fontSize: 14 }, sourceObjectIds: ['obj-line-1'] }],
      },
    },
    {
      id: 'obj-line-2',
      pageId: 'page-1',
      type: 'text',
      bounds: { x: 36, y: 124, width: 200, height: 20 },
      transform: [1, 0, 0, 1, 0, 0],
      locator: { pageId: 'page-1', containerPath: [], objectIndex: 1 },
      textBlock: {
        id: 'block-line-2',
        pageId: 'page-1',
        sourceObjectIds: ['obj-line-2'],
        bounds: { x: 36, y: 124, width: 200, height: 20 },
        transform: [1, 0, 0, 1, 0, 0],
        editability: 'direct',
        runs: [{ text: 'Line 2', style: { fontSize: 14 }, sourceObjectIds: ['obj-line-2'] }],
      },
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

describe('ParagraphPanel - Real Font Face Selection for text.reflow and text.insert', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { href: 'http://localhost/editor/', origin: 'http://localhost' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockFonts,
    }));
  });

  it('renders paragraph controls and preserves Font combobox while supporting weight/posture selection', () => {
    const engine = {
      previewTextInsert: vi.fn(),
      previewTransaction: vi.fn(),
      apply: vi.fn(),
    } as unknown as EngineAdapter;

    const html = renderToString(
      React.createElement(ParagraphPanel, {
        document: sampleDocument,
        page: mockPage,
        selectedIds: ['obj-line-1', 'obj-line-2'],
        engine,
        onCommitted: vi.fn(),
      })
    );

    expect(html).toContain('Paragraph Reflow &amp; Insert');
    expect(html).toContain('Font');
    expect(html).toContain('Preview paragraph');
    expect(html).toContain('Reflow selected text');
    expect(html).toContain('Insert paragraph');
  });

  it('writes exact matched face ID into text.reflow and text.insert commands without weight/italic metadata', async () => {
    const matchBoldItalic = resolveExactFontFace(mockFonts, {
      family: 'Liberation Sans',
      weight: 700,
      italic: true,
    });
    expect(matchBoldItalic.success).toBe(true);
    if (!matchBoldItalic.success) return;

    const style = buildParagraphStyle({
      fontId: matchBoldItalic.font.id,
      fontSize: 16,
      color: '#223344',
      lineHeight: 1.3,
      alignment: 'justify',
      underline: true,
      characterSpacing: '0.5',
    });

    expect(style.fontId).toBe('liberation-sans-bold-italic');
    expect('weight' in style).toBe(false);
    expect('italic' in style).toBe(false);

    const reflowCmd: EditCommand = {
      type: 'text.reflow',
      pageId: 'page-1',
      objectId: 'new-para-reflow',
      blockIds: ['block-line-1', 'block-line-2'],
      bounds: { x: 36, y: 100, width: 240, height: 120 },
      text: 'Line 1\nLine 2',
      style,
    };

    const insertCmd: EditCommand = {
      type: 'text.insert',
      pageId: 'page-1',
      objectId: 'new-para-insert',
      bounds: { x: 36, y: 260, width: 240, height: 120 },
      text: 'Inserted bold italic paragraph',
      style,
      paragraph: true,
    };

    const context = {
      document: sampleDocument,
      pages: new Map([['page-1', mockPage]]),
      fontIds: new Set(mockFonts.map(f => f.id)),
    };

    // Validate both transactions through @pdf-editor/commands
    const reflowTx: EditTransaction = {
      id: 'tx-reflow',
      docId: sampleDocument.id,
      baseRevision: sampleDocument.revision,
      source: 'manual',
      commands: [reflowCmd],
    };
    expect(() => validateTransaction(reflowTx, context)).not.toThrow();

    const insertTx: EditTransaction = {
      id: 'tx-insert',
      docId: sampleDocument.id,
      baseRevision: sampleDocument.revision,
      source: 'manual',
      commands: [insertCmd],
    };
    expect(() => validateTransaction(insertTx, context)).not.toThrow();

    // Verify ABI3 encoding succeeds for both commands
    const allocator = new TestAllocator();
    const ptr = packCommands(allocator, [reflowCmd, insertCmd]);
    expect(ptr).toBeGreaterThan(0);
    expect(allocator.buffers.get(ptr)?.byteLength).toBe(2 * EDIT_COMMAND_STRIDE);

    // Execute through CommandRegistry
    const engine = {
      apply: vi.fn(async (tx: EditTransaction) => ({
        docId: tx.docId,
        revision: tx.baseRevision + 1,
        changedPageIds: ['page-1'],
        pageOrder: ['page-1'],
        canUndo: true,
        canRedo: false,
      })),
    } as unknown as EngineAdapter;
    const registry = new CommandRegistry(engine);
    await registry.execute(reflowTx, context);
    expect(engine.apply).toHaveBeenCalledOnce();
  });

  it('rejects unavailable posture/weight in ParagraphPanel without synthesizing faux glyphs', () => {
    const noItalicMatch = resolveExactFontFace(mockFonts, {
      family: 'Noto Sans CJK SC',
      weight: 700,
      italic: true,
    });
    expect(noItalicMatch.success).toBe(false);
    if (!noItalicMatch.success) {
      expect(noItalicMatch.reason).toContain('No exact weight 700 italic face registered for "Noto Sans CJK SC"');
      expect(noItalicMatch.reason).toContain('Synthetic bold/italic is not supported');
    }
  });
});
