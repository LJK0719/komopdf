import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { EditCommand, EngineAdapter, HostAdapter } from '@pdf-editor/contracts';
import type { LoadedDocument } from './EditorShell.js';
import { PageThumbnail } from './PageThumbnail.js';
import { movePages, selectPages, type SelectionModifiers } from './page-selection.js';
import { useI18n } from './i18n.js';

export type PageAction = 'copyPages' | 'pastePages' | 'extractPages' | 'duplicatePage' | 'deletePage' | 'rotatePageLeft' | 'rotatePageRight' | 'blankPage' | 'blankPageBefore' | 'importPages' | 'movePagesStart' | 'movePagesEnd';
type Options = {
  document: LoadedDocument | null; engine: EngineAdapter; host: HostAdapter; disabled: boolean;
  execute(commands: EditCommand[], resources?: Set<string>): Promise<boolean>;
  onBusy(busy: boolean): void; onError(message: string): void; onNotice(message: string): void;
};

export function usePageTools({ document, engine, host, disabled, execute, onBusy, onError, onNotice }: Options) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[]>([]);
  const [focus, setFocus] = useState('');
  const anchor = useRef('');
  const [clipboard, setClipboard] = useState<{ docId: string; resourceId: string; count: number } | null>(null);
  const order = document?.info.pageOrder ?? [];
  const ids = order.filter(id => selected.includes(id));
  useEffect(() => {
    const id = document?.page.id ?? '';
    setSelected(id ? [id] : []); setFocus(id); anchor.current = id; setClipboard(null);
  }, [document?.info.id]);
  useEffect(() => {
    setSelected(previous => {
      const kept = previous.filter(id => order.includes(id));
      return kept.length || !document ? kept : [document.page.id];
    });
    if (!order.includes(focus)) setFocus(document?.page.id ?? '');
  }, [document?.info.revision]);
  const select = (id: string, modifiers: SelectionModifiers = {}, context = false) => {
    if (disabled) return;
    setFocus(id);
    if (context && ids.includes(id)) return;
    setSelected(previous => selectPages(order, previous, anchor.current || id, id, modifiers));
    if (!modifiers.shiftKey) anchor.current = id;
  };
  const can = (action: PageAction) => {
    if (!document || disabled) return false;
    const { permissions, capabilities } = document.info;
    if (action === 'copyPages' || action === 'extractPages') return Boolean(ids.length && permissions.copy && engine.extractPages);
    if (!permissions.modify) return false;
    if (action === 'pastePages') return clipboard?.docId === document.info.id && capabilities.includes('pages.import');
    if (action === 'deletePage') return ids.length > 0 && ids.length < order.length && capabilities.includes('pages.delete');
    if (action === 'duplicatePage') return ids.length > 0 && permissions.copy && capabilities.includes('pages.duplicate');
    if (action === 'rotatePageLeft' || action === 'rotatePageRight') return ids.length > 0 && capabilities.includes('pages.rotate');
    if (action === 'movePagesStart' || action === 'movePagesEnd') return ids.length > 0 && ids.length < order.length && capabilities.includes('pages.reorder');
    if (action === 'importPages') return Boolean(host.pickResource && capabilities.includes('pages.import'));
    return capabilities.includes('pages.insert');
  };
  const run = async (action: PageAction) => {
    if (!document || !can(action)) return;
    const { info, page } = document;
    const afterPageId = ids.at(-1) ?? page.id;
    if (action === 'deletePage') { await execute([{ type: 'pages.delete', pageIds: ids }]); return; }
    if (action === 'rotatePageLeft' || action === 'rotatePageRight') {
      await execute([{ type: 'pages.rotate', pageIds: ids, degrees: action === 'rotatePageLeft' ? 270 : 90 }]); return;
    }
    if (action === 'movePagesStart' || action === 'movePagesEnd') {
      const rest = order.filter(id => !ids.includes(id));
      await execute([{ type: 'pages.reorder', pageIds: action === 'movePagesStart' ? [...ids, ...rest] : [...rest, ...ids] }]); return;
    }
    if (action === 'duplicatePage') {
      const newPageIds = ids.map(() => crypto.randomUUID());
      if (await execute([{ type: 'pages.duplicate', pageIds: ids, newPageIds, afterPageId }])) setSelected(newPageIds);
      return;
    }
    if (action === 'blankPage' || action === 'blankPageBefore') {
      const pageId = crypto.randomUUID();
      const after = action === 'blankPageBefore' ? order[order.indexOf(ids[0] ?? page.id) - 1] ?? null : afterPageId;
      if (await execute([{ type: 'pages.insert', pageId, afterPageId: after, widthPt: page.widthPt, heightPt: page.heightPt }])) setSelected([pageId]);
      return;
    }
    if (action === 'pastePages' && clipboard) {
      const newPageIds = Array.from({ length: clipboard.count }, () => crypto.randomUUID());
      if (await execute([{ type: 'pages.import', resourceId: clipboard.resourceId, pageIndices: newPageIds.map((_, i) => i), newPageIds, afterPageId }], new Set([clipboard.resourceId]))) setSelected(newPageIds);
      return;
    }
    onBusy(true);
    try {
      if (action === 'importPages') {
        const source = await host.pickResource?.('pdf');
        if (!source) return;
        const resource = await engine.registerResource({ docId: info.id, resourceId: crypto.randomUUID(), source });
        const newPageIds = Array.from({ length: resource.pageCount ?? 0 }, () => crypto.randomUUID());
        if (newPageIds.length && await execute([{ type: 'pages.import', resourceId: resource.id, pageIndices: newPageIds.map((_, i) => i), newPageIds, afterPageId }], new Set([resource.id]))) setSelected(newPageIds);
      } else {
        const result = await engine.extractPages!({ docId: info.id, pageIds: ids });
        if (action === 'extractPages') {
          const outcome = await host.saveDocument({ ...result, savedRevision: result.sourceRevision }, document.name.replace(/\.pdf$/i, '') + '-pages.pdf');
          onNotice(t(outcome?.status === 'download-started' ? 'Selected pages download started.' : 'Selected pages exported.'));
        } else {
          const resource = await engine.registerResource({ docId: info.id, resourceId: crypto.randomUUID(), source: result.kind === 'bytes' ? { kind: 'pdf', bytes: result.bytes } : { kind: 'native-file', handle: result.handle } });
          setClipboard({ docId: info.id, resourceId: resource.id, count: ids.length });
          onNotice(t('Pages copied. Paste them anywhere in this PDF.'));
        }
      }
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { onBusy(false); }
  };
  const reorder = async (moving: string[], target: string, after: boolean) => {
    if (!document || disabled || !document.info.permissions.modify || !document.info.capabilities.includes('pages.reorder')) return;
    const next = movePages(order, moving, target, after);
    if (next.some((id, index) => id !== order[index])) await execute([{ type: 'pages.reorder', pageIds: next }]);
  };
  return { ids, focus, select, selectAll: () => setSelected([...order]), can, run, reorder };
}
export type PageTools = ReturnType<typeof usePageTools>;

export function PageContextMenu({ tools, onOpen, children }: { tools: PageTools; onOpen(): void; children: ReactNode }) {
  const { t } = useI18n();
  const item = (action: PageAction, label: string, shortcut?: string) => <ContextMenu.Item className="ui-menu-item" disabled={!tools.can(action)} onClick={() => void tools.run(action)}>{t(label)}{shortcut && <kbd>{shortcut}</kbd>}</ContextMenu.Item>;
  return <ContextMenu.Root>{children}<ContextMenu.Portal><ContextMenu.Positioner><ContextMenu.Popup className="ui-menu">
    <ContextMenu.Item className="ui-menu-item" onClick={onOpen}>{t('Open page')}</ContextMenu.Item>
    <ContextMenu.Separator className="ui-menu-separator" />
    {item('copyPages', 'Copy pages', 'Ctrl/Cmd C')}{item('pastePages', 'Paste pages', 'Ctrl/Cmd V')}
    {item('duplicatePage', 'Duplicate pages')}{item('extractPages', 'Extract selected pages')}
    <ContextMenu.Separator className="ui-menu-separator" />
    {item('blankPageBefore', 'Insert blank page before')}{item('blankPage', 'Insert blank page after')}{item('importPages', 'Insert from PDF')}
    {item('rotatePageLeft', 'Rotate left')}{item('rotatePageRight', 'Rotate right')}
    {item('movePagesStart', 'Move to beginning')}{item('movePagesEnd', 'Move to end')}
    <ContextMenu.Separator className="ui-menu-separator" />
    <ContextMenu.Item className="ui-menu-item" onClick={tools.selectAll}>{t('Select all pages')}<kbd>Ctrl/Cmd A</kbd></ContextMenu.Item>
    {item('deletePage', 'Delete selected pages', 'Del')}
  </ContextMenu.Popup></ContextMenu.Positioner></ContextMenu.Portal></ContextMenu.Root>;
}

export function PageOrganizer({ document, engine, tools, disabled, width, columns, onOpen }: {
  document: LoadedDocument; engine: EngineAdapter; tools: PageTools; disabled: boolean;
  width: number; columns: number; onOpen(id: string): void;
}) {
  const { t } = useI18n();
  const grid = useRef<HTMLDivElement>(null);
  const dragging = useRef<string[]>([]);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  return <div className="page-organizer">
    <div className="organizer-heading"><strong>{t('Organize pages')}</strong><span>{t('{count} pages selected', { count: tools.ids.length })}</span>
      <small>{t('Ctrl/Cmd: select multiple · Shift: select range · Drag to reorder')}</small></div>
    <div ref={grid} role="listbox" aria-label={t('Page overview')} aria-multiselectable="true" className="page-overview"
      style={{ '--page-tile-width': `${width}px`, gridTemplateColumns: columns ? `repeat(${columns}, minmax(0, 1fr))` : undefined } as CSSProperties}
      onKeyDown={event => {
        if (disabled || (event.target as HTMLElement).closest('[role="menu"]')) return;
        const order = document.info.pageOrder;
        const index = Math.max(0, order.indexOf(tools.focus));
        const nodes = [...(grid.current?.querySelectorAll<HTMLElement>('[data-organizer-page]') ?? [])];
        const cols = nodes.filter(node => node.offsetTop === nodes[0]?.offsetTop).length || 1;
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? cols : event.key === 'ArrowUp' ? -cols : 0;
        if (step || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : Math.max(0, Math.min(order.length - 1, index + step));
          tools.select(order[next]!, event); nodes[next]?.focus();
        } else if (event.key === 'Enter') { event.preventDefault(); onOpen(order[index]!); }
        else if (event.key === ' ') { event.preventDefault(); tools.select(order[index]!, { ctrlKey: true, shiftKey: event.shiftKey }); }
      }}>
      {document.info.pageOrder.map((id, index) => <PageContextMenu key={id} tools={tools} onOpen={() => onOpen(id)}>
        <ContextMenu.Trigger render={<div />} role="option" tabIndex={id === tools.focus ? 0 : -1} aria-selected={tools.ids.includes(id)}
          aria-disabled={disabled} aria-label={t('Page {page}', { page: index + 1 })} data-organizer-page={id}
          className={`organizer-page ${drop?.id === id ? drop.after ? 'drop-after' : 'drop-before' : ''}`}
          onClick={event => tools.select(id, event)} onDoubleClick={() => { if (!disabled) onOpen(id); }}
          onContextMenu={() => tools.select(id, {}, true)} draggable={!disabled && document.info.permissions.modify}
          onDragStart={event => {
            dragging.current = tools.ids.includes(id) ? tools.ids : [id];
            if (!tools.ids.includes(id)) tools.select(id);
            event.dataTransfer.setData('application/x-komopdf-pages', JSON.stringify(dragging.current)); event.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={event => {
            if (!dragging.current.length || disabled) return;
            event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
            const rect = event.currentTarget.getBoundingClientRect(); setDrop({ id, after: event.clientX > rect.left + rect.width / 2 });
          }}
          onDrop={event => {
            if (!dragging.current.length) return;
            event.preventDefault(); event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            void tools.reorder(dragging.current, id, event.clientX > rect.left + rect.width / 2);
            dragging.current = []; setDrop(null);
          }} onDragEnd={() => { dragging.current = []; setDrop(null); }}>
          <div className="organizer-preview"><PageThumbnail engine={engine} docId={document.info.id} pageId={id} revision={document.info.revision} scale={0.5} /></div>
          <span className="organizer-page-label"><span aria-hidden="true" className="page-selection-check">{tools.ids.includes(id) ? '✓' : ''}</span>{index + 1}</span>
        </ContextMenu.Trigger>
      </PageContextMenu>)}
    </div>
  </div>;
}
