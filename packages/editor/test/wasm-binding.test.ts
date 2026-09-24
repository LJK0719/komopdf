import { describe, expect, it } from 'vitest';
import type { EngineAdapter } from '@pdf-editor/contracts';
import {
  createPdfCoreBinding,
  type PdfCoreEmscriptenModule,
} from '../src/worker/wasm-c-api-binding.js';

type FakeDocument = {
  documentId: string;
  sourceId: string;
  bytes: Uint8Array;
  revision: number;
  text: string;
  undoText: string | null;
  redoText: string | null;
};
type PackedEdit = {
  pageIndex: number;
  blockId: string;
  startUtf16: number;
  endUtf16: number;
  replacement: string;
  fontId: string | null;
};

class FakePdfCoreModule implements PdfCoreEmscriptenModule {
  HEAPU8 = new Uint8Array(new ArrayBuffer(256));
  PDE_CORE_BUILD_ID: string | undefined = 'pdfium-test-build';
  abiVersion = 1;
  textEditStride = 24;
  initialized = false;
  opened: { bytes: Uint8Array; documentId: string; sourceId: string; password: string | null }[] = [];
  extractedPageIndices: number[] = [];
  registeredFonts: { id: string; bytes: Uint8Array }[] = [];
  lastPackedEdits: PackedEdit[] = [];
  lastTransactionId = '';
  lastRender: number[] = [];
  binaryPointer = 0;
  private binarySize = 0;
  private nextPointer = 32;
  private nextHandle = 1;
  private readonly documents = new Map<number, FakeDocument>();
  private errorCode = '';
  private errorMessage = '';

  _malloc(size: number): number {
    if (this.nextPointer + size > this.HEAPU8.byteLength) {
      const grown = new Uint8Array(new ArrayBuffer(Math.max(this.HEAPU8.byteLength * 2, this.nextPointer + size + 64)));
      grown.set(this.HEAPU8);
      this.HEAPU8 = grown;
    }
    const pointer = this.nextPointer;
    this.nextPointer += Math.max(size, 1);
    return pointer;
  }

  _free(_pointer: number): void {}
  _pde_abi_version(): number { return this.abiVersion; }
  _pde_initialize(): number { this.initialized = true; return 1; }
  _pde_shutdown(): void { this.initialized = false; }

  _pde_open_memory(bytes: number, length: number, documentId: number, sourceId: number, password: number): number {
    const input = this.HEAPU8.slice(bytes, bytes + length);
    if (input[0] === 0xee) {
      this.setError('PASSWORD_REQUIRED', 'A password is required');
      return 0;
    }
    const handle = this.nextHandle++;
    const document: FakeDocument = {
      bytes: input,
      documentId: this.string(documentId),
      sourceId: this.string(sourceId),
      revision: 0,
      text: 'Original text',
      undoText: null,
      redoText: null,
    };
    this.opened.push({
      bytes: document.bytes,
      documentId: document.documentId,
      sourceId: document.sourceId,
      password: password === 0 ? null : this.string(password),
    });
    this.documents.set(handle, document);
    return handle;
  }

  _pde_open_file_utf8(): number { this.setError('INVALID_REQUEST', 'not available'); return 0; }
  _pde_close(document: number): number { return this.documents.delete(document) ? 1 : 0; }

  _pde_document_info(document: number): number {
    const current = this.documents.get(document);
    if (!current) return this.fail('DOCUMENT_NOT_FOUND', 'missing document');
    return this.json({
      id: current.documentId,
      revision: current.revision,
      savedRevision: 0,
      pageOrder: [`${current.documentId}-page-1`, `${current.documentId}-page-2`],
      sourceIds: [current.sourceId],
      permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false },
      capabilities: this.abiVersion === 2 ? ['text.replace'] : [],
    });
  }

  _pde_describe_page(document: number, pageIndex: number): number {
    const current = this.documents.get(document);
    if (!current) return this.fail('DOCUMENT_NOT_FOUND', 'missing document');
    const pageId = `${current.documentId}-page-${pageIndex + 1}`;
    const objectId = `${pageId}-object`;
    const textBlockId = `${pageId}-text`;
    return this.json({
      id: pageId,
      widthPt: 200,
      heightPt: 100,
      rotation: 90,
      objects: this.abiVersion === 2 ? [{
        id: objectId,
        pageId,
        type: 'text',
        bounds: { x: 5, y: 10, width: 80, height: 12 },
        transform: [1, 0, 0, 1, 0, 0],
        locator: { pageId, containerPath: [], objectIndex: 0 },
        textBlock: {
          id: textBlockId,
          pageId,
          sourceId: current.sourceId,
          sourceObjectIds: [objectId],
          runs: [{ text: current.text, style: {}, sourceObjectIds: [objectId] }],
          bounds: { x: 5, y: 10, width: 80, height: 12 },
          transform: [1, 0, 0, 1, 0, 0],
          editability: 'direct',
        },
      }] : [],
    });
  }

  _pde_extract_page(document: number, pageIndex: number): number {
    const current = this.documents.get(document);
    if (!current) return this.fail('DOCUMENT_NOT_FOUND', 'missing document');
    this.extractedPageIndices.push(pageIndex);
    const pageId = `${current.documentId}-page-${pageIndex + 1}`;
    return this.json([{
      id: `${pageId}-text`, pageId, sourceId: current.sourceId, sourceObjectIds: ['object-1'],
      runs: [], bounds: { x: 0, y: 0, width: 10, height: 10 }, transform: [1, 0, 0, 1, 0, 0],
      editability: 'geometry-only',
    }]);
  }

  _pde_render(
    document: number,
    _pageIndex: number,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
    fullWidth: number,
    fullHeight: number,
  ): number {
    const current = this.documents.get(document);
    if (!current) return this.fail('DOCUMENT_NOT_FOUND', 'missing document');
    this.lastRender = [width, height, offsetX, offsetY, fullWidth, fullHeight];
    const stride = width * 4;
    this.setBinary(Uint8Array.from({ length: stride * height }, (_, index) => index % 251));
    return this.json({ width, height, stride, format: 'rgba', revision: current.revision });
  }

  _pde_save_memory(document: number): number {
    const current = this.documents.get(document);
    if (!current) return this.fail('DOCUMENT_NOT_FOUND', 'missing document');
    this.setBinary(current.bytes);
    return this.json({ docId: current.documentId, savedRevision: current.revision });
  }

  _pde_save_file_utf8(): number { this.setError('UNSUPPORTED_CAPABILITY', 'not available'); return 0; }
  _pde_text_edit_stride(): number { return this.textEditStride; }

  _pde_describe_annotations(document: number, pageIndex: number): number {
    const current = this.documents.get(document);
    if (!current) return this.fail('DOCUMENT_NOT_FOUND', 'missing document');
    const pageId = `${current.documentId}-page-${pageIndex + 1}`;
    const targetPageId = `${current.documentId}-page-2`;
    return this.json([
      {
        id: `link-annot-${pageIndex}`,
        pageId,
        subtype: 'link',
        bounds: { x: 10, y: 20, width: 80, height: 30 },
        text: '',
        color: [0, 0, 0],
        opacity: 1,
        targetPageId,
        targetTopPt: 150,
      },
    ]);
  }

  _pde_register_truetype_font(fontId: number, bytes: number, length: number): number {
    this.registeredFonts.push({ id: this.string(fontId), bytes: this.HEAPU8.slice(bytes, bytes + length) });
    return 1;
  }

  _pde_preview_text(document: number, edit: number): number {
    if (!this.documents.has(document)) return this.fail('DOCUMENT_NOT_FOUND', 'missing document');
    const packed = this.readPackedEdit(edit);
    this.lastPackedEdits = [packed];
    return this.json({
      bounds: { x: 5, y: 10, width: 80, height: 12 },
      overflow: packed.replacement.length > 20,
      lines: [{ bounds: { x: 5, y: 10, width: 80, height: 12 }, range: [0, packed.replacement.length] }],
      ...(packed.fontId ? { replacementFontId: packed.fontId } : {}),
    });
  }

  _pde_apply_text(document: number, baseRevision: number, transactionId: number, edits: number, count: number): number {
    const current = this.documents.get(document);
    if (!current) return this.fail('DOCUMENT_NOT_FOUND', 'missing document');
    if (baseRevision !== current.revision) return this.fail('STALE_REVISION', 'stale revision');
    this.lastTransactionId = this.string(transactionId);
    this.lastPackedEdits = Array.from({ length: count }, (_, index) => this.readPackedEdit(edits + index * 24));
    current.undoText = current.text;
    current.redoText = null;
    current.text = this.lastPackedEdits.at(-1)?.replacement ?? current.text;
    current.revision += 1;
    return this.commit(current, true, false);
  }

  _pde_undo(document: number): number {
    const current = this.documents.get(document);
    if (!current) return this.fail('DOCUMENT_NOT_FOUND', 'missing document');
    if (current.undoText === null) return this.fail('INVALID_REQUEST', 'nothing to undo');
    current.redoText = current.text;
    current.text = current.undoText;
    current.undoText = null;
    current.revision += 1;
    return this.commit(current, false, true);
  }

  _pde_redo(document: number): number {
    const current = this.documents.get(document);
    if (!current) return this.fail('DOCUMENT_NOT_FOUND', 'missing document');
    if (current.redoText === null) return this.fail('INVALID_REQUEST', 'nothing to redo');
    current.undoText = current.text;
    current.text = current.redoText;
    current.redoText = null;
    current.revision += 1;
    return this.commit(current, true, false);
  }

  _pde_binary_data(): number { return this.binaryPointer; }
  _pde_binary_size(): number { return this.binarySize; }
  _pde_error_code(): number { return this.errorCode ? this.output(this.errorCode) : 0; }
  _pde_error_message(): number { return this.errorMessage ? this.output(this.errorMessage) : 0; }

  private commit(document: FakeDocument, canUndo: boolean, canRedo: boolean): number {
    return this.json({
      docId: document.documentId,
      revision: document.revision,
      changedPageIds: [`${document.documentId}-page-1`],
      pageOrder: [`${document.documentId}-page-1`, `${document.documentId}-page-2`],
      canUndo,
      canRedo,
    });
  }

  private readPackedEdit(pointer: number): PackedEdit {
    const view = new DataView(this.HEAPU8.buffer);
    const blockIdPointer = view.getUint32(pointer + 4, true);
    const replacementPointer = view.getUint32(pointer + 16, true);
    const fontIdPointer = view.getUint32(pointer + 20, true);
    return {
      pageIndex: view.getUint32(pointer, true),
      blockId: this.string(blockIdPointer),
      startUtf16: view.getUint32(pointer + 8, true),
      endUtf16: view.getUint32(pointer + 12, true),
      replacement: this.string(replacementPointer),
      fontId: fontIdPointer === 0 ? null : this.string(fontIdPointer),
    };
  }

  private json(value: unknown): number { return this.output(JSON.stringify(value)); }

  private output(value: string): number {
    const bytes = new TextEncoder().encode(value);
    const pointer = this._malloc(bytes.byteLength + 1);
    this.HEAPU8.set(bytes, pointer);
    this.HEAPU8[pointer + bytes.byteLength] = 0;
    return pointer;
  }

  private string(pointer: number): string {
    let end = pointer;
    while (this.HEAPU8[end] !== 0) end += 1;
    return new TextDecoder().decode(this.HEAPU8.subarray(pointer, end));
  }

  private setBinary(value: Uint8Array): void {
    this.binaryPointer = this._malloc(value.byteLength);
    this.binarySize = value.byteLength;
    this.HEAPU8.set(value, this.binaryPointer);
  }

  private fail(code: string, message: string): number { this.setError(code, message); return 0; }
  private setError(code: string, message: string): void { this.errorCode = code; this.errorMessage = message; }
}

describe('WASM C ABI binding', () => {
  it('maps real ABI 1 JSON, page indices, normalized render viewport and copied binary', async () => {
    const module = new FakePdfCoreModule();
    const binding = createPdfCoreBinding(module);
    expect(binding.handshake).toEqual({ protocolVersion: 1, coreBuildId: 'pdfium-test-build', capabilities: [] });
    expect(module.initialized).toBe(true);

    const input = Uint8Array.from({ length: 400 }, (_, index) => index % 255);
    const info = await binding.engine.open({
      kind: 'bytes', sourceId: 'source-a', name: 'a.pdf', bytes: input.buffer,
    });
    const second = await binding.engine.open({
      kind: 'bytes', sourceId: 'source-b', name: 'b.pdf', bytes: Uint8Array.of(1, 2).buffer,
    });
    expect(info.id).not.toBe(second.id);
    expect(module.opened[0]?.sourceId).toBe('source-a');
    expect(module.opened[0]?.bytes).toEqual(input);

    const pageId = info.pageOrder[0]!;
    const page = await binding.engine.describePage(info.id, pageId);
    expect(page.rotation).toBe(90);
    const rendered = await binding.engine.render({
      docId: info.id,
      pageId,
      scale: 2,
      clip: { x: 10, y: 5, width: 20, height: 10 },
    });
    expect(module.lastRender).toEqual([40, 20, -20, -10, 400, 200]);
    expect(rendered.width).toBe(40);
    expect(rendered.height).toBe(20);
    expect(rendered.pixels).not.toBe(module.HEAPU8.buffer);
    const firstPixel = new Uint8Array(rendered.pixels)[0];
    module.HEAPU8[module.binaryPointer] = 255;
    expect(new Uint8Array(rendered.pixels)[0]).toBe(firstPixel);

    const blocks = await binding.engine.extract({ docId: info.id, pageIds: info.pageOrder });
    expect(module.extractedPageIndices).toEqual([0, 1]);
    expect(blocks.map((block) => block.pageId)).toEqual(info.pageOrder);

    const saved = await binding.engine.save({ docId: info.id, protection: 'preserve' });
    expect(saved.kind).toBe('bytes');
    if (saved.kind === 'bytes') expect(new Uint8Array(saved.bytes)).toEqual(input);
  });

  it('keeps ABI 1 read-only even when optional ABI 2 methods exist on the runtime object', async () => {
    const engine: EngineAdapter = createPdfCoreBinding(new FakePdfCoreModule()).engine;
    await expect(engine.open({ kind: 'native-file', sourceId: 's', name: 'a.pdf', handle: 'opaque' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(engine.previewText({
      docId: 'd', pageId: 'p', blockId: 'b', range: [0, 0], text: 'x',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(engine.undo('d')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(engine.redo('d')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(engine.apply({ id: 't', docId: 'd', baseRevision: 0, source: 'manual', commands: [] }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(engine.save({ docId: 'd', protection: 'set' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('packs ABI 2 text edits, verifies and registers a selected font, then updates revision through history', async () => {
    const module = new FakePdfCoreModule();
    module.abiVersion = 2;
    const fontBytes = embeddableTrueTypeFont();
    const fontHash = await sha256Hex(fontBytes.buffer);
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/font-resources.json')) {
        return new Response(JSON.stringify([{
          id: 'lxgw-wenkai-regular',
          family: 'LXGW WenKai',
          style: 'Regular',
          format: 'ttf',
          url: '/fonts/LXGWWenKai-Regular.test.ttf',
          sha256: fontHash,
        }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(fontBytes, { status: 200 });
    };
    const binding = createPdfCoreBinding(module, {
      fontManifestUrl: 'https://editor.test/fonts/font-resources.json',
      fetch: fetcher,
    });
    expect(binding.handshake.capabilities).toEqual(['text.replace']);

    const info = await binding.engine.open({
      kind: 'bytes', sourceId: 'source', name: 'editable.pdf', bytes: Uint8Array.of(1, 2, 3).buffer,
    });
    const pageId = info.pageOrder[0]!;
    const page = await binding.engine.describePage(info.id, pageId);
    const block = page.objects[0]?.textBlock;
    expect(block).toBeDefined();
    const originalText = block!.runs.map((run) => run.text).join('');
    const preview = await binding.engine.previewText({
      docId: info.id,
      pageId,
      blockId: block!.id,
      range: [0, originalText.length],
      text: 'Replacement',
      style: { fontId: 'lxgw-wenkai-regular' },
    });
    expect(preview).toMatchObject({ overflow: false, replacementFontId: 'lxgw-wenkai-regular' });
    expect(module.registeredFonts).toEqual([{ id: 'lxgw-wenkai-regular', bytes: fontBytes }]);
    expect(module.lastPackedEdits).toEqual([{
      pageIndex: 0,
      blockId: block!.id,
      startUtf16: 0,
      endUtf16: originalText.length,
      replacement: 'Replacement',
      fontId: 'lxgw-wenkai-regular',
    }]);

    const committed = await binding.engine.apply({
      id: 'transaction-1',
      docId: info.id,
      baseRevision: 0,
      source: 'manual',
      commands: [{
        type: 'text.replace',
        pageId,
        blockId: block!.id,
        range: [0, originalText.length],
        text: 'Replacement',
        style: { fontId: 'lxgw-wenkai-regular' },
      }],
    });
    expect(committed).toMatchObject({ revision: 1, canUndo: true, canRedo: false });
    expect(module.lastTransactionId).toBe('transaction-1');
    expect(module.registeredFonts).toHaveLength(1);
    const refreshed = await binding.engine.describePage(info.id, pageId);
    expect(refreshed.objects[0]?.textBlock?.runs[0]?.text).toBe('Replacement');

    await expect(binding.engine.undo(info.id)).resolves.toMatchObject({ revision: 2, canUndo: false, canRedo: true });
    await expect(binding.engine.redo(info.id)).resolves.toMatchObject({ revision: 3, canUndo: true, canRedo: false });
  });

  it.each([{ format: 'otf', faceIndex: 0 }, { format: 'ttf', faceIndex: 1 }])(
    'passes $format face $faceIndex to generic core registration', async ({ format, faceIndex }) => {
      const calls: { bytes: Uint8Array; faceIndex: number }[] = [];
      const module = Object.assign(new FakePdfCoreModule(), {
        _pde_register_font(_id: number, bytes: number, length: number, index: number): number {
          calls.push({ bytes: module.HEAPU8.slice(bytes, bytes + length), faceIndex: index });
          const json = new TextEncoder().encode(JSON.stringify({ id: 'font-face', faceIndex: index, format, editableEmbedding: true }) + '\0');
          const pointer = module._malloc(json.length);
          module.HEAPU8.set(json, pointer);
          return pointer;
        },
      });
      module.abiVersion = 2;
      // Only test the binding here; real CFF/TTC parsing belongs to native tests.
      const bytes = Uint8Array.of(1, 2, 3);
      const manifest = [{ id: 'font-face', family: 'Test', style: 'Regular', format, faceIndex,
        url: '/fonts/face.bin', sha256: await sha256Hex(bytes.buffer) }];
      const engine = createPdfCoreBinding(module, {
        fontManifestUrl: 'https://editor.test/fonts/font-resources.json',
        fetch: async input => String(input).endsWith('.json')
          ? new Response(JSON.stringify(manifest)) : new Response(bytes),
      }).engine;
      const info = await engine.open({ kind: 'bytes', sourceId: 'source', name: 'font.pdf', bytes: Uint8Array.of(1).buffer });
      const pageId = info.pageOrder[0]!;
      const block = (await engine.describePage(info.id, pageId)).objects[0]!.textBlock!;
      await engine.previewText({ docId: info.id, pageId, blockId: block.id, range: [0, 'Original text'.length],
        text: 'Replacement', style: { fontId: 'font-face' } });
      expect(calls).toEqual([{ bytes, faceIndex }]);
      expect(module.registeredFonts).toEqual([]);
    },
  );

  it('rejects partial ABI 2 exports, wrong stride, partial ranges and unsupported style fields', async () => {
    const missingExport = new FakePdfCoreModule();
    missingExport.abiVersion = 2;
    Object.defineProperty(missingExport, '_pde_redo', { value: undefined });
    expect(() => createPdfCoreBinding(missingExport)).toThrow(/missing required editing exports/);

    const wrongStride = new FakePdfCoreModule();
    wrongStride.abiVersion = 2;
    wrongStride.textEditStride = 20;
    expect(() => createPdfCoreBinding(wrongStride)).toThrow(/stride 20/);

    const module = new FakePdfCoreModule();
    module.abiVersion = 2;
    const engine = createPdfCoreBinding(module).engine;
    const info = await engine.open({
      kind: 'bytes', sourceId: 'source', name: 'editable.pdf', bytes: Uint8Array.of(1).buffer,
    });
    const pageId = info.pageOrder[0]!;
    const block = (await engine.describePage(info.id, pageId)).objects[0]!.textBlock!;
    await expect(engine.previewText({
      docId: info.id, pageId, blockId: block.id, range: [1, 4], text: 'x',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(engine.previewText({
      docId: info.id,
      pageId,
      blockId: block.id,
      range: [0, 'Original text'.length],
      text: 'x',
      style: { fontSize: 12 },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('validates ABI/build identity and maps pde_error fields to EngineError', async () => {
    const wrongAbi = new FakePdfCoreModule();
    wrongAbi.abiVersion = 4;
    expect(() => createPdfCoreBinding(wrongAbi)).toThrow(/Unsupported PDF core ABI 4/);

    const incompleteAbi3 = new FakePdfCoreModule();
    incompleteAbi3.abiVersion = 3;
    expect(() => createPdfCoreBinding(incompleteAbi3)).toThrow(/Incomplete or incompatible ABI 3 core/);

    const missingIdentity = new FakePdfCoreModule();
    missingIdentity.PDE_CORE_BUILD_ID = undefined;
    expect(() => createPdfCoreBinding(missingIdentity)).toThrow(/build identity/);

    const module = new FakePdfCoreModule();
    const engine = createPdfCoreBinding(module).engine;
    await expect(engine.open({
      kind: 'bytes', sourceId: 'source', name: 'locked.pdf', bytes: Uint8Array.of(0xee).buffer,
    })).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED', message: 'A password is required' });
  });

  it('describes link annotations with targetPageId and targetTopPt', async () => {
    const fake = new FakePdfCoreModule();
    const binding = createPdfCoreBinding(fake);
    const info = await binding.engine.open({
      kind: 'bytes', sourceId: 'src', name: 'test.pdf', bytes: Uint8Array.of(1, 2, 3).buffer,
    });
    const annots = await binding.engine.describeAnnotations!(info.id, info.pageOrder[0]!);
    expect(annots).toHaveLength(1);
    expect(annots[0]!.subtype).toBe('link');
    expect(annots[0]!.targetPageId).toBe(`${info.id}-page-2`);
    expect(annots[0]!.targetTopPt).toBe(150);
  });

  it('describes form fields with tooltip and maxLen attributes', async () => {
    const fake = new FakePdfCoreModule();
    const binding = createPdfCoreBinding(fake);
    const info = await binding.engine.open({
      kind: 'bytes', sourceId: 'src', name: 'form.pdf', bytes: Uint8Array.of(1, 2, 3).buffer,
    });
    fake._pde_describe_forms = () => fake['json']([
      {
        id: 'f1',
        name: 'Username',
        type: 'text',
        value: 'alice',
        readOnly: false,
        required: true,
        tooltip: 'Enter username',
        maxLen: 20,
        options: [],
        widgets: [{ pageId: `${info.id}-page-1`, bounds: { x: 10, y: 10, width: 100, height: 20 } }],
      },
    ]);
    const forms = await binding.engine.describeForms!(info.id);
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({
      id: 'f1',
      name: 'Username',
      type: 'text',
      tooltip: 'Enter username',
      maxLen: 20,
    });
  });
});

function embeddableTrueTypeFont(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(40));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, 1);
  view.setUint32(12, 0x4f532f32);
  view.setUint32(20, 28);
  view.setUint32(24, 12);
  view.setUint16(28, 4);
  view.setUint16(36, 0);
  return bytes;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
