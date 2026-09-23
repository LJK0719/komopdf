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

describe('Brand entrances', () => {
  it('declares komopdf as default productName in EditorShell', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    expect(source).toContain("productName = 'komopdf'");
    expect(source).toContain('<span className="brand-mark" aria-hidden="true">K</span>');
  });

  it('declares recovery banner and actions in EditorShell', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/EditorShell.tsx'), 'utf-8');
    expect(source).toContain('recovery-banner');
    expect(source).toContain('Recover Unsaved Document');
    expect(source).toContain('restorePendingRecovery');
    expect(source).toContain('discardPendingRecovery');
  });
});
