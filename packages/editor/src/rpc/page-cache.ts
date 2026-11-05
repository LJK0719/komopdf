import { EngineError, type CommitResult, type PageMetrics, type PageModel } from '@pdf-editor/contracts';

type Entry = { version: number; metrics?: PageMetrics; metricsPending?: Promise<PageMetrics>; model?: PageModel; pending?: Promise<PageModel> };
const metricsOf = (page: PageMetrics): PageMetrics => ({ id: page.id, widthPt: page.widthPt, heightPt: page.heightPt, rotation: page.rotation });

function modelBytes(model: PageModel): number {
  let bytes = 128;
  for (const object of model.objects) {
    bytes += 256 + object.id.length * 2 + object.locator.containerPath.length * 8;
    const text = object.textBlock;
    if (!text) continue;
    bytes += 256 + (text.characters?.length ?? 0) * 96 + (text.inferredSpaces?.length ?? 0) * 8;
    for (const run of [...text.runs, ...(text.flow?.runs ?? [])]) {
      bytes += 128 + run.text.length * 2;
      for (const id of run.sourceObjectIds) bytes += id.length * 2;
    }
  }
  return bytes;
}

/** Evict derived payloads, never the page-content token or transaction history. */
export class PageCache {
  private documents = new Map<string, Map<string, Entry>>();
  private sequence = 0;
  private models = new Map<Entry, number>();
  private bytes = 0;

  constructor(private readonly maxPages = 32, private readonly maxBytes = 16 * 1024 * 1024) {}

  private entry(docId: string, pageId: string): Entry {
    let pages = this.documents.get(docId);
    if (!pages) { pages = new Map(); this.documents.set(docId, pages); }
    let entry = pages.get(pageId);
    if (!entry) { entry = { version: ++this.sequence }; pages.set(pageId, entry); }
    return entry;
  }

  private release(entry: Entry): void {
    this.bytes -= this.models.get(entry) ?? 0;
    this.models.delete(entry);
    delete entry.model;
  }

  private remember(entry: Entry, model: PageModel): void {
    this.release(entry);
    const bytes = modelBytes(model);
    if (this.maxPages <= 0 || bytes > this.maxBytes) return;
    entry.model = model;
    this.models.set(entry, bytes); this.bytes += bytes;
    while (this.models.size > this.maxPages || this.bytes > this.maxBytes) this.release(this.models.keys().next().value!);
  }

  version(docId: string, pageId: string): number { return this.entry(docId, pageId).version; }

  metrics(docId: string, pageId: string, load: () => Promise<PageMetrics>): Promise<PageMetrics> {
    const entry = this.entry(docId, pageId);
    if (entry.metrics) return Promise.resolve(entry.metrics);
    if (entry.metricsPending) return entry.metricsPending;
    const pending = load().then(page => {
      if (this.documents.get(docId)?.get(pageId) !== entry) throw new EngineError('STALE_REVISION', 'Page changed while loading');
      entry.metrics = metricsOf(page);
      return entry.metrics;
    }).finally(() => { delete entry.metricsPending; });
    entry.metricsPending = pending;
    return pending;
  }

  describe(docId: string, pageId: string, load: () => Promise<PageModel>): Promise<PageModel> {
    const entry = this.entry(docId, pageId);
    if (entry.model) {
      const bytes = this.models.get(entry)!;
      this.models.delete(entry); this.models.set(entry, bytes);
      return Promise.resolve(entry.model);
    }
    if (entry.pending) return entry.pending;
    const pending = load().then(model => {
      if (this.documents.get(docId)?.get(pageId) !== entry) throw new EngineError('STALE_REVISION', 'Page changed while loading');
      entry.metrics = metricsOf(model);
      this.remember(entry, model);
      return model;
    }).finally(() => { delete entry.pending; });
    entry.pending = pending;
    return pending;
  }

  commit(result: CommitResult): void {
    const pages = this.documents.get(result.docId);
    if (!pages) return;
    const changed = new Set(result.changedPageIds), retained = new Set(result.pageOrder);
    for (const [id, entry] of pages) {
      if (changed.has(id) || !retained.has(id)) { this.release(entry); pages.delete(id); }
    }
  }

  close(docId: string): void {
    for (const entry of this.documents.get(docId)?.values() ?? []) this.release(entry);
    this.documents.delete(docId);
  }
  clear(): void { this.documents.clear(); this.models.clear(); this.bytes = 0; }
}
