import {
  EngineError,
  WORKER_PROTOCOL_VERSION,
  type CommitResult,
  type DocumentInfo,
  type DocumentSource,
  type EditTransaction,
  type EngineAdapter,
  type EngineErrorCode,
  type ExtractionRequest,
  type ExtractPagesRequest, type ExtractPagesResult,
  type PageModel,
  type RenderRequest,
  type RenderResult,
  type SaveRequest,
  type SaveResult,
  type TextBlock,
  type TextLayoutRequest,
  type TextLayoutResult, type TextInsertLayoutRequest,
  type TextStyle, type CommandType,
  type RegisterResourceRequest, type ResourceInfo, type TransactionPreviewResult, type SaveConfirmation,
  type FontSource, type FontFaceInfo, type RegisterFontRequest, type RegisteredFontInfo,
  type FormFieldInfo, type PdfAnnotationInfo, type OutlineEntry,
  type RecoverySnapshot, type RestoreRecoveryRequest,
  editTransactionSchema, assertTextRange,
} from '@pdf-editor/contracts';
import type { WasmCoreBinding } from '../rpc/server.js';
import { transformPdfExport } from './qpdf-export.js';
import { ABI3_BASE_CAPABILITIES, ABI3_CAPABILITIES, EDIT_COMMAND_STRIDE, packCommands } from './abi3-commands.js';

const ABI_1 = 1;
const ABI_2 = 2;
const PDE_TEXT_EDIT_STRIDE = 24;
const UINT32_MAX = 0xffff_ffff;
const TEXT_REPLACE_CAPABILITY = 'text.replace' as const;
const DEFAULT_FONT_MANIFEST_URL = '/fonts/font-resources.json';
const KNOWN_ERROR_CODES = new Set<EngineErrorCode>([
  'INVALID_REQUEST',
  'DOCUMENT_NOT_FOUND',
  'STALE_REVISION',
  'UNSUPPORTED_CAPABILITY',
  'PASSWORD_REQUIRED',
  'WORKER_EXITED',
  'CORE_UNAVAILABLE',
  'RESOURCE_LIMIT',
  'SAVE_FAILED',
]);

export interface PdfCoreEmscriptenModule {
  HEAPU8: Uint8Array<ArrayBuffer>;
  PDE_CORE_BUILD_ID?: string | undefined;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _pde_abi_version(): number;
  _pde_capabilities?(): number;
  _pde_initialize(): number;
  _pde_shutdown(): void;
  _pde_open_memory(
    bytes: number,
    length: number,
    documentId: number,
    sourceId: number,
    password: number,
  ): number;
  _pde_open_file_utf8(path: number, documentId: number, sourceId: number, password: number): number;
  _pde_close(document: number): number;
  _pde_document_info(document: number): number;
  _pde_describe_page(document: number, pageIndex: number): number;
  _pde_describe_forms?(document: number): number;
  _pde_describe_annotations?(document: number, pageIndex: number): number;
  _pde_describe_outline?(document: number): number;
  _pde_extract_page(document: number, pageIndex: number): number;
  _pde_render(
    document: number,
    pageIndex: number,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
    fullWidth: number,
    fullHeight: number,
  ): number;
  _pde_save_memory(document: number): number;
  _pde_extract_pages_memory?(document: number, pageIds: number, pageCount: number): number;
  _pde_save_file_utf8(document: number, destination: number): number;
  _pde_binary_data(): number;
  _pde_binary_size(): number;
  _pde_error_code(): number;
  _pde_error_message(): number;
  _pde_text_edit_stride?(): number;
  _pde_register_truetype_font?(fontId: number, bytes: number, length: number): number;
  _pde_font_faces?(bytes: number, length: number): number;
  _pde_register_font?(fontId: number, bytes: number, length: number, faceIndex: number): number;
  _pde_preview_text?(document: number, edit: number): number;
  _pde_apply_text?(document: number, baseRevision: number, transactionId: number, edits: number, count: number): number;
  _pde_undo?(document: number): number;
  _pde_redo?(document: number): number;
  _pde_edit_command_stride?(): number;
  _pde_register_rgba_image?(document: number, id: number, width: number, height: number, bytes: number, length: number): number;
  _pde_register_pdf_resource?(document: number, id: number, bytes: number, length: number): number;
  _pde_preview_commands?(document: number, revision: number, commands: number, count: number): number;
  _pde_preview_text_insert?(document: number, revision: number, command: number): number;
  _pde_apply_commands?(document: number, revision: number, transactionId: number, commands: number, count: number): number;
  _pde_confirm_save?(document: number, revision: number): number;
  _pde_export_recovery?(document: number): number;
  _pde_restore_recovery?(bytes: number, length: number, password: number): number;
  _pde_recovery_resources?(handle: number): number;
}

export type PdfCoreBindingOptions = {
  /** Actual build identity supplied by the generated runtime or release config. */
  coreBuildId?: string | undefined;
  /** Test/deployment override; production defaults to the same-origin public manifest. */
  fontManifestUrl?: string | URL | undefined;
  fetch?: typeof globalThis.fetch | undefined;
};

type Abi2Exports = {
  textEditStride(): number;
  registerTrueTypeFont(fontId: number, bytes: number, length: number): number;
  previewText(document: number, edit: number): number;
  applyText(document: number, baseRevision: number, transactionId: number, edits: number, count: number): number;
  undo(document: number): number;
  redo(document: number): number;
};

type DocumentSession = {
  handle: number;
  password?: string | undefined;
  info: DocumentInfo;
  pageIndices: ReadonlyMap<string, number>;
  pageModels: Map<string, PageModel>;
};

type RenderMetadata = Omit<RenderResult, 'pixels'>;
type SaveMetadata = { docId: string; savedRevision: number };
type PackedTextEdit = {
  pageIndex: number;
  blockId: string;
  startUtf16: number;
  endUtf16: number;
  replacement: string;
  fontId?: string | undefined;
};
type FontManifestEntry = {
  id: string;
  family: string;
  style: string;
  format: 'ttf' | 'otf';
  url: string;
  sha256: string;
  faceIndex?: number;
};
type RecoveryResourcesMetadata = {
  fonts: string[];
  fontFaces: RegisteredFontInfo[];
  resources: ResourceInfo[];
};

export function createPdfCoreBinding(
  module: PdfCoreEmscriptenModule,
  options: PdfCoreBindingOptions = {},
): WasmCoreBinding {
  assertBaseModule(module);
  const coreBuildId = options.coreBuildId ?? module.PDE_CORE_BUILD_ID;
  if (!coreBuildId?.trim()) {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core build identity was not injected by the runtime configuration');
  }

  const abiVersion = module._pde_abi_version();
  if (![ABI_1, ABI_2, 3].includes(abiVersion)) {
    throw new EngineError('CORE_UNAVAILABLE', `Unsupported PDF core ABI ${abiVersion}`);
  }
  const abi2 = abiVersion >= ABI_2 ? bindAbi2Exports(module) : null;
  if (abiVersion === 3) {
    const names = ['_pde_edit_command_stride', '_pde_register_rgba_image', '_pde_register_pdf_resource',
      '_pde_preview_commands', '_pde_apply_commands', '_pde_confirm_save'] as const;
    if (names.some(name => typeof module[name] !== 'function') || module._pde_edit_command_stride!() !== EDIT_COMMAND_STRIDE) {
      throw new EngineError('CORE_UNAVAILABLE', 'Incomplete or incompatible ABI 3 core');
    }
  }
  if (module._pde_initialize() === 0) throw readCoreError(module, 'PDF core initialization failed');
  const textEditStride = abi2?.textEditStride();
  if (textEditStride !== undefined && textEditStride !== PDE_TEXT_EDIT_STRIDE) {
    module._pde_shutdown();
    throw new EngineError(
      'CORE_UNAVAILABLE',
      `Unsupported PdeTextEdit stride ${textEditStride}; expected ${PDE_TEXT_EDIT_STRIDE}`,
    );
  }

  let capabilities: CommandType[] = abiVersion === 3 ? [...ABI3_BASE_CAPABILITIES] : abi2 ? [TEXT_REPLACE_CAPABILITY] : [];
  if (abiVersion === 3 && module._pde_capabilities) {
    const value: unknown = JSON.parse(readCString(module, module._pde_capabilities()));
    if (!isStringArray(value) || new Set(value).size !== value.length || !stringsSubsetOf(value, ABI3_CAPABILITIES)) {
      module._pde_shutdown();
      throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned unsupported capability metadata');
    }
    capabilities = value as CommandType[];
  }
  const fontRegistry = abi2 ? new WorkerFontRegistry(module, abi2, options) : null;
  return {
    handshake: { protocolVersion: WORKER_PROTOCOL_VERSION, coreBuildId, capabilities },
    engine: new CApiWasmEngineAdapter(module, abi2, fontRegistry, capabilities),
  };
}

export class CApiWasmEngineAdapter implements EngineAdapter {
  private readonly documents = new Map<string, DocumentSession>();

  constructor(
    private readonly module: PdfCoreEmscriptenModule,
    private readonly abi2: Abi2Exports | null = null,
    private readonly fontRegistry: WorkerFontRegistry | null = null,
    private readonly capabilities: readonly CommandType[] = abi2 ? [TEXT_REPLACE_CAPABILITY] : [],
  ) {}

  async open(source: DocumentSource, password?: string): Promise<DocumentInfo> {
    if (source.kind !== 'bytes') {
      throw new EngineError('INVALID_REQUEST', 'The browser PDF core only accepts in-memory byte sources');
    }
    if (source.bytes.byteLength === 0 || source.bytes.byteLength > UINT32_MAX) {
      throw new EngineError('INVALID_REQUEST', 'PDF input must contain between 1 and 4,294,967,295 bytes');
    }
    if (!globalThis.crypto?.randomUUID) {
      throw new EngineError('CORE_UNAVAILABLE', 'crypto.randomUUID is required for document session identity');
    }

    const documentId = crypto.randomUUID();
    const allocations = new WasmAllocations(this.module);
    let handle = 0;
    try {
      const bytesPointer = allocations.bytes(new Uint8Array(source.bytes));
      const documentIdPointer = allocations.string(documentId);
      const sourceIdPointer = allocations.string(source.sourceId);
      const passwordPointer = password === undefined ? 0 : allocations.string(password);
      handle = this.module._pde_open_memory(
        bytesPointer,
        source.bytes.byteLength,
        documentIdPointer,
        sourceIdPointer,
        passwordPointer,
      );
      if (handle === 0) throw readCoreError(this.module, 'Unable to open PDF document');
    } finally {
      allocations.free();
    }

    try {
      const info = validateDocumentInfo(
        this.readJson(() => this.module._pde_document_info(handle), 'Unable to read document metadata'),
        documentId,
        source.sourceId,
        this.capabilities,
      );
      const pageIndices = pageIndexMap(info.pageOrder);
      this.documents.set(documentId, { handle, password, info, pageIndices, pageModels: new Map() });
      return info;
    } catch (error) {
      this.module._pde_close(handle);
      throw error;
    }
  }

  async describePage(docId: string, pageId: string): Promise<PageModel> {
    const session = this.document(docId);
    const cached = session.pageModels.get(pageId);
    if (cached) return cached;
    const pageIndex = this.pageIndex(session, pageId);
    const page = validatePageModel(
      this.readJson(
        () => this.module._pde_describe_page(session.handle, pageIndex),
        'Unable to describe PDF page',
      ),
      pageId,
    );
    session.pageModels.set(pageId, page);
    return page;
  }

  async describeForms(docId: string): Promise<FormFieldInfo[]> {
    const session = this.document(docId);
    if (!this.module._pde_describe_forms) throw unsupported('Form inspection is unavailable in this core');
    return validateFormFieldInfo(this.readJson(
      () => this.module._pde_describe_forms!(session.handle),
      'Unable to describe PDF forms',
    ), session.info);
  }

  async describeAnnotations(docId: string, pageId: string): Promise<PdfAnnotationInfo[]> {
    const session = this.document(docId);
    if (!this.module._pde_describe_annotations) throw unsupported('Annotation inspection is unavailable in this core');
    const pageIndex = this.pageIndex(session, pageId);
    return validateAnnotationInfo(this.readJson(
      () => this.module._pde_describe_annotations!(session.handle, pageIndex),
      'Unable to describe PDF annotations',
    ), pageId);
  }

  async describeOutline(docId: string): Promise<OutlineEntry[]> {
    const session = this.document(docId);
    if (!this.module._pde_describe_outline) throw unsupported('PDF outline inspection is unavailable in this core');
    const entries: unknown = this.readJson(
      () => this.module._pde_describe_outline!(session.handle), 'Unable to read PDF bookmarks');
    if (!Array.isArray(entries) || entries.some(entry =>
      !entry || typeof entry !== 'object' || typeof entry.title !== 'string' ||
      !Number.isSafeInteger(entry.level) || entry.level < 0 ||
      (entry.pageId !== null && !session.info.pageOrder.includes(entry.pageId)))) {
      throw new EngineError('CORE_UNAVAILABLE', 'PDF outline contains invalid page references');
    }
    return entries as OutlineEntry[];
  }

  async describeFonts(docId: string): Promise<RegisteredFontInfo[]> {
    return this.readRecoveryResources(this.document(docId).handle).fontFaces;
  }

  async render(request: RenderRequest): Promise<RenderResult> {
    if (!Number.isFinite(request.scale) || request.scale <= 0) {
      throw new EngineError('INVALID_REQUEST', 'Render scale must be a positive finite number');
    }
    const session = this.document(request.docId);
    const pageIndex = this.pageIndex(session, request.pageId);
    const page = await this.describePage(request.docId, request.pageId);
    const viewport = renderViewport(page, request);
    const metadata = validateRenderMetadata(
      this.readJson(
        () => this.module._pde_render(
          session.handle,
          pageIndex,
          viewport.width,
          viewport.height,
          viewport.offsetX,
          viewport.offsetY,
          viewport.fullWidth,
          viewport.fullHeight,
        ),
        'Unable to render PDF page',
      ),
      viewport.width,
      viewport.height,
    );
    const pixels = this.copyBinary('Unable to read rendered pixels');
    const expectedBytes = metadata.stride * metadata.height;
    if (pixels.byteLength !== expectedBytes) {
      throw new EngineError(
        'CORE_UNAVAILABLE',
        `PDF core returned ${pixels.byteLength} render bytes; expected ${expectedBytes}`,
      );
    }
    return { ...metadata, pixels };
  }

  async extract(request: ExtractionRequest): Promise<TextBlock[]> {
    const session = this.document(request.docId);
    const pages = request.pageIds.map((pageId) => ({
      pageId,
      pageIndex: this.pageIndex(session, pageId),
    }));
    const blocks: TextBlock[] = [];
    // Deliberately serial: every call may replace the core's operation buffer.
    for (const page of pages) {
      const extracted = validateTextBlocks(
        this.readJson(
          () => this.module._pde_extract_page(session.handle, page.pageIndex),
          'Unable to extract PDF text',
        ),
        page.pageId,
      );
      blocks.push(...extracted);
    }
    return blocks;
  }

  async previewText(request: TextLayoutRequest): Promise<TextLayoutResult> {
    const abi2 = this.requireAbi2();
    const session = this.document(request.docId);
    const edit = await this.prepareTextEdit(session, request);
    if (edit.fontId) await this.requireFontRegistry().ensureRegistered(edit.fontId);

    const allocations = new WasmAllocations(this.module);
    try {
      const editPointer = packTextEdits(this.module, allocations, [edit]);
      return validateTextLayoutResult(
        this.readJson(
          () => abi2.previewText(session.handle, editPointer),
          'Unable to preview text replacement',
        ),
      );
    } finally {
      allocations.free();
    }
  }

  async apply(transaction: EditTransaction): Promise<CommitResult> {
    if (this.module._pde_abi_version() === 3) return this.executeCommands(transaction, true) as Promise<CommitResult>;
    const abi2 = this.requireAbi2();
    if (!isRecord(transaction)
        || typeof transaction.id !== 'string' || transaction.id.length === 0
        || typeof transaction.docId !== 'string'
        || !isNonNegativeInteger(transaction.baseRevision)
        || (transaction.source !== 'manual' && transaction.source !== 'ai')
        || !Array.isArray(transaction.commands) || transaction.commands.length === 0) {
      throw new EngineError('INVALID_REQUEST', 'Invalid text replacement transaction');
    }
    const session = this.document(transaction.docId);
    if (transaction.baseRevision !== session.info.revision) {
      throw new EngineError('STALE_REVISION', 'Document has changed; regenerate changes from the current revision');
    }

    const edits: PackedTextEdit[] = [];
    const targets = new Set<string>();
    for (const command of transaction.commands) {
      if (!isRecord(command) || command.type !== TEXT_REPLACE_CAPABILITY) {
        throw unsupported('ABI 2 currently supports only text.replace commands');
      }
      const allowedFields = new Set(['type', 'pageId', 'blockId', 'range', 'text', 'style']);
      if (Object.keys(command).some((field) => !allowedFields.has(field))) {
        throw new EngineError('INVALID_REQUEST', 'text.replace contains unsupported fields');
      }
      const edit = await this.prepareTextEdit(session, {
        docId: transaction.docId,
        pageId: command.pageId as string,
        blockId: command.blockId as string,
        range: command.range as [number, number],
        text: command.text as string,
        ...(command.style === undefined ? {} : { style: command.style as TextStyle }),
      });
      const targetKey = `${edit.pageIndex}\0${edit.blockId}`;
      if (targets.has(targetKey)) {
        throw new EngineError('INVALID_REQUEST', 'A whole text block can be replaced only once per transaction');
      }
      targets.add(targetKey);
      if (edit.fontId) await this.requireFontRegistry().ensureRegistered(edit.fontId);
      edits.push(edit);
    }

    const allocations = new WasmAllocations(this.module);
    try {
      const transactionId = allocations.string(transaction.id);
      const editsPointer = packTextEdits(this.module, allocations, edits);
      const result = validateCommitResult(
        this.readJson(
          () => abi2.applyText(
            session.handle,
            transaction.baseRevision,
            transactionId,
            editsPointer,
            edits.length,
          ),
          'Unable to apply text replacement',
        ),
        transaction.docId,
        session.info.revision,
      );
      this.applyCommitResult(session, result);
      return result;
    } finally {
      allocations.free();
    }
  }

  async undo(docId: string): Promise<CommitResult> {
    const abi2 = this.requireAbi2();
    const session = this.document(docId);
    const result = validateCommitResult(
      this.readJson(() => abi2.undo(session.handle), 'Unable to undo the last edit'),
      docId,
      session.info.revision,
    );
    this.applyCommitResult(session, result);
    return result;
  }

  async redo(docId: string): Promise<CommitResult> {
    const abi2 = this.requireAbi2();
    const session = this.document(docId);
    const result = validateCommitResult(
      this.readJson(() => abi2.redo(session.handle), 'Unable to redo the last edit'),
      docId,
      session.info.revision,
    );
    this.applyCommitResult(session, result);
    return result;
  }

  async save(request: SaveRequest): Promise<SaveResult> {
    if (!['preserve', 'remove', 'set'].includes(request.protection)) throw new EngineError('INVALID_REQUEST', 'Unknown PDF protection option');
    if (request.target !== undefined) throw new EngineError('INVALID_REQUEST', 'Choose export destinations through the application');
    if (request.optimize !== undefined && typeof request.optimize !== 'boolean') throw new EngineError('INVALID_REQUEST', 'Optimization must be a boolean');
    const imageOptimization = request.imageOptimization;
    if (imageOptimization !== undefined &&
        (!imageOptimization || typeof imageOptimization !== 'object' ||
         Object.keys(imageOptimization).some(key => key !== 'quality' && key !== 'maxEdge') ||
         !Number.isInteger(imageOptimization.quality) || imageOptimization.quality < 1 || imageOptimization.quality > 95 ||
         (imageOptimization.maxEdge !== undefined && (!Number.isInteger(imageOptimization.maxEdge) ||
           imageOptimization.maxEdge < 1 || imageOptimization.maxEdge > 0x7fffffff)))) {
      throw new EngineError('INVALID_REQUEST', 'Image quality must be 1–95 and maximum edge a positive pixel count');
    }
    const imageQuality = imageOptimization?.quality;
    const imageMaxEdge = imageOptimization?.maxEdge;
    if (request.protection === 'set' && (typeof request.password !== 'string' || !request.password || request.password.includes('\0'))) throw new EngineError('INVALID_REQUEST', 'A nonempty PDF password without null characters is required');
    if (request.protection !== 'set' && request.password !== undefined) throw new EngineError('INVALID_REQUEST', 'A new password is only used when setting protection');
    const session = this.document(request.docId);
    const metadata = validateSaveMetadata(
      this.readJson(() => this.module._pde_save_memory(session.handle), 'Unable to save PDF document'),
      request.docId,
    );
    let bytes = this.copyBinary('Unable to read saved PDF bytes');
    let inputPassword = session.password;
    if (request.protection !== 'preserve') {
      bytes = await transformPdfExport(bytes, {
        operation: request.protection === 'set' ? 'encrypt-aes256' : 'decrypt',
        ...(inputPassword === undefined ? {} : { inputPassword }),
        ...(request.password === undefined ? {} : { password: request.password }),
      });
      inputPassword = request.protection === 'set' ? request.password : undefined;
    }
    if (request.optimize) bytes = await transformPdfExport(bytes, { operation: 'optimize-lossless',
      ...(inputPassword === undefined ? {} : { inputPassword }) });
    if (imageQuality !== undefined) bytes = await transformPdfExport(bytes, {
      operation: imageMaxEdge === undefined ? 'optimize-images' : 'resample-images', imageQuality,
      ...(imageMaxEdge === undefined ? {} : { imageMaxEdge }),
      ...(inputPassword === undefined ? {} : { inputPassword }),
    });
    return { kind: 'bytes', docId: request.docId, savedRevision: metadata.savedRevision, bytes };
  }

  async extractPages(request: ExtractPagesRequest): Promise<ExtractPagesResult> {
    const session = this.document(request.docId);
    if (!this.module._pde_extract_pages_memory) throw unsupported('Page extraction is unavailable in this PDF core');
    if (!Array.isArray(request.pageIds) || !request.pageIds.length ||
      new Set(request.pageIds).size !== request.pageIds.length ||
      request.pageIds.some(id => !session.pageIndices.has(id))) {
      throw new EngineError('INVALID_REQUEST', 'Select distinct existing pages to extract');
    }
    const allocations = new WasmAllocations(this.module);
    try {
      const pointers = request.pageIds.map(id => allocations.string(id));
      const table = allocations.raw(pointers.length * 4);
      const view = new DataView(this.module.HEAPU8.buffer, table, pointers.length * 4);
      pointers.forEach((pointer, index) => view.setUint32(index * 4, pointer, true));
      const metadata = this.readJson(() => this.module._pde_extract_pages_memory!(session.handle, table, pointers.length),
        'Unable to extract PDF pages');
      if (!isRecord(metadata) || metadata.kind !== 'bytes' || metadata.sourceRevision !== session.info.revision ||
        !Array.isArray(metadata.pageIds) || metadata.pageIds.length !== request.pageIds.length ||
        metadata.pageIds.some((id, index) => id !== request.pageIds[index])) {
        throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid page extraction metadata');
      }
      return { kind: 'bytes', docId: request.docId, sourceRevision: session.info.revision,
        pageIds: [...request.pageIds], bytes: this.copyBinary('Unable to read extracted PDF bytes') };
    } finally { allocations.free(); }
  }

  async registerResource(request: RegisterResourceRequest): Promise<ResourceInfo> {
    this.requireAbi3();
    const session = this.document(request.docId);
    const source = request.source;
    if (source.kind === 'native-file') throw new EngineError('INVALID_REQUEST', 'Browser resources require local bytes');
    if (!source.bytes.byteLength || source.bytes.byteLength > UINT32_MAX) throw new EngineError('RESOURCE_LIMIT', 'Invalid resource size');
    if (source.kind === 'rgba' && (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)
        || source.width <= 0 || source.height <= 0 || source.width * source.height * 4 !== source.bytes.byteLength)) {
      throw new EngineError('INVALID_REQUEST', 'Image requires width × height × 4 RGBA bytes');
    }
    const allocations = new WasmAllocations(this.module);
    try {
      const id = allocations.string(request.resourceId);
      const bytes = allocations.bytes(new Uint8Array(source.bytes));
      if (source.kind === 'rgba') {
        if (!this.module._pde_register_rgba_image!(session.handle, id, source.width, source.height, bytes, source.bytes.byteLength)) {
          throw readCoreError(this.module, 'Unable to register image');
        }
        return { id: request.resourceId, kind: 'image', width: source.width, height: source.height };
      }
      const info = this.readJson(() => this.module._pde_register_pdf_resource!(session.handle, id, bytes, source.bytes.byteLength), 'Unable to register PDF content');
      if (!isRecord(info) || info.id !== request.resourceId || info.kind !== 'pdf' || !isNonNegativeInteger(info.pageCount) || info.pageCount === 0) {
        throw new EngineError('CORE_UNAVAILABLE', 'Invalid PDF resource metadata');
      }
      return info as ResourceInfo;
    } finally { allocations.free(); }
  }

  async previewTransaction(transaction: EditTransaction): Promise<TransactionPreviewResult> {
    return this.executeCommands(transaction, false) as Promise<TransactionPreviewResult>;
  }

  async confirmSave(request: SaveConfirmation): Promise<DocumentInfo> {
    const session = this.document(request.docId);
    if (!isNonNegativeInteger(request.savedRevision) || request.savedRevision > session.info.revision) {
      throw new EngineError('INVALID_REQUEST', 'Save confirmation does not match a document revision');
    }
    if (this.module._pde_abi_version() === 3) {
      session.info = validateDocumentInfo(this.readJson(
        () => this.module._pde_confirm_save!(session.handle, request.savedRevision), 'Unable to confirm save'),
        request.docId, session.info.sourceIds[0]!, this.capabilities);
    } else {
      // ABI 1/2 already mark export in core; maintain the host-confirmed UI mirror.
      session.info = { ...session.info, savedRevision: request.savedRevision };
    }
    return session.info;
  }

  private requireAbi3(): void {
    if (this.module._pde_abi_version() !== 3) throw unsupported('This operation requires the general editing core');
  }

  private async executeCommands(input: EditTransaction, commit: boolean): Promise<CommitResult | TransactionPreviewResult> {
    this.requireAbi3();
    const transaction = editTransactionSchema.parse(input);
    const session = this.document(transaction.docId);
    if (session.info.revision !== transaction.baseRevision) throw new EngineError('STALE_REVISION', 'Document has changed');
    for (const command of transaction.commands) {
      if (!session.info.capabilities.includes(command.type)) throw unsupported(`Unsupported command: ${command.type}`);
      if ('style' in command && command.style?.fontId) await this.requireFontRegistry().ensureRegistered(command.style.fontId);
      if (command.type === 'form.create' && command.fontId) await this.requireFontRegistry().ensureRegistered(command.fontId);
    }
    const allocations = new WasmAllocations(this.module);
    try {
      const commands = packCommands(allocations, transaction.commands);
      const id = allocations.string(transaction.id);
      if (commit) {
        const result = validateCommitResult(this.readJson(
          () => this.module._pde_apply_commands!(session.handle, transaction.baseRevision, id, commands, transaction.commands.length),
          'Unable to apply transaction'), transaction.docId, session.info.revision);
        this.applyCommitResult(session, result);
        return result;
      }
      const result = this.readJson(
        () => this.module._pde_preview_commands!(session.handle, transaction.baseRevision, commands, transaction.commands.length),
        'Unable to preview transaction');
      if (!isRecord(result) || result.docId !== transaction.docId || result.baseRevision !== transaction.baseRevision
          || !isStringArray(result.pageOrder) || !isStringArray(result.changedPageIds)) {
        throw new EngineError('CORE_UNAVAILABLE', 'Invalid transaction preview');
      }
      return result as TransactionPreviewResult;
    } finally { allocations.free(); }
  }

  async exportRecovery(docId: string): Promise<RecoverySnapshot> {
    const session = this.document(docId);
    if (!this.module._pde_export_recovery) {
      throw unsupported('Recovery export is unavailable in this core');
    }
    const raw = this.module._pde_export_recovery(session.handle);
    if (raw === 0) throw readCoreError(this.module, 'Unable to export recovery snapshot');
    const metadata = this.readJson(() => raw, 'Unable to read recovery metadata');
    if (!isRecord(metadata) || metadata.docId !== docId || !isNonNegativeInteger(metadata.revision) || !isNonNegativeInteger(metadata.savedRevision)) {
      throw new EngineError('CORE_UNAVAILABLE', 'Invalid recovery metadata');
    }
    const bytes = this.copyBinary('Unable to read recovery snapshot binary');
    return {
      docId: metadata.docId as string,
      revision: metadata.revision as number,
      savedRevision: metadata.savedRevision as number,
      kind: 'bytes',
      bytes,
    };
  }

  async restoreRecovery(request: RestoreRecoveryRequest): Promise<DocumentInfo> {
    if (request.source.kind !== 'bytes') {
      throw new EngineError('INVALID_REQUEST', 'Web core only accepts in-memory byte recovery snapshots');
    }
    if (!this.module._pde_restore_recovery) {
      throw unsupported('Recovery restore is unavailable in this core');
    }
    const allocations = new WasmAllocations(this.module);
    let handle = 0;
    try {
      const bytesPointer = allocations.bytes(new Uint8Array(request.source.bytes));
      const passwordPointer = request.password === undefined ? 0 : allocations.string(request.password);
      handle = this.module._pde_restore_recovery(bytesPointer, request.source.bytes.byteLength, passwordPointer);
      if (handle === 0) throw readCoreError(this.module, 'Unable to restore PDF recovery record');
    } finally {
      allocations.free();
    }

    try {
      const info = validateDocumentInfo(
        this.readJson(() => this.module._pde_document_info(handle), 'Unable to read restored document metadata'),
        undefined,
        undefined,
        this.capabilities,
        true,
      );
      if (this.documents.has(info.id)) {
        throw new EngineError('INVALID_REQUEST', 'Document is already open in current session');
      }
      const pageIndices = pageIndexMap(info.pageOrder);
      const resources = this.readRecoveryResources(handle);
      const fontRegistry = this.requireFontRegistry();
      for (const fontId of resources.fonts) fontRegistry.markRegistered(fontId);
      this.documents.set(info.id, { handle, password: request.password, info, pageIndices, pageModels: new Map() });
      return info;
    } catch (error) {
      this.module._pde_close(handle);
      throw error;
    }
  }

  async close(docId: string): Promise<void> {
    const session = this.document(docId);
    if (this.module._pde_close(session.handle) === 0) {
      throw readCoreError(this.module, 'Unable to close PDF document');
    }
    this.documents.delete(docId);
  }

  private async prepareTextEdit(
    session: DocumentSession,
    request: TextLayoutRequest,
  ): Promise<PackedTextEdit> {
    if (!isRecord(request)
        || request.docId !== session.info.id
        || typeof request.pageId !== 'string'
        || typeof request.blockId !== 'string'
        || typeof request.text !== 'string'
        || !Array.isArray(request.range)
        || request.range.length !== 2
        || !isNonNegativeInteger(request.range[0])
        || !isNonNegativeInteger(request.range[1])) {
      throw new EngineError('INVALID_REQUEST', 'Invalid text layout request');
    }
    const fontId = validateReplacementStyle(request.style);
    const page = await this.describePage(session.info.id, request.pageId);
    const block = page.objects.find((object) => object.textBlock?.id === request.blockId)?.textBlock;
    if (!block || block.editability === 'geometry-only') {
      throw new EngineError('INVALID_REQUEST', 'Target is not an editable text block');
    }
    const originalText = block.runs.map((run) => run.text).join('');
    if (this.module._pde_abi_version() < 3 && (request.range[0] !== 0 || request.range[1] !== originalText.length)) {
      throw unsupported('ABI 2 currently supports only whole TextBlock replacement');
    }
    assertTextRange(originalText, request.range);
    return {
      pageIndex: this.pageIndex(session, request.pageId),
      blockId: request.blockId,
      startUtf16: request.range[0],
      endUtf16: request.range[1],
      replacement: request.text,
      ...(fontId ? { fontId } : {}),
    };
  }

  private applyCommitResult(session: DocumentSession, result: CommitResult): void {
    session.info = {
      ...session.info,
      revision: result.revision,
      pageOrder: result.pageOrder,
    };
    session.pageIndices = pageIndexMap(result.pageOrder);
    for (const pageId of result.changedPageIds) session.pageModels.delete(pageId);
    for (const pageId of session.pageModels.keys()) {
      if (!session.pageIndices.has(pageId)) session.pageModels.delete(pageId);
    }
  }

  private requireAbi2(): Abi2Exports {
    if (!this.abi2) throw unsupported('Editing is not connected to ABI 1');
    return this.abi2;
  }

  async previewTextInsert(request: TextInsertLayoutRequest): Promise<TextLayoutResult> {
    this.requireAbi3();
    if (!this.module._pde_preview_text_insert) throw unsupported('Text box layout preview is unavailable in this core');
    const session = this.document(request.docId);
    const transaction = editTransactionSchema.parse({ id: 'text-layout-preview', docId: request.docId,
      baseRevision: request.baseRevision, source: 'manual', commands: [request.command] });
    const command = transaction.commands[0]!;
    if (command.type !== 'text.insert' && command.type !== 'text.reflow') throw new EngineError('INVALID_REQUEST', 'Text insertion or reflow command required');
    if (session.info.revision !== transaction.baseRevision) throw new EngineError('STALE_REVISION', 'Document has changed');
    if (command.style.fontId) await this.requireFontRegistry().ensureRegistered(command.style.fontId);
    const allocations = new WasmAllocations(this.module);
    try {
      const pointer = packCommands(allocations, [command]);
      return validateTextLayoutResult(this.readJson(
        () => this.module._pde_preview_text_insert!(session.handle, request.baseRevision, pointer), 'Unable to preview text box'));
    } finally { allocations.free(); }
  }

  async inspectFont(source: FontSource): Promise<FontFaceInfo[]> {
    const bytes = localFontBytes(source);
    if (!this.module._pde_font_faces) throw unsupported('Font inspection is unavailable in this PDF core');
    const allocations = new WasmAllocations(this.module);
    try {
      const pointer = allocations.bytes(bytes);
      const value = this.readJson(() => this.module._pde_font_faces!(pointer, bytes.byteLength), 'Unable to inspect font');
      if (!Array.isArray(value) || !value.every(isFontFaceInfo)) throw new EngineError('CORE_UNAVAILABLE', 'Invalid font face information');
      return value;
    } finally { allocations.free(); }
  }

  registerFont(request: RegisterFontRequest): Promise<RegisteredFontInfo> {
    return this.requireFontRegistry().registerLocal(request);
  }

  private requireFontRegistry(): WorkerFontRegistry {
    if (!this.fontRegistry) throw unsupported('Font registration is not connected to ABI 1');
    return this.fontRegistry;
  }

  private document(docId: string): DocumentSession {
    const session = this.documents.get(docId);
    if (!session) throw new EngineError('DOCUMENT_NOT_FOUND', `Unknown document session: ${docId}`);
    return session;
  }

  private pageIndex(session: DocumentSession, pageId: string): number {
    const pageIndex = session.pageIndices.get(pageId);
    if (pageIndex === undefined) {
      throw new EngineError('INVALID_REQUEST', `Page ${pageId} does not belong to document ${session.info.id}`);
    }
    return pageIndex;
  }

  private readRecoveryResources(handle: number): RecoveryResourcesMetadata {
    if (!this.module._pde_recovery_resources) throw unsupported('Recovered font metadata is unavailable in this core');
    return validateRecoveryResources(this.readJson(
      () => this.module._pde_recovery_resources!(handle),
      'Unable to read recovery resources',
    ));
  }

  private readJson(operation: () => number, fallbackMessage: string): unknown {
    const pointer = operation();
    if (pointer === 0) throw readCoreError(this.module, fallbackMessage);
    const json = readCString(this.module, pointer);
    try {
      return JSON.parse(json);
    } catch {
      throw new EngineError('CORE_UNAVAILABLE', `${fallbackMessage}: core returned invalid JSON`);
    }
  }

  private copyBinary(fallbackMessage: string): ArrayBuffer {
    const pointer = this.module._pde_binary_data();
    const size = this.module._pde_binary_size();
    if (!Number.isInteger(size) || size < 0 || size > UINT32_MAX || (size > 0 && pointer === 0)) {
      throw readCoreError(this.module, fallbackMessage);
    }
    // Re-read HEAPU8 after the core operation: ALLOW_MEMORY_GROWTH may replace the view.
    const heap = this.module.HEAPU8;
    if (pointer < 0 || pointer + size > heap.byteLength) {
      throw new EngineError('CORE_UNAVAILABLE', `${fallbackMessage}: binary range is outside WASM memory`);
    }
    const copy = new Uint8Array(size);
    copy.set(heap.subarray(pointer, pointer + size));
    return copy.buffer;
  }
}

class WorkerFontRegistry {
  private readonly registrations = new Map<string, Promise<void>>();
  private manifestPromise: Promise<Map<string, FontManifestEntry>> | null = null;

  constructor(
    private readonly module: PdfCoreEmscriptenModule,
    private readonly abi2: Abi2Exports,
    private readonly options: PdfCoreBindingOptions,
  ) {}

  ensureRegistered(fontId: string): Promise<void> {
    let registration = this.registrations.get(fontId);
    if (!registration) {
      registration = this.loadAndRegister(fontId);
      this.registrations.set(fontId, registration);
    }
    return registration;
  }

  markRegistered(fontId: string): void {
    this.registrations.set(fontId, Promise.resolve());
  }

  async registerLocal(request: RegisterFontRequest): Promise<RegisteredFontInfo> {
    const bytes = localFontBytes(request.source);
    if (!this.module._pde_register_font) throw unsupported('Font import is unavailable in this PDF core');
    if (!/^user-font-[a-zA-Z0-9-]+$/.test(request.id) || request.id.length > 160
        || !Number.isInteger(request.faceIndex) || request.faceIndex < 0 || request.faceIndex > UINT32_MAX) {
      throw new EngineError('INVALID_REQUEST', 'A user font ID and valid face index are required');
    }
    const allocations = new WasmAllocations(this.module);
    try {
      const id = allocations.string(request.id), pointer = allocations.bytes(bytes);
      const result = this.module._pde_register_font(id, pointer, bytes.byteLength, request.faceIndex);
      if (!result) throw readCoreError(this.module, 'Unable to import font');
      const face: unknown = JSON.parse(readCString(this.module, result));
      if (!isFontFaceInfo(face) || !('id' in face) || face.id !== request.id
          || !('faceIndex' in face) || face.faceIndex !== request.faceIndex) {
        throw new EngineError('CORE_UNAVAILABLE', 'Registered font does not match the selected face');
      }
      this.registrations.set(request.id, Promise.resolve());
      return face as RegisteredFontInfo;
    } finally { allocations.free(); }
  }

  private async loadAndRegister(fontId: string): Promise<void> {
    const manifest = await this.loadManifest();
    const entry = manifest.get(fontId);
    if (!entry) throw new EngineError('INVALID_REQUEST', `Unknown embeddable font resource: ${fontId}`);
    const faceIndex = entry.faceIndex ?? 0;
    if (!this.module._pde_register_font && (entry.format !== 'ttf' || faceIndex !== 0)) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', 'This PDF core does not support OpenType or collection font registration');
    }

    const manifestUrl = this.resolveManifestUrl();
    const fontUrl = sameOriginUrl(entry.url, manifestUrl, 'Font resource');
    const response = await this.fetch(fontUrl);
    if (!response.ok) {
      throw new EngineError('CORE_UNAVAILABLE', `Unable to load font resource ${fontId} (HTTP ${response.status})`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > UINT32_MAX) {
      throw new EngineError('RESOURCE_LIMIT', `Font resource ${fontId} has an invalid size`);
    }
    const actualHash = await sha256(bytes);
    if (actualHash !== entry.sha256) {
      throw new EngineError('CORE_UNAVAILABLE', `Font resource ${fontId} failed SHA-256 verification`);
    }
    // Keep structural TrueType validation for older runtimes; font rights remain metadata.
    if (!this.module._pde_register_font) assertEmbeddableTrueTypeFont(bytes, fontId);

    const allocations = new WasmAllocations(this.module);
    try {
      const fontIdPointer = allocations.string(fontId);
      const bytesPointer = allocations.bytes(new Uint8Array(bytes));
      if (this.module._pde_register_font) {
        const pointer = this.module._pde_register_font(fontIdPointer, bytesPointer, bytes.byteLength, faceIndex);
        if (!pointer) throw readCoreError(this.module, `Unable to register font resource ${fontId}`);
        const face: unknown = JSON.parse(readCString(this.module, pointer));
        if (!isRecord(face) || face.id !== fontId || face.faceIndex !== faceIndex || face.format !== entry.format) {
          throw new EngineError('CORE_UNAVAILABLE', `Registered font ${fontId} does not match its manifest face`);
        }
      } else if (this.abi2.registerTrueTypeFont(fontIdPointer, bytesPointer, bytes.byteLength) === 0) {
        throw readCoreError(this.module, `Unable to register font resource ${fontId}`);
      }
    } finally {
      allocations.free();
    }
  }

  private loadManifest(): Promise<Map<string, FontManifestEntry>> {
    this.manifestPromise ??= this.fetchManifest();
    return this.manifestPromise;
  }

  private async fetchManifest(): Promise<Map<string, FontManifestEntry>> {
    const response = await this.fetch(this.resolveManifestUrl());
    if (!response.ok) {
      throw new EngineError('CORE_UNAVAILABLE', `Unable to load font manifest (HTTP ${response.status})`);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new EngineError('CORE_UNAVAILABLE', 'Font manifest is not valid JSON');
    }
    if (!Array.isArray(value)) {
      throw new EngineError('CORE_UNAVAILABLE', 'Font manifest must be a top-level array');
    }
    const entries = new Map<string, FontManifestEntry>();
    for (const item of value) {
      if (!isFontManifestEntry(item) || entries.has(item.id)) {
        throw new EngineError('CORE_UNAVAILABLE', 'Font manifest contains an invalid or duplicate entry');
      }
      entries.set(item.id, item);
    }
    return entries;
  }

  private resolveManifestUrl(): URL {
    const value = this.options.fontManifestUrl ?? DEFAULT_FONT_MANIFEST_URL;
    const locationHref = globalThis.location?.href;
    if (!locationHref && typeof value === 'string') {
      try {
        return new URL(value);
      } catch {
        throw new EngineError('CORE_UNAVAILABLE', 'A base URL is required to load the font manifest');
      }
    }
    const url = new URL(value, locationHref);
    if (locationHref && url.origin !== new URL(locationHref).origin) {
      throw new EngineError('INVALID_REQUEST', 'Font manifest must be loaded from the application origin');
    }
    return url;
  }

  private fetch(url: URL): Promise<Response> {
    const fetcher = this.options.fetch ?? globalThis.fetch;
    if (!fetcher) throw new EngineError('CORE_UNAVAILABLE', 'fetch is required to load font resources');
    return fetcher(url, { credentials: 'same-origin' });
  }
}

class WasmAllocations {
  private readonly pointers: number[] = [];
  private readonly encoder = new TextEncoder();

  constructor(private readonly module: PdfCoreEmscriptenModule) {}

  bytes(value: Uint8Array): number {
    const pointer = this.allocate(value.byteLength);
    // _malloc may grow memory, so obtain the current view only after allocation.
    this.module.HEAPU8.set(value, pointer);
    return pointer;
  }

  string(value: string): number {
    if (value.includes('\0')) throw new EngineError('INVALID_REQUEST', 'WASM C strings cannot contain NUL characters');
    const encoded = this.encoder.encode(value);
    const pointer = this.allocate(encoded.byteLength + 1);
    const heap = this.module.HEAPU8;
    heap.set(encoded, pointer);
    heap[pointer + encoded.byteLength] = 0;
    return pointer;
  }

  raw(size: number): number {
    return this.allocate(size);
  }

  free(): void {
    for (let index = this.pointers.length - 1; index >= 0; index -= 1) {
      this.module._free(this.pointers[index]!);
    }
    this.pointers.length = 0;
  }

  private allocate(size: number): number {
    if (!Number.isSafeInteger(size) || size <= 0 || size > UINT32_MAX) {
      throw new EngineError('RESOURCE_LIMIT', 'Requested WASM allocation exceeds the ABI range');
    }
    const pointer = this.module._malloc(size);
    const heap = this.module.HEAPU8;
    if (!Number.isInteger(pointer) || pointer <= 0 || pointer + size > heap.byteLength) {
      throw new EngineError('RESOURCE_LIMIT', 'PDF core could not allocate WASM memory');
    }
    this.pointers.push(pointer);
    return pointer;
  }
}

function bindAbi2Exports(module: PdfCoreEmscriptenModule): Abi2Exports {
  const required = [
    '_pde_text_edit_stride',
    '_pde_register_truetype_font',
    '_pde_preview_text',
    '_pde_apply_text',
    '_pde_undo',
    '_pde_redo',
  ] as const;
  if (required.some((name) => typeof module[name] !== 'function')) {
    throw new EngineError('CORE_UNAVAILABLE', 'ABI 2 PDF core runtime is missing required editing exports');
  }
  return {
    textEditStride: () => module._pde_text_edit_stride!(),
    registerTrueTypeFont: (fontId, bytes, length) => module._pde_register_truetype_font!(fontId, bytes, length),
    previewText: (document, edit) => module._pde_preview_text!(document, edit),
    applyText: (document, baseRevision, transactionId, edits, count) => module._pde_apply_text!(document, baseRevision, transactionId, edits, count),
    undo: (document) => module._pde_undo!(document),
    redo: (document) => module._pde_redo!(document),
  };
}

function packTextEdits(
  module: PdfCoreEmscriptenModule,
  allocations: WasmAllocations,
  edits: readonly PackedTextEdit[],
): number {
  const fields = edits.map((edit) => ({
    ...edit,
    blockIdPointer: allocations.string(edit.blockId),
    replacementPointer: allocations.string(edit.replacement),
    fontIdPointer: edit.fontId ? allocations.string(edit.fontId) : 0,
  }));
  const pointer = allocations.raw(PDE_TEXT_EDIT_STRIDE * fields.length);
  const view = new DataView(module.HEAPU8.buffer);
  fields.forEach((edit, index) => {
    const offset = pointer + index * PDE_TEXT_EDIT_STRIDE;
    view.setUint32(offset, edit.pageIndex, true);
    view.setUint32(offset + 4, edit.blockIdPointer, true);
    view.setUint32(offset + 8, edit.startUtf16, true);
    view.setUint32(offset + 12, edit.endUtf16, true);
    view.setUint32(offset + 16, edit.replacementPointer, true);
    view.setUint32(offset + 20, edit.fontIdPointer, true);
  });
  return pointer;
}

function validateReplacementStyle(style: TextStyle | undefined): string | undefined {
  if (style === undefined) return undefined;
  if (!isRecord(style) || Object.keys(style).some((key) => key !== 'fontId')) {
    throw unsupported('ABI 2 text replacement style currently supports only fontId');
  }
  if (style.fontId === undefined) return undefined;
  if (typeof style.fontId !== 'string' || style.fontId.length === 0) {
    throw new EngineError('INVALID_REQUEST', 'Replacement fontId must be a non-empty string');
  }
  return style.fontId;
}

function renderViewport(page: PageModel, request: RenderRequest): {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  fullWidth: number;
  fullHeight: number;
} {
  const fullWidth = checkedDimension(Math.ceil(page.widthPt * request.scale));
  const fullHeight = checkedDimension(Math.ceil(page.heightPt * request.scale));
  const clip = request.clip;
  if (!clip) return { width: fullWidth, height: fullHeight, offsetX: 0, offsetY: 0, fullWidth, fullHeight };

  if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)
      || clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0
      || clip.x + clip.width > page.widthPt + 1e-6
      || clip.y + clip.height > page.heightPt + 1e-6) {
    throw new EngineError('INVALID_REQUEST', 'Render clip must be inside normalized page bounds');
  }

  const left = Math.floor(clip.x * request.scale);
  const top = Math.floor(clip.y * request.scale);
  const right = Math.min(fullWidth, Math.ceil((clip.x + clip.width) * request.scale));
  const bottom = Math.min(fullHeight, Math.ceil((clip.y + clip.height) * request.scale));
  return {
    width: checkedDimension(right - left),
    height: checkedDimension(bottom - top),
    offsetX: -left,
    offsetY: -top,
    fullWidth,
    fullHeight,
  };
}

function checkedDimension(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > UINT32_MAX) {
    throw new EngineError('RESOURCE_LIMIT', 'Requested render dimensions exceed the WASM ABI range');
  }
  return value;
}

function validateDocumentInfo(
  value: unknown,
  documentId: string | undefined,
  sourceId: string | undefined,
  expectedCapabilities: readonly CommandType[],
  requireSourceBytes = false,
): DocumentInfo {
  if (!isRecord(value)
      || typeof value.id !== 'string'
      || value.id.length === 0
      || (documentId !== undefined && value.id !== documentId)
      || !isNonNegativeInteger(value.revision)
      || !isNonNegativeInteger(value.savedRevision)
      || value.savedRevision > value.revision
      || !isStringArray(value.pageOrder)
      || new Set(value.pageOrder).size !== value.pageOrder.length
      || !isStringArray(value.sourceIds)
      || (sourceId !== undefined && !value.sourceIds.includes(sourceId))
      || (requireSourceBytes && value.sourceBytes === undefined)
      || (value.sourceBytes !== undefined && (typeof value.sourceBytes !== 'number' || !Number.isSafeInteger(value.sourceBytes) || value.sourceBytes <= 0 || value.sourceBytes > UINT32_MAX))
      || !isStringArray(value.capabilities)
      || new Set(value.capabilities).size !== value.capabilities.length
      || !stringsSubsetOf(value.capabilities, expectedCapabilities)
      || !isRecord(value.permissions)) {
    throw new EngineError(
      'CORE_UNAVAILABLE',
      'PDF core returned invalid DocumentInfo JSON',
    );
  }
  return value as DocumentInfo;
}

function stringsSubsetOf(values: readonly string[], allowed: readonly string[]): boolean {
  return values.every(value => allowed.includes(value));
}

function validatePageModel(value: unknown, pageId: string): PageModel {
  if (!isRecord(value)
      || value.id !== pageId
      || typeof value.widthPt !== 'number'
      || !Number.isFinite(value.widthPt)
      || value.widthPt <= 0
      || typeof value.heightPt !== 'number'
      || !Number.isFinite(value.heightPt)
      || value.heightPt <= 0
      || ![0, 90, 180, 270].includes(value.rotation as number)
      || !Array.isArray(value.objects)) {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid PageModel JSON');
  }
  return value as PageModel;
}

function validateRecoveryResources(value: unknown): RecoveryResourcesMetadata {
  if (!isRecord(value) || !isStringArray(value.fonts) || new Set(value.fonts).size !== value.fonts.length
      || !Array.isArray(value.fontFaces) || !Array.isArray(value.resources)) {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid recovery resource metadata');
  }
  const fontIds = new Set(value.fonts);
  const faceIds = new Set<string>();
  for (const face of value.fontFaces) {
    if (!isRegisteredFontInfo(face) || faceIds.has(face.id) || !fontIds.has(face.id)) {
      throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid recovery font metadata');
    }
    faceIds.add(face.id);
  }
  if (faceIds.size !== fontIds.size) {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned incomplete recovery font metadata');
  }
  const resourceIds = new Set<string>();
  for (const resource of value.resources) {
    if (!isResourceInfo(resource) || resourceIds.has(resource.id)) {
      throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid recovery resource metadata');
    }
    resourceIds.add(resource.id);
  }
  return value as RecoveryResourcesMetadata;
}

function isRegisteredFontInfo(value: unknown): value is RegisteredFontInfo {
  if (!isRecord(value)) return false;
  const { id, faceIndex } = value;
  if (!isFontFaceInfo(value)) return false;
  return typeof id === 'string' && id.length > 0
    && isNonNegativeInteger(faceIndex) && faceIndex === value.index;
}

function isResourceInfo(value: unknown): value is ResourceInfo {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return false;
  if (value.kind === 'image') {
    return isPositiveInteger(value.width) && isPositiveInteger(value.height) && value.pageCount === undefined;
  }
  return value.kind === 'pdf' && isPositiveInteger(value.pageCount)
    && value.width === undefined && value.height === undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateFormFieldInfo(value: unknown, document: DocumentInfo): FormFieldInfo[] {
  if (!Array.isArray(value)) throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid form field information');
  const ids = new Set<string>();
  for (const field of value) {
    if (!isRecord(field)
        || typeof field.id !== 'string' || field.id.length === 0 || ids.has(field.id)
        || typeof field.name !== 'string'
        || !['text', 'checkbox', 'radio', 'choice'].includes(field.type as string)
        || !isFormValue(field.value)
        || typeof field.readOnly !== 'boolean'
        || typeof field.required !== 'boolean'
        || (field.multiple !== undefined && typeof field.multiple !== 'boolean')
        || (field.choiceKind !== undefined && (field.type !== 'choice' || !['combo', 'list'].includes(field.choiceKind as string)))
        || (field.multiple === true && field.choiceKind !== 'list')
        || (field.tooltip !== undefined && typeof field.tooltip !== 'string')
        || (field.maxLen !== undefined && (!Number.isInteger(field.maxLen) || (field.maxLen as number) < 0))
        || !Array.isArray(field.options) || field.options.some(option => typeof option !== 'string')
        || !Array.isArray(field.widgets)
        || field.widgets.some(widget => !isRecord(widget)
          || typeof widget.pageId !== 'string' || !document.pageOrder.includes(widget.pageId)
          || !isRect(widget.bounds))) {
      throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid form field information');
    }
    ids.add(field.id);
  }
  return value as FormFieldInfo[];
}

function validateAnnotationInfo(value: unknown, pageId: string): PdfAnnotationInfo[] {
  if (!Array.isArray(value)) throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid annotation information');
  const ids = new Set<string>();
  for (const annotation of value) {
    if (!isRecord(annotation)
        || typeof annotation.id !== 'string' || annotation.id.length === 0 || ids.has(annotation.id)
        || annotation.pageId !== pageId
        || !['highlight', 'text', 'rectangle', 'ink', 'link', 'other'].includes(annotation.subtype as string)
        || !isRect(annotation.bounds)
        || typeof annotation.text !== 'string'
        || !Array.isArray(annotation.color) || annotation.color.length !== 3
        || annotation.color.some(component => typeof component !== 'number' || !Number.isFinite(component) || component < 0 || component > 1)
        || typeof annotation.opacity !== 'number' || !Number.isFinite(annotation.opacity)
        || annotation.opacity < 0 || annotation.opacity > 1
        || (annotation.targetPageId !== undefined && typeof annotation.targetPageId !== 'string')
        || (annotation.targetTopPt !== undefined && (typeof annotation.targetTopPt !== 'number' || !Number.isFinite(annotation.targetTopPt)))) {
      throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid annotation information');
    }
    ids.add(annotation.id);
  }
  return value as PdfAnnotationInfo[];
}

function isFormValue(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'boolean'
    || (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function validateTextBlocks(value: unknown, pageId: string): TextBlock[] {
  if (!Array.isArray(value)
      || value.some((block) => !isRecord(block) || block.pageId !== pageId || typeof block.id !== 'string')) {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid TextBlock JSON');
  }
  return value as TextBlock[];
}

function validateRenderMetadata(value: unknown, width: number, height: number): RenderMetadata {
  if (!isRecord(value)
      || value.width !== width
      || value.height !== height
      || !isNonNegativeInteger(value.revision)
      || !isNonNegativeInteger(value.stride)
      || value.stride < width * 4
      || value.format !== 'rgba') {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid RenderResult metadata');
  }
  return value as RenderMetadata;
}

function validateTextLayoutResult(value: unknown): TextLayoutResult {
  if (!isRecord(value)
      || !isRect(value.bounds)
      || typeof value.overflow !== 'boolean'
      || !Array.isArray(value.lines)
      || value.lines.some((line) => !isRecord(line) || !isRect(line.bounds) || !isTextRange(line.range))
      || (value.replacementFontId !== undefined && (typeof value.replacementFontId !== 'string' || value.replacementFontId.length === 0))) {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid TextLayoutResult JSON');
  }
  return value as TextLayoutResult;
}

function validateCommitResult(
  value: unknown,
  docId: string,
  previousRevision: number,
): CommitResult {
  if (!isRecord(value)
      || value.docId !== docId
      || !isNonNegativeInteger(value.revision)
      || value.revision <= previousRevision
      || !isStringArray(value.changedPageIds)
      || new Set(value.changedPageIds).size !== value.changedPageIds.length
      || !isStringArray(value.pageOrder)
      || new Set(value.pageOrder).size !== value.pageOrder.length
      || !stringsSubsetOf(value.changedPageIds, value.pageOrder)
      || typeof value.canUndo !== 'boolean'
      || typeof value.canRedo !== 'boolean') {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid CommitResult JSON');
  }
  return value as CommitResult;
}

function validateSaveMetadata(value: unknown, docId: string): SaveMetadata {
  if (!isRecord(value) || value.docId !== docId || !isNonNegativeInteger(value.savedRevision)) {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned invalid save metadata');
  }
  return value as SaveMetadata;
}

function readCoreError(module: PdfCoreEmscriptenModule, fallbackMessage: string): EngineError {
  const rawCode = readNullableCString(module, module._pde_error_code());
  const message = readNullableCString(module, module._pde_error_message()) || fallbackMessage;
  const code = rawCode && KNOWN_ERROR_CODES.has(rawCode as EngineErrorCode)
    ? rawCode as EngineErrorCode
    : 'CORE_UNAVAILABLE';
  return new EngineError(code, message);
}

function readCString(module: PdfCoreEmscriptenModule, pointer: number): string {
  const value = readNullableCString(module, pointer);
  if (value === null) throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned a null string');
  return value;
}

function readNullableCString(module: PdfCoreEmscriptenModule, pointer: number): string | null {
  if (pointer === 0) return null;
  const heap = module.HEAPU8;
  if (pointer < 0 || pointer >= heap.byteLength) {
    throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned a string outside WASM memory');
  }
  let end = pointer;
  while (end < heap.byteLength && heap[end] !== 0) end += 1;
  if (end === heap.byteLength) throw new EngineError('CORE_UNAVAILABLE', 'PDF core returned an unterminated string');
  return new TextDecoder().decode(heap.subarray(pointer, end));
}

function localFontBytes(source: FontSource): Uint8Array {
  if (source.kind !== 'bytes' || !(source.bytes instanceof ArrayBuffer)) throw new EngineError('INVALID_REQUEST', 'Web fonts require local bytes');
  if (!source.bytes.byteLength || source.bytes.byteLength > 64 * 1024 * 1024) throw new EngineError('RESOURCE_LIMIT', 'Font file must be between 1 byte and 64 MiB');
  return new Uint8Array(source.bytes);
}

function isFontFaceInfo(value: unknown): value is FontFaceInfo {
  return isRecord(value) && Number.isInteger(value.index) && (value.index as number) >= 0
    && typeof value.family === 'string' && typeof value.style === 'string'
    && (value.format === 'ttf' || value.format === 'otf')
    && typeof value.weight === 'number' && Number.isInteger(value.weight)
    && typeof value.italic === 'boolean' && typeof value.fsType === 'number'
    && typeof value.editableEmbedding === 'boolean';
}

function assertEmbeddableTrueTypeFont(bytes: ArrayBuffer, fontId: string): void {
  const view = new DataView(bytes);
  if (bytes.byteLength < 12 || view.getUint32(0) !== 0x00010000) {
    throw new EngineError('INVALID_REQUEST', `Font resource ${fontId} is not a standalone TrueType font`);
  }
  const tableCount = view.getUint16(4);
  if (12 + tableCount * 16 > bytes.byteLength) {
    throw new EngineError('INVALID_REQUEST', `Font resource ${fontId} has an incomplete table directory`);
  }
  for (let index = 0; index < tableCount; index += 1) {
    const entry = 12 + index * 16;
    if (view.getUint32(entry) !== 0x4f532f32) continue;
    const offset = view.getUint32(entry + 8);
    const length = view.getUint32(entry + 12);
    if (length < 10 || offset > bytes.byteLength - length) {
      throw new EngineError('INVALID_REQUEST', `Font resource ${fontId} has an invalid OS/2 table`);
    }
    return;
  }
  throw new EngineError('INVALID_REQUEST', `Font resource ${fontId} has no verifiable OS/2 embedding flags`);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new EngineError('CORE_UNAVAILABLE', 'Web Crypto is required to verify font resources');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameOriginUrl(value: string, base: URL, label: string): URL {
  const url = new URL(value, base);
  if (url.origin !== base.origin) {
    throw new EngineError('INVALID_REQUEST', `${label} must be loaded from the application origin`);
  }
  return url;
}

function isFontManifestEntry(value: unknown): value is FontManifestEntry {
  return isRecord(value)
    && Object.keys(value).every(key => ['id', 'family', 'style', 'format', 'url', 'sha256', 'weight', 'italic', 'licenseUrl', 'faceIndex'].includes(key))
    && (value.faceIndex === undefined || (typeof value.faceIndex === 'number' && Number.isInteger(value.faceIndex) && value.faceIndex >= 0 && value.faceIndex <= UINT32_MAX))
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.family === 'string' && value.family.length > 0
    && typeof value.style === 'string' && value.style.length > 0
    && (value.format === 'ttf' || value.format === 'otf')
    && typeof value.url === 'string' && value.url.length > 0
    && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256);
}

function pageIndexMap(pageOrder: readonly string[]): ReadonlyMap<string, number> {
  return new Map(pageOrder.map((pageId, index) => [pageId, index]));
}

function unsupported(message: string): EngineError {
  return new EngineError('UNSUPPORTED_CAPABILITY', message);
}

function assertBaseModule(module: PdfCoreEmscriptenModule): void {
  const requiredFunctions = [
    '_malloc', '_free', '_pde_abi_version', '_pde_initialize', '_pde_shutdown',
    '_pde_open_memory', '_pde_open_file_utf8', '_pde_close', '_pde_document_info',
    '_pde_describe_page', '_pde_extract_page', '_pde_render', '_pde_save_memory',
    '_pde_save_file_utf8', '_pde_binary_data', '_pde_binary_size',
    '_pde_error_code', '_pde_error_message',
  ] as const;
  if (!(module.HEAPU8 instanceof Uint8Array)
      || requiredFunctions.some((name) => typeof module[name] !== 'function')) {
    throw new EngineError('CORE_UNAVAILABLE', 'Emscripten PDF core runtime is missing required ABI exports');
  }
}

function isRect(value: unknown): boolean {
  return isRecord(value)
    && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
    && typeof value.width === 'number' && Number.isFinite(value.width) && value.width >= 0
    && typeof value.height === 'number' && Number.isFinite(value.height) && value.height >= 0;
}

function isTextRange(value: unknown): boolean {
  return Array.isArray(value)
    && value.length === 2
    && isNonNegativeInteger(value[0])
    && isNonNegativeInteger(value[1])
    && value[1] >= value[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
