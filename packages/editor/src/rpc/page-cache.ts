import { EngineError, type CommitResult, type PageModel } from '@pdf-editor/contracts';

type Entry = { version: number; model?: PageModel; pending?: Promise<PageModel> };

/** Derived engine results only; transaction revisions remain owned by the engine. */
export class PageCache {
  private documents = new Map<string, Map<string, Entry>>();
  private sequence = 0;

  private entry(docId: string, pageId: string): Entry {
    let pages = this.documents.get(docId);
    if (!pages) { pages = new Map(); this.documents.set(docId, pages); }
    let entry = pages.get(pageId);
    if (!entry) { entry = { version: ++this.sequence }; pages.set(pageId, entry); }
    return entry;
  }

  version(docId: string, pageId: string): number { return this.entry(docId, pageId).version; }

  describe(docId: string, pageId: string, load: () => Promise<PageModel>): Promise<PageModel> {
    const entry = this.entry(docId, pageId);
    if (entry.model) return Promise.resolve(entry.model);
    if (entry.pending) return entry.pending;
    const pending = load().then(model => {
      if (this.documents.get(docId)?.get(pageId) !== entry) {
        throw new EngineError('STALE_REVISION', 'Page changed while loading');
      }
      entry.model = model;
      return model;
    }).finally(() => { delete entry.pending; });
    entry.pending = pending;
    return pending;
  }

  commit(result: CommitResult): void {
    const pages = this.documents.get(result.docId);
    if (!pages) return;
    const changed = new Set(result.changedPageIds), retained = new Set(result.pageOrder);
    for (const id of pages.keys()) {
      if (changed.has(id) || !retained.has(id)) pages.delete(id);
    }
  }

  close(docId: string): void { this.documents.delete(docId); }
  clear(): void { this.documents.clear(); }
}
