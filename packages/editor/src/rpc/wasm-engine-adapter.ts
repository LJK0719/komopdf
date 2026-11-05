import {
  EngineError,
  WEB_LIMITS,
  type CommitResult,
  type DocumentInfo,
  type DocumentSource,
  type EditTransaction,
  type EngineAdapter,
  type ExtractionRequest,
  type ExtractPagesRequest, type ExtractPagesResult,
  type PageMetrics, type PageModel,
  type RenderOptions, type RenderRequest,
  type RenderResult,
  type SaveRequest,
  type SaveResult,
  type TextBlock,
  type TextLayoutRequest,
  type TextLayoutResult, type TextInsertLayoutRequest,
  type WorkerHandshake,
  type RegisterResourceRequest, type ResourceInfo, type TransactionPreviewResult, type SaveConfirmation,
  type FontSource, type FontFaceInfo, type RegisterFontRequest, type RegisteredFontInfo,
  type FormFieldInfo, type PdfAnnotationInfo, type OutlineEntry,
  type RecoverySnapshot, type RestoreRecoveryRequest,
} from '@pdf-editor/contracts';
import { WorkerRpcClient } from './client.js';
import { PageCache } from './page-cache.js';

export class WasmEngineAdapter implements EngineAdapter {
  private readonly pages = new PageCache();
  getPageVersion(docId: string, pageId: string): number { return this.pages.version(docId, pageId); }
  private readonly pageOrders = new Map<string, string[]>();
  private readonly sourceSizes = new Map<string, number>();
  private retainedSourceBytes = 0;
  private pendingOpens = 0;

  constructor(private readonly rpc: WorkerRpcClient) {}

  initialize(): Promise<WorkerHandshake> {
    return this.rpc.handshake();
  }

  async open(source: DocumentSource, password?: string): Promise<DocumentInfo> {
    if (source.kind !== 'bytes') throw new EngineError('INVALID_REQUEST', 'Web documents require local bytes');
    const size = source.bytes.byteLength;
    if (size > WEB_LIMITS.inputBytes || this.retainedSourceBytes + size > WEB_LIMITS.retainedSourceBytes
        || this.pageOrders.size + this.pendingOpens >= WEB_LIMITS.openDocuments) {
      throw new EngineError('RESOURCE_LIMIT', 'Web document/source budget exceeded; close another document or use the desktop app');
    }
    this.pendingOpens += 1; this.retainedSourceBytes += size;
    let retained = false;
    try {
      const info = await this.rpc.call<DocumentInfo>('open', password === undefined ? [source] : [source, password], [source.bytes]);
      const totalPages = [...this.pageOrders.values()].reduce((total, pages) => total + pages.length, info.pageOrder.length);
      if (info.pageOrder.length > WEB_LIMITS.pagesPerDocument || totalPages > WEB_LIMITS.totalPages) {
        await this.rpc.call<void>('close', [info.id]).catch(() => undefined);
        throw new EngineError('RESOURCE_LIMIT', `Web version supports up to ${WEB_LIMITS.pagesPerDocument} pages per document and ${WEB_LIMITS.totalPages} pages per session.`);
      }
      this.pages.close(info.id);
      this.pageOrders.set(info.id, info.pageOrder);
      this.sourceSizes.set(info.id, size); retained = true;
      return info;
    } finally {
      this.pendingOpens -= 1;
      if (!retained) this.retainedSourceBytes -= size;
    }
  }

  describePageMetrics(docId: string, pageId: string): Promise<PageMetrics> {
    return this.pages.metrics(docId, pageId, async () => {
      const value = await this.rpc.call<PageMetrics>('describePageMetrics', [docId, pageId]);
      if (!value || value.id !== pageId
          || !Number.isFinite(value.widthPt) || value.widthPt <= 0
          || !Number.isFinite(value.heightPt) || value.heightPt <= 0
          || ![0, 90, 180, 270].includes(value.rotation)) {
        throw new EngineError('CORE_UNAVAILABLE', 'PDF worker returned invalid page geometry');
      }
      return { id: value.id, widthPt: value.widthPt, heightPt: value.heightPt, rotation: value.rotation };
    });
  }

  describePage(docId: string, pageId: string): Promise<PageModel> {
    return this.pages.describe(docId, pageId, () => this.rpc.call<PageModel>('describePage', [docId, pageId]));
  }

  describeForms(docId: string): Promise<FormFieldInfo[]> {
    return this.rpc.call<FormFieldInfo[]>('describeForms', [docId]);
  }

  describeAnnotations(docId: string, pageId: string): Promise<PdfAnnotationInfo[]> {
    return this.rpc.call<PdfAnnotationInfo[]>('describeAnnotations', [docId, pageId]);
  }

  describeOutline(docId: string): Promise<OutlineEntry[]> {
    return this.rpc.call<OutlineEntry[]>('describeOutline', [docId]);
  }

  describeFonts(docId: string): Promise<RegisteredFontInfo[]> {
    return this.rpc.call<RegisteredFontInfo[]>('describeFonts', [docId]);
  }

  async render(request: RenderRequest, options: RenderOptions = {}): Promise<RenderResult> {
    if (options.signal?.aborted) throw new EngineError('CANCELLED', 'PDF rendering was cancelled');
    const page = await this.describePageMetrics(request.docId, request.pageId);
    if (options.signal?.aborted) throw new EngineError('CANCELLED', 'PDF rendering was cancelled');
    assertRenderBudget(request, page);
    const result = await this.rpc.call<RenderResult>('render', [request], [], options);
    if (result.width * result.height > WEB_LIMITS.renderPixels) {
      throw new EngineError(
        'RESOURCE_LIMIT',
        `Web version rendered bitmap cannot exceed ${WEB_LIMITS.renderPixels.toLocaleString()} pixels.`,
      );
    }
    return result;
  }

  extract(request: ExtractionRequest): Promise<TextBlock[]> {
    return this.rpc.call<TextBlock[]>('extract', [request]);
  }

  previewText(request: TextLayoutRequest): Promise<TextLayoutResult> {
    return this.rpc.call<TextLayoutResult>('previewText', [request]);
  }

  previewTextInsert(request: TextInsertLayoutRequest): Promise<TextLayoutResult> {
    return this.rpc.call('previewTextInsert', [request]);
  }

  inspectFont(source: FontSource): Promise<FontFaceInfo[]> {
    if (source.kind !== 'bytes') return Promise.reject(new EngineError('INVALID_REQUEST', 'Web fonts require local bytes'));
    // Inspection must not detach bytes still needed for the selected face's registration.
    return this.rpc.call('inspectFont', [source]);
  }

  registerFont(request: RegisterFontRequest): Promise<RegisteredFontInfo> {
    if (request.source.kind !== 'bytes') return Promise.reject(new EngineError('INVALID_REQUEST', 'Web fonts require local bytes'));
    return this.rpc.call('registerFont', [request]);
  }

  registerResource(request: RegisterResourceRequest): Promise<ResourceInfo> {
    const source = request.source;
    if (source.kind === 'native-file') return Promise.reject(new EngineError('INVALID_REQUEST', 'Web resources must contain local bytes'));
    return this.rpc.call('registerResource', [request], [source.bytes]);
  }

  async previewTransaction(transaction: EditTransaction): Promise<TransactionPreviewResult> {
    const preview = await this.rpc.call<TransactionPreviewResult>('previewTransaction', [transaction]);
    if (preview.pageOrder.length > WEB_LIMITS.pagesPerDocument) throw new EngineError('RESOURCE_LIMIT', 'Working document exceeds the web page limit');
    return preview;
  }

  confirmSave(request: SaveConfirmation): Promise<DocumentInfo> {
    return this.rpc.call('confirmSave', [request]);
  }

  async apply(transaction: EditTransaction): Promise<CommitResult> {
    const pageIds = new Set(this.pageOrders.get(transaction.docId));
    for (const command of transaction.commands) {
      if (command.type === 'pages.insert') pageIds.add(command.pageId);
      if (command.type === 'pages.duplicate' || command.type === 'pages.import') command.newPageIds.forEach(id => pageIds.add(id));
      if (command.type === 'pages.delete') command.pageIds.forEach(id => pageIds.delete(id));
      if (pageIds.size > WEB_LIMITS.pagesPerDocument) throw new EngineError('RESOURCE_LIMIT', 'Working document exceeds the web page limit');
    }
    const result = await this.rpc.call<CommitResult>('apply', [transaction]);
    this.invalidatePages(result);
    return result;
  }

  async undo(docId: string): Promise<CommitResult> {
    const result = await this.rpc.call<CommitResult>('undo', [docId]);
    this.invalidatePages(result);
    return result;
  }

  async redo(docId: string): Promise<CommitResult> {
    const result = await this.rpc.call<CommitResult>('redo', [docId]);
    this.invalidatePages(result);
    return result;
  }

  private invalidatePages(result: CommitResult): void {
    this.pageOrders.set(result.docId, result.pageOrder);
    this.pages.commit(result);
  }

  save(request: SaveRequest): Promise<SaveResult> {
    return this.rpc.call<SaveResult>('save', [request]);
  }

  extractPages(request: ExtractPagesRequest): Promise<ExtractPagesResult> {
    const pageOrder = this.pageOrders.get(request.docId);
    if (!pageOrder || !Array.isArray(request.pageIds) || !request.pageIds.length ||
      request.pageIds.some(id => !pageOrder.includes(id))) {
      throw new EngineError('INVALID_REQUEST', 'Select existing PDF pages to extract');
    }
    return this.rpc.call<ExtractPagesResult>('extractPages', [request]);
  }

  exportRecovery(docId: string): Promise<RecoverySnapshot> {
    return this.rpc.call<RecoverySnapshot>('exportRecovery', [docId]);
  }

  async restoreRecovery(request: RestoreRecoveryRequest): Promise<DocumentInfo> {
    if (request.source.kind !== 'bytes') {
      throw new EngineError('INVALID_REQUEST', 'Web documents require local bytes');
    }
    if (this.pageOrders.size + this.pendingOpens >= WEB_LIMITS.openDocuments) {
      throw new EngineError('RESOURCE_LIMIT', 'Web open document budget exceeded; close another document or use the desktop app');
    }
    this.pendingOpens += 1;
    try {
      const info = await this.rpc.call<DocumentInfo>('restoreRecovery', [request], [request.source.bytes]);
      const sourceBytes = info.sourceBytes;
      if (typeof sourceBytes !== 'number' || !Number.isSafeInteger(sourceBytes) || sourceBytes <= 0) {
        await this.rpc.call<void>('close', [info.id]).catch(() => undefined);
        throw new EngineError('CORE_UNAVAILABLE', 'Recovered document metadata has no valid source byte count');
      }
      const totalPages = [...this.pageOrders.values()].reduce((total, pages) => total + pages.length, info.pageOrder.length);
      if (info.pageOrder.length > WEB_LIMITS.pagesPerDocument || totalPages > WEB_LIMITS.totalPages) {
        await this.rpc.call<void>('close', [info.id]).catch(() => undefined);
        throw new EngineError('RESOURCE_LIMIT', `Web version supports up to ${WEB_LIMITS.pagesPerDocument} pages per document and ${WEB_LIMITS.totalPages} pages per session.`);
      }
      if (sourceBytes > WEB_LIMITS.inputBytes || this.retainedSourceBytes + sourceBytes > WEB_LIMITS.retainedSourceBytes) {
        await this.rpc.call<void>('close', [info.id]).catch(() => undefined);
        throw new EngineError('RESOURCE_LIMIT', 'Recovered document source budget exceeded; close another document or use the desktop app');
      }
      this.pages.close(info.id);
      this.pageOrders.set(info.id, info.pageOrder);
      this.sourceSizes.set(info.id, sourceBytes);
      this.retainedSourceBytes += sourceBytes;
      return info;
    } finally {
      this.pendingOpens -= 1;
    }
  }

  async close(docId: string): Promise<void> {
    this.pages.close(docId);
    await this.rpc.call<void>('close', [docId]);
    this.pageOrders.delete(docId);
    this.retainedSourceBytes -= this.sourceSizes.get(docId) ?? 0;
    this.sourceSizes.delete(docId);
  }

  dispose(): void {
    this.pages.clear();
    this.pageOrders.clear();
    this.sourceSizes.clear();
    this.retainedSourceBytes = 0;
    this.rpc.dispose();
  }
}

function assertRenderBudget(request: RenderRequest, page: PageMetrics): void {
  if (!Number.isFinite(request.scale) || request.scale <= 0) {
    throw new EngineError('INVALID_REQUEST', 'Render scale must be a positive number');
  }
  const clip = request.clip;
  if (clip && (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)
      || clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0
      || clip.x + clip.width > page.widthPt + 1e-6 || clip.y + clip.height > page.heightPt + 1e-6)) {
    throw new EngineError('INVALID_REQUEST', 'Render clip must be inside normalized page bounds');
  }
  const fullWidth = Math.ceil(page.widthPt * request.scale), fullHeight = Math.ceil(page.heightPt * request.scale);
  const width = clip ? Math.min(fullWidth, Math.ceil((clip.x + clip.width) * request.scale)) - Math.floor(clip.x * request.scale) : fullWidth;
  const height = clip ? Math.min(fullHeight, Math.ceil((clip.y + clip.height) * request.scale)) - Math.floor(clip.y * request.scale) : fullHeight;
  const estimatedPixels = width * height;
  if (!Number.isFinite(estimatedPixels) || estimatedPixels > WEB_LIMITS.renderPixels) {
    throw new EngineError(
      'RESOURCE_LIMIT',
      `Current scale estimated to produce ${Math.max(0, estimatedPixels).toLocaleString()} pixels, exceeding web version single bitmap budget.`,
    );
  }
}
