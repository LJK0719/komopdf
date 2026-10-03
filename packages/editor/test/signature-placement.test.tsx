import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentInfo, EngineAdapter, PageModel } from '@pdf-editor/contracts';
import { buildSignatureTransaction, SignaturePanel } from '../src/ui/SignaturePanel.js';
import { SignaturePlacementLayer } from '../src/ui/SignaturePlacementLayer.js';
import {
  initialSignaturePlacement, moveSignaturePlacement, resizeSignaturePlacement,
  signaturePagePoint, signaturePreviewPoints, type SignatureDraft,
} from '../src/ui/signature-placement.js';

const document: DocumentInfo = {
  id: 'doc-sign', revision: 2, savedRevision: 1, pageOrder: ['page-1', 'page-2'], sourceIds: [],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false },
  capabilities: ['annotation.add'],
};
const page: PageModel = { id: 'page-1', widthPt: 612, heightPt: 792, rotation: 0, objects: [] };
const draft: SignatureDraft = { strokes: [[[0, 0.2], [0.5, 1], [1, 0]], [[0.1, 0.2], [0.3, 0.1]]], strokeWidth: 2 };

describe('signature page placement', () => {
  it('maps pointer coordinates using the displayed page size, including zoom and scroll offsets', () => {
    expect(signaturePagePoint(659, 842, { left: 47, top: 50, width: 1224, height: 1584 }, page)).toEqual([306, 396]);
    expect(signaturePagePoint(-10, 9999, { left: 47, top: 50, width: 306, height: 396 }, page)).toEqual([0, 792]);
  });

  it('starts centered and fits tiny pages without requiring coordinate inputs', () => {
    expect(initialSignaturePlacement(page)).toEqual({ x: 216, y: 366, width: 180, height: 60 });
    const small = initialSignaturePlacement({ widthPt: 30, heightPt: 6 });
    expect(small.width / small.height).toBeCloseTo(3);
    expect(small.x).toBeGreaterThanOrEqual(0);
    expect(small.y).toBeGreaterThanOrEqual(0);
    expect(small.x + small.width).toBeLessThanOrEqual(30);
    expect(small.y + small.height).toBeLessThanOrEqual(6);
  });

  it('clamps dragging to the page and preserves the aspect ratio while resizing', () => {
    const initial = initialSignaturePlacement(page);
    expect(moveSignaturePlacement(initial, -100, 900, page)).toEqual({ ...initial, x: 0, y: 732 });
    const enlarged = resizeSignaturePlacement(initial, 10000, page);
    expect(enlarged).toEqual({ x: 216, y: 366, width: 396, height: 132 });
    const reduced = resizeSignaturePlacement(initial, -100, page);
    expect(reduced).toEqual({ x: 216, y: 366, width: 24, height: 8 });
    expect(initial).toEqual(initialSignaturePlacement(page));
  });

  it('limits resizing against the bottom edge as well as the right edge', () => {
    expect(resizeSignaturePlacement({ x: 10, y: 732, width: 90, height: 30 }, 600, page))
      .toEqual({ x: 10, y: 732, width: 180, height: 60 });
  });

  it('reuses the same strokes for independent real Ink transactions on later revisions and other pages', () => {
    const original = structuredClone(draft);
    const bounds = { x: 20, y: 40, width: 180, height: 60 };
    expect(signaturePreviewPoints(draft.strokes[0]!, bounds)).toBe('0,12 90,60 180,0');
    const first = buildSignatureTransaction(document, page, draft.strokes, bounds, draft.strokeWidth);
    const second = buildSignatureTransaction({ ...document, revision: 3 }, { ...page, id: 'page-2' }, draft.strokes, bounds, draft.strokeWidth);
    expect(first.commands[0]).toMatchObject({ type: 'annotation.add', subtype: 'ink', points: [[20, 52], [110, 100], [200, 40]] });
    expect(second).toMatchObject({ baseRevision: 3 });
    expect(second.commands[0]).toMatchObject({ pageId: 'page-2', subtype: 'ink' });
    expect(second.id).not.toBe(first.id);
    expect(second.commands[0]?.annotationId).not.toBe(first.commands[0]?.annotationId);
    expect(draft).toEqual(original);
  });
});

describe('signature controls', () => {
  it('renders the controlled reusable template on remount without manual X/Y inputs', () => {
    const props = { document, draft, disabled: false, onDraftChange: vi.fn(), onPlacementRequest: vi.fn() };
    const before = renderToStaticMarkup(<SignaturePanel {...props} />);
    const after = renderToStaticMarkup(<SignaturePanel {...props} document={{ ...document, revision: 3 }} />);
    expect(before).toBe(after);
    expect(after).toContain('Clear signature');
    expect(after).toContain('Place signature');
    expect(after).toContain('not a digital certificate signature');
    expect(after).toContain('<polyline');
    expect(after).not.toContain('type="number"');
    expect(props.onDraftChange).not.toHaveBeenCalled();
    expect(props.onPlacementRequest).not.toHaveBeenCalled();
  });

  it('shows an explicit active placement state and cancel action in the panel', () => {
    const markup = renderToStaticMarkup(<SignaturePanel document={document} draft={draft} disabled={false} placing
      onDraftChange={() => {}} onPlacementRequest={() => {}} />);
    expect(markup).toContain('Signature preview active');
    expect(markup).toContain('Cancel placement');
  });

  it('renders the page preview and confirm/cancel/resize controls without creating any transaction', () => {
    const engine = { previewTransaction: vi.fn(), apply: vi.fn() } as unknown as EngineAdapter;
    const markup = renderToStaticMarkup(<SignaturePlacementLayer document={document} page={page} draft={draft}
      disabled={false} engine={engine} onBusyChange={() => {}} onCommitted={async () => {}} onCancel={() => {}} />);
    expect(markup).toContain('Signature placement preview');
    expect(markup).toContain('Confirm signature');
    expect(markup).toContain('Cancel');
    expect(markup).toContain('Resize signature');
    expect(markup).toContain('Make signature smaller');
    expect(markup).toContain('Make signature larger');
    expect(engine.previewTransaction).not.toHaveBeenCalled();
    expect(engine.apply).not.toHaveBeenCalled();
  });
});
