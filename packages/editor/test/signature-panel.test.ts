import { describe, expect, it, vi } from 'vitest';
import type { CommitResult, DocumentInfo, EditTransaction, EngineAdapter, PageModel } from '@pdf-editor/contracts';
import { buildSignatureTransaction, commitSignature } from '../src/ui/SignaturePanel.js';

const document: DocumentInfo = {
  id: 'doc-1', revision: 4, savedRevision: 3, pageOrder: ['page-1'], sourceIds: [],
  permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false },
  capabilities: ['annotation.add'],
};
const page: PageModel = { id: 'page-1', widthPt: 612, heightPt: 792, rotation: 0, objects: [] };
const placement = { x: 50, y: 100, width: 200, height: 80 };
const strokes = [
  [[0, 0], [0.5, 0.5], [1, 1]],
  [[0.25, 0.75], [0.75, 0.25]],
] as [number, number][][];
const result: CommitResult = { docId: 'doc-1', revision: 5, changedPageIds: ['page-1'],
  pageOrder: ['page-1'], canUndo: true, canRedo: false };

describe('handwritten signature ink', () => {
  it('maps each separate drawing stroke to real page coordinates and one transaction', () => {
    const tx = buildSignatureTransaction(document, page, strokes, placement, 2);
    expect(tx).toMatchObject({ docId: 'doc-1', baseRevision: 4, source: 'manual' });
    expect(tx.commands).toHaveLength(2);
    expect(tx.commands[0]).toMatchObject({ type: 'annotation.add', pageId: 'page-1', subtype: 'ink',
      bounds: { x: 49, y: 99, width: 202, height: 82 },
      points: [[50, 100], [150, 140], [250, 180]], strokeWidth: 2 });
    expect(tx.commands[1]).toMatchObject({ type: 'annotation.add', subtype: 'ink',
      points: [[100, 160], [200, 120]] });
    expect(tx.commands[0]?.annotationId).not.toBe(tx.commands[1]?.annotationId);
  });

  it('previews and applies all strokes once through the registry, then reports the commit', async () => {
    const calls: string[] = [];
    const engine = {
      previewTransaction: vi.fn(async (_tx: EditTransaction) => { calls.push('preview'); return {
        docId: 'doc-1', baseRevision: 4, pageOrder: ['page-1'], changedPageIds: ['page-1'],
      }; }),
      apply: vi.fn(async (_tx: EditTransaction) => { calls.push('apply'); return result; }),
    } as unknown as EngineAdapter;
    const onCommitted = vi.fn(async (_result: CommitResult) => { calls.push('committed'); });

    await commitSignature(engine, document, page, strokes, placement, 2, () => true, onCommitted);

    expect(calls).toEqual(['preview', 'apply', 'committed']);
    expect(engine.previewTransaction).toHaveBeenCalledOnce();
    expect(engine.apply).toHaveBeenCalledOnce();
    expect(engine.apply).toHaveBeenCalledWith(engine.previewTransaction.mock.calls[0]![0]);
    expect(engine.apply.mock.calls[0]![0].commands).toHaveLength(2);
    expect(onCommitted).toHaveBeenCalledWith(result);
  });

  it('rejects edits if the document changes during preview or annotations are forbidden', async () => {
    let current = true;
    let invalidateDuringPreview = true;
    const engine = {
      previewTransaction: vi.fn(async () => { if (invalidateDuringPreview) current = false; return {
        docId: 'doc-1', baseRevision: 4, pageOrder: ['page-1'], changedPageIds: ['page-1'],
      }; }),
      apply: vi.fn(async () => result),
    } as unknown as EngineAdapter;
    await expect(commitSignature(engine, document, page, strokes, placement, 2, () => current, async () => {}))
      .rejects.toThrow('document changed');
    expect(engine.apply).not.toHaveBeenCalled();

    current = true;
    invalidateDuringPreview = false;
    const forbidden = { ...document, permissions: { ...document.permissions, annotate: false } };
    await expect(commitSignature(engine, forbidden, page, strokes, placement, 2, () => current, async () => {}))
      .rejects.toThrow('not permitted');
    expect(engine.apply).not.toHaveBeenCalled();
  });
});
