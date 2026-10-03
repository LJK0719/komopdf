import { useRef, useState } from 'react';
import { WEB_LIMITS, type DocumentInfo, type EditCommand, type EngineAdapter, type HostAdapter } from '@pdf-editor/contracts';
import type { ImportPagesDialogProps, ImportPagesSource } from './ImportPagesDialog.js';
import { createPageImportCommand } from './page-import-utils.js';

type Options = {
  document: DocumentInfo | null; engine: EngineAdapter; host: HostAdapter; disabled: boolean;
  execute(commands: EditCommand[], resources?: Set<string>): Promise<boolean>;
  onBusy(busy: boolean): void; onError(message: string): void; onImported(ids: string[]): void;
};

export function usePageImport({ document, engine, host, disabled, execute, onBusy, onError, onImported }: Options) {
  const [source, setSource] = useState<ImportPagesSource | null>(null);
  const pending = useRef(false);
  const currentDocId = useRef(document?.id);
  currentDocId.current = document?.id;
  const pageLimit = host.capabilities.platform === 'web' ? WEB_LIMITS.pagesPerDocument : undefined;
  const allowed = Boolean(document?.permissions.modify && document.capabilities.includes('pages.import'));

  async function openImport(afterPageId: string | null = document?.pageOrder.at(-1) ?? null) {
    if (!document || disabled || !allowed || pending.current) return;
    pending.current = true; onBusy(true);
    const docId = document.id;
    try {
      // Unlike pickResource, pickDocument preserves the source filename on both hosts.
      const picked = await host.pickDocument();
      if (!picked || currentDocId.current !== docId) return;
      const resource = await engine.registerResource({ docId, resourceId: crypto.randomUUID(),
        source: picked.kind === 'bytes' ? { kind: 'pdf', bytes: picked.bytes } : { kind: 'native-file', handle: picked.handle } });
      if (currentDocId.current !== docId) return;
      if (resource.kind !== 'pdf' || !Number.isSafeInteger(resource.pageCount) || resource.pageCount! < 1) {
        throw new Error('Imported PDF has no pages');
      }
      setSource({ docId, resourceId: resource.id, name: picked.name, pageCount: resource.pageCount!, afterPageId });
    } catch (error) {
      if (currentDocId.current === docId) onError(error instanceof Error ? error.message : String(error));
    } finally { pending.current = false; onBusy(false); }
  }

  async function importPages(range: string, afterPageId: string | null): Promise<boolean> {
    if (!source || !document || source.docId !== document.id || disabled || !allowed || pending.current) return false;
    const command = createPageImportCommand(source.resourceId, source.pageCount, range, afterPageId, document.pageOrder, pageLimit);
    pending.current = true; onBusy(true);
    try {
      const committed = await execute([command], new Set([source.resourceId]));
      if (committed && currentDocId.current === source.docId) { onImported(command.newPageIds); setSource(null); }
      return committed;
    } finally { pending.current = false; onBusy(false); }
  }

  const importDialogProps: ImportPagesDialogProps = {
    source: source?.docId === document?.id ? source : null,
    pageOrder: document?.pageOrder ?? [], disabled: disabled || !allowed, pageLimit,
    onClose: () => { if (!pending.current) setSource(null); }, onImport: importPages,
  };
  return { openImport, importDialogProps };
}
