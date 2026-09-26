import { describe, expect, it } from 'vitest';
import type { TextBlock } from '@pdf-editor/contracts';
import {
  getFontWeight,
  getFontItalic,
  isFontEmbeddable,
  getAvailableFontFamilies,
  getAvailableWeightsForFamily,
  familySupportsItalic,
  resolveExactFontFace,
  findSelectionFontInfo,
  STANDARD_WEIGHT_OPTIONS,
  type EditorFont,
} from '../src/ui/font-resources.js';
import { packCommands, EDIT_COMMAND_STRIDE } from '../src/worker/abi3-commands.js';
import { resolveFormattingFont } from '../src/ui/font-face-matcher.js';

const mockFonts: EditorFont[] = [
  { id: 'noto-sans-cjk-sc-regular', family: 'Noto Sans CJK SC', style: 'Regular', weight: 400, italic: false, format: 'otf' },
  { id: 'noto-sans-cjk-sc-bold', family: 'Noto Sans CJK SC', style: 'Bold', weight: 700, italic: false, format: 'otf' },
  { id: 'lxgw-wenkai-regular', family: 'LXGW WenKai', style: 'Regular', weight: 400, italic: false, format: 'ttf' },
  { id: 'lxgw-wenkai-medium', family: 'LXGW WenKai', style: 'Medium', weight: 500, italic: false, format: 'ttf' },
  { id: 'liberation-sans-regular', family: 'Liberation Sans', style: 'Regular', weight: 400, italic: false, format: 'ttf' },
  { id: 'liberation-sans-bold', family: 'Liberation Sans', style: 'Bold', weight: 700, italic: false, format: 'ttf' },
  { id: 'liberation-sans-italic', family: 'Liberation Sans', style: 'Italic', weight: 400, italic: true, format: 'ttf' },
  { id: 'liberation-sans-bold-italic', family: 'Liberation Sans', style: 'Bold Italic', weight: 700, italic: true, format: 'ttf' },
  { id: 'restricted-font-bold', family: 'Restricted Font', style: 'Bold', weight: 700, italic: false, format: 'ttf', editableEmbedding: false },
];

class MockAllocator {
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

describe('font-face-matcher and font-resources', () => {
  it('keeps the requested family instead of switching to another family just for an exact medium weight', () => {
    expect(resolveFormattingFont(mockFonts, { family: 'Liberation Sans', weight: 500, italic: false, text: 'Sample' }).id)
      .toBe('liberation-sans-regular');
  });

  it('recognizes original PDF font names without requiring registration first', () => {
    const block: TextBlock = { id: 'block', pageId: 'page', sourceObjectIds: ['object'], bounds: { x: 0, y: 0, width: 100, height: 20 },
      transform: [1, 0, 0, 1, 0, 0], editability: 'direct',
      runs: [{ text: 'Sample', style: { fontId: 'pdf:ABCDEF+Arial-BoldMT', weight: 700 }, sourceObjectIds: ['object'] }] };
    expect(findSelectionFontInfo(block, [0, 6], mockFonts)).toMatchObject({ family: 'Arial', weight: 700, italic: false });
    expect(resolveFormattingFont(mockFonts, { family: 'Arial', weight: 700, italic: true, text: 'Sample' }).id)
      .toBe('liberation-sans-bold-italic');
  });
  it('extracts weight and italic correctly from explicit metadata and style names', () => {
    expect(getFontWeight(mockFonts[0]!)).toBe(400);
    expect(getFontWeight(mockFonts[1]!)).toBe(700);
    expect(getFontWeight(mockFonts[3]!)).toBe(500);

    // Fallback when weight/italic are omitted
    expect(getFontWeight({ id: 'f1', family: 'F', style: 'Black', format: 'ttf' })).toBe(900);
    expect(getFontWeight({ id: 'f2', family: 'F', style: 'Extra Bold', format: 'ttf' })).toBe(800);
    expect(getFontWeight({ id: 'f3', family: 'F', style: 'SemiBold', format: 'ttf' })).toBe(600);
    expect(getFontWeight({ id: 'f4', family: 'F', style: 'Light', format: 'ttf' })).toBe(300);
    expect(getFontWeight({ id: 'f5', family: 'F', style: 'Thin', format: 'ttf' })).toBe(100);
    expect(getFontWeight({ id: 'f5b', family: 'F', style: 'Extra Light', format: 'ttf' })).toBe(200);
    expect(getFontWeight({ id: 'f6', family: 'F', style: 'CustomStyle', format: 'ttf' })).toBe(400);

    expect(getFontItalic(mockFonts[0]!)).toBe(false);
    expect(getFontItalic(mockFonts[6]!)).toBe(true);
    expect(getFontItalic({ id: 'f7', family: 'F', style: 'Oblique', format: 'ttf' })).toBe(true);
    expect(getFontItalic({ id: 'f8', family: 'F', style: 'Regular', format: 'ttf' })).toBe(false);
  });

  it('determines editable embedding permission from font flags', () => {
    expect(isFontEmbeddable(mockFonts[0]!)).toBe(true);
    expect(isFontEmbeddable(mockFonts[8]!)).toBe(false);
  });

  it('extracts unique font families and available weights', () => {
    const families = getAvailableFontFamilies(mockFonts);
    expect(families).toEqual(['Noto Sans CJK SC', 'LXGW WenKai', 'Liberation Sans', 'Restricted Font']);

    expect(getAvailableWeightsForFamily(mockFonts, 'Noto Sans CJK SC')).toEqual([400, 700]);
    expect(getAvailableWeightsForFamily(mockFonts, 'LXGW WenKai')).toEqual([400, 500]);
    expect(getAvailableWeightsForFamily(mockFonts, 'Liberation Sans')).toEqual([400, 700]);
    expect(getAvailableWeightsForFamily(mockFonts, 'Liberation Sans', true)).toEqual([400, 700]);
    expect(getAvailableWeightsForFamily(mockFonts, 'Noto Sans CJK SC', true)).toEqual([]);
  });

  it('checks if a font family has real italic faces', () => {
    expect(familySupportsItalic(mockFonts, 'Liberation Sans')).toBe(true);
    expect(familySupportsItalic(mockFonts, 'Liberation Sans', 700)).toBe(true);
    expect(familySupportsItalic(mockFonts, 'Noto Sans CJK SC')).toBe(false);
    expect(familySupportsItalic(mockFonts, 'LXGW WenKai')).toBe(false);
  });

  it('resolves exact font face when target family, weight, and italic match a registered face', () => {
    const r1 = resolveExactFontFace(mockFonts, { family: 'Liberation Sans', weight: 400, italic: false });
    expect(r1).toEqual({ success: true, font: mockFonts[4] });

    const r2 = resolveExactFontFace(mockFonts, { family: 'Liberation Sans', weight: 700, italic: false });
    expect(r2).toEqual({ success: true, font: mockFonts[5] });

    const r3 = resolveExactFontFace(mockFonts, { family: 'Liberation Sans', weight: 400, italic: true });
    expect(r3).toEqual({ success: true, font: mockFonts[6] });

    const r4 = resolveExactFontFace(mockFonts, { family: 'Liberation Sans', weight: 700, italic: true });
    expect(r4).toEqual({ success: true, font: mockFonts[7] });

    const r5 = resolveExactFontFace(mockFonts, { family: 'LXGW WenKai', weight: 500, italic: false });
    expect(r5).toEqual({ success: true, font: mockFonts[3] });
  });

  it('clearly rejects when family is not registered', () => {
    const result = resolveExactFontFace(mockFonts, { family: 'Arial', weight: 400, italic: false });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain('Font family "Arial" is not registered');
    }
  });

  it('clearly rejects without synthesis when no exact weight or italic face exists', () => {
    // Noto Sans CJK SC has no italic face
    const result1 = resolveExactFontFace(mockFonts, { family: 'Noto Sans CJK SC', weight: 400, italic: true });
    expect(result1.success).toBe(false);
    if (!result1.success) {
      expect(result1.reason).toContain('No exact weight 400 italic face registered for "Noto Sans CJK SC"');
    }

    // Liberation Sans has no 300 Light face
    const result2 = resolveExactFontFace(mockFonts, { family: 'Liberation Sans', weight: 300, italic: false });
    expect(result2.success).toBe(false);
    if (!result2.success) {
      expect(result2.reason).toContain('No exact weight 300 normal face registered for "Liberation Sans"');
    }
  });

  it('keeps embedding flags as metadata rather than blocking font selection', () => {
    const result = resolveExactFontFace(mockFonts, { family: 'Restricted Font', weight: 700, italic: false });
    expect(result).toEqual({ success: true, font: mockFonts[8] });
  });

  it('introspects font info from a selected text range with registered runs', () => {
    const block: TextBlock = {
      id: 'block-1',
      pageId: 'page-1',
      bounds: { x: 0, y: 0, width: 100, height: 20 },
      transform: [1, 0, 0, 1, 0, 0],
      editability: 'direct',
      sourceObjectIds: ['obj-1'],
      runs: [
        { text: 'Hello ', style: { fontId: 'liberation-sans-regular' }, sourceObjectIds: ['obj-1'] },
        { text: 'World', style: { fontId: 'liberation-sans-bold' }, sourceObjectIds: ['obj-1'] },
      ],
    };

    // Range in first run ('Hello')
    const sel1 = findSelectionFontInfo(block, [0, 5], mockFonts);
    expect(sel1).toEqual({ family: 'Liberation Sans', weight: 400, italic: false, fontId: 'liberation-sans-regular' });

    // Range in second run ('World')
    const sel2 = findSelectionFontInfo(block, [6, 11], mockFonts);
    expect(sel2).toEqual({ family: 'Liberation Sans', weight: 700, italic: false, fontId: 'liberation-sans-bold' });
    expect(findSelectionFontInfo(block, [0, 11], mockFonts)).toBeNull();

    // Range spanning an unregistered font
    const blockUnregistered: TextBlock = {
      ...block,
      runs: [{ text: 'Unknown', style: { fontId: 'F1' }, sourceObjectIds: ['obj-1'] }],
    };
    expect(findSelectionFontInfo(blockUnregistered, [0, 7], mockFonts)).toBeNull();

    // Range spanning mixed font families
    const blockMixed: TextBlock = {
      ...block,
      runs: [
        { text: 'Part1', style: { fontId: 'liberation-sans-regular' }, sourceObjectIds: ['obj-1'] },
        { text: 'Part2', style: { fontId: 'noto-sans-cjk-sc-regular' }, sourceObjectIds: ['obj-1'] },
      ],
    };
    expect(findSelectionFontInfo(blockMixed, [0, 10], mockFonts)).toBeNull();
  });

  it('ensures resolved face ID written to text.style / text.reflow / text.insert packs cleanly in ABI3 without rejection', () => {
    const match = resolveExactFontFace(mockFonts, { family: 'Liberation Sans', weight: 700, italic: true });
    expect(match.success).toBe(true);
    if (!match.success) return;

    const matchedFaceId = match.font.id; // 'liberation-sans-bold-italic'
    const allocator = new MockAllocator();

    // 1. text.style using matched face ID (DO NOT include weight/italic metadata in style)
    const styleCommand = {
      type: 'text.style' as const,
      pageId: 'page-1',
      blockIds: ['block-1'],
      style: { fontId: matchedFaceId, fontSize: 14 },
    };
    const stylePtr = packCommands(allocator, [styleCommand]);
    expect(stylePtr).toBeGreaterThan(0);
    const styleBytes = allocator.buffers.get(stylePtr);
    expect(styleBytes?.byteLength).toBe(EDIT_COMMAND_STRIDE);

    // 2. text.reflow using matched face ID
    const reflowCommand = {
      type: 'text.reflow' as const,
      pageId: 'page-1',
      objectId: 'obj-reflow',
      blockIds: ['block-1'],
      bounds: { x: 10, y: 10, width: 200, height: 100 },
      text: 'Reflowed paragraph content',
      style: { fontId: matchedFaceId, fontSize: 16, lineHeight: 1.3, alignment: 'left' as const },
    };
    const reflowPtr = packCommands(allocator, [reflowCommand]);
    expect(reflowPtr).toBeGreaterThan(0);

    // 3. text.insert using matched face ID
    const insertCommand = {
      type: 'text.insert' as const,
      pageId: 'page-1',
      objectId: 'obj-insert',
      bounds: { x: 20, y: 20, width: 250, height: 120 },
      text: 'Inserted paragraph text',
      paragraph: true,
      style: { fontId: matchedFaceId, fontSize: 18, lineHeight: 1.2, alignment: 'center' as const },
    };
    const insertPtr = packCommands(allocator, [insertCommand]);
    expect(insertPtr).toBeGreaterThan(0);

    // 4. Verify that if someone inadvertently sent weight/italic metadata to ABI3, it WOULD throw UNSUPPORTED_CAPABILITY
    expect(() => {
      packCommands(allocator, [{
        type: 'text.style',
        pageId: 'page-1',
        blockIds: ['block-1'],
        // @ts-expect-error Testing runtime ABI rejection on illegal style metadata
        style: { fontId: matchedFaceId, weight: 700, italic: true },
      }]);
    }).toThrow('This core does not yet support the requested text style');
  });

  it('exposes standard weight options with numeric values and human labels', () => {
    expect(STANDARD_WEIGHT_OPTIONS.map(o => o.value)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(STANDARD_WEIGHT_OPTIONS.find(o => o.value === 400)?.label).toBe('Regular (400)');
    expect(STANDARD_WEIGHT_OPTIONS.find(o => o.value === 700)?.label).toBe('Bold (700)');
  });
});
