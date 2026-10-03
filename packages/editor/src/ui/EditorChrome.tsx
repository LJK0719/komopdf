import { useId, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Tooltip } from '@base-ui/react/tooltip';
import { ArrowDownToLine, Bookmark, ChevronDown, ChevronLeft, ChevronRight, FilePlus2, FolderOpen, Languages, Maximize, MoveHorizontal, Minus, PanelLeft, PanelRightClose, Plus, Printer, Redo2, Save, Search, Sparkles, Type, Undo2, X, LayoutGrid, MessageSquare, PenLine, ScanText, ListChecks } from 'lucide-react';
import { useI18n, translate as t, type UiLocale } from './i18n.js';
import { MIN_VIEW_ZOOM, MAX_VIEW_ZOOM, clampViewZoom, formatZoomPercent, parseZoomPercent, type ViewZoomMode } from './view-zoom.js';

export type EditorTool = 'arrange' | 'edit' | 'pages' | 'comment' | 'forms' | 'sign' | 'ocr' | 'ai' | 'search' | 'export' | 'print' | 'fonts';
export const toolNames: Record<EditorTool, string> = {
  arrange: 'Arrange objects', edit: 'Edit', pages: 'Organize pages', comment: 'Comment', forms: 'Fill & forms', sign: 'Sign',
  ocr: 'Recognize text', ai: 'AI assistant', search: 'Find in document', export: 'Export PDF', print: 'Print', fonts: 'Fonts',
};

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n();
  return <label className="language-select"><Languages aria-hidden="true" size={16} />
    <select aria-label={t('Language')} value={locale} onChange={event => setLocale(event.target.value as UiLocale)}>
      <option value="en">English</option><option value="zh-CN">简体中文</option>
    </select>
  </label>;
}

export function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  useI18n();
  return <Tooltip.Root><Tooltip.Trigger render={<button type="button" className="icon-button" aria-label={t(label)} {...props} />}>{children}</Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Positioner sideOffset={8}><Tooltip.Popup className="ui-tooltip">{t(label)}</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root>;
}

export function EditorTopbar({ productName = 'komopdf', name, dirty, busy, canUndo, canRedo, saving, tool, onTool, onOpen, onClose, onSave, onSaveAs, onUndo, onRedo, extra, showAi = false }: {
  showAi?: boolean; productName?: string; name: string | undefined; dirty: boolean; busy: boolean; canUndo: boolean; canRedo: boolean; saving: boolean;
  tool: EditorTool | null; onTool(tool: EditorTool): void; onOpen(): void; onClose(): void; onSave(): void; onSaveAs?(): void; onUndo(): void; onRedo(): void; extra?: ReactNode;
}) {
  const { t } = useI18n();
  return <header className="editor-topbar">
    <div className="topbar-start"><span className="brand-lockup"><span className="brand-mark" aria-hidden="true">k</span><strong>{productName}</strong></span>
      <Menu.Root><Menu.Trigger className="file-menu-trigger">{t('File')}<ChevronDown size={14} /></Menu.Trigger>
        <Menu.Portal><Menu.Positioner sideOffset={8}><Menu.Popup className="ui-menu">
          <Menu.Item className="ui-menu-item" onClick={onOpen} disabled={busy}><FolderOpen size={16} />{t('Open…')}<kbd>Ctrl O</kbd></Menu.Item>
          <Menu.Item className="ui-menu-item" onClick={onSave} disabled={!name || busy}><Save size={16} />{t('Save')}<kbd>Ctrl S</kbd></Menu.Item>
          {onSaveAs && <Menu.Item className="ui-menu-item" onClick={onSaveAs} disabled={!name || busy}><Save size={16} />{t('Save as…')}<kbd>Ctrl Shift S</kbd></Menu.Item>}
          <Menu.Item className="ui-menu-item" onClick={() => onTool('export')} disabled={!name || busy}><ArrowDownToLine size={16} />{t('Export…')}</Menu.Item>
          <Menu.Item className="ui-menu-item" onClick={() => onTool('print')} disabled={!name || busy}><Printer size={16} />{t('Print…')}<kbd>Ctrl P</kbd></Menu.Item>
          <Menu.Separator className="ui-separator" />
          <Menu.Item className="ui-menu-item" onClick={onClose} disabled={!name || busy}><X size={16} />{t('Close document')}</Menu.Item>
        </Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root>
      <span className="toolbar-divider" />
      <IconButton label={t('Undo (Ctrl Z)')} disabled={!canUndo || busy} onClick={onUndo}><Undo2 size={18} /></IconButton>
      <IconButton label={t('Redo (Ctrl Shift Z)')} disabled={!canRedo || busy} onClick={onRedo}><Redo2 size={18} /></IconButton>
    </div>
    <div className="document-title" title={name}><strong>{name ?? t('Your PDF workspace')}</strong>{name && <span className={dirty ? 'save-state unsaved' : 'save-state'}>{t(dirty ? "Unsaved changes" : "Saved")}</span>}</div>
    <div className="topbar-actions"><LanguageSelect />{extra}
      <IconButton label={t('Find (Ctrl F)')} disabled={!name} onClick={() => onTool('search')}><Search size={18} /></IconButton>
      <button className="button button-primary" type="button" onClick={onSave} disabled={!name || busy}><Save size={16} />{t(saving ? "Saving…" : "Save")}</button>
      {showAi && <button className={`button assistant-button ${tool === 'ai' ? 'is-active' : ''}`} aria-label={t('Ask komo')} type="button" onClick={() => onTool('ai')}><Sparkles size={16} /><span>{t('Ask komo')}</span></button>}
    </div>
  </header>;
}

export function EditorToolbar({ tool, onTool, hasDocument, ocr, locked, onOpen, railOpen, onToggleRail }: {
  tool: EditorTool | null; onTool(tool: EditorTool): void; hasDocument: boolean; ocr: boolean; locked: boolean; onOpen(): void; railOpen: boolean; onToggleRail(): void;
}) {
  const { t } = useI18n();
  const tools = [{ id: 'edit', icon: Type }, { id: 'pages', icon: LayoutGrid }, { id: 'comment', icon: MessageSquare }, { id: 'forms', icon: ListChecks }, { id: 'sign', icon: PenLine }, ...(ocr ? [{ id: 'ocr' as const, icon: ScanText }] : [])] as const;
  return <div className="editor-commandbar" role="toolbar" aria-label={t('PDF tools')}>
    <IconButton label={t('Toggle pages')} aria-pressed={railOpen} onClick={onToggleRail}><PanelLeft size={18} /></IconButton>
    <span className="toolbar-divider" />
    <button className="tool-button open-tool" type="button" onClick={onOpen} disabled={locked}><FolderOpen size={17} /><span>{t('Open')}</span></button>
    {tools.map(({ id, icon: Icon }) => <button className="tool-button" type="button" key={id} aria-pressed={tool === id}
      disabled={!hasDocument || locked} onClick={() => onTool(id)}><Icon size={17} /><span>{t(toolNames[id])}</span></button>)}
    <span className="status-spacer" />
    <button className="tool-button" type="button" disabled={!hasDocument || locked} onClick={() => onTool('export')} aria-pressed={tool === 'export'}><ArrowDownToLine size={17} /><span>{t('Export')}</span></button>
  </div>;
}

export function ViewControls({ page, pages, zoom, busy, onPage, onZoom, onFit, onFitWidth, zoomMode = 'manual' }: {
  page: number; pages: number; zoom: number; busy: boolean;
  onPage(page: number): void; onZoom(zoom: number): void; onFit(): void;
  onFitWidth?(): void; zoomMode?: ViewZoomMode;
}) {
  const { t } = useI18n();
  const presetsId = useId();
  const [zoomDraft, setZoomDraft] = useState<string | null>(null);
  const cancelZoomDraft = useRef(false);
  const fitStyle = { background: 'var(--canvas)', color: 'var(--accent)', borderColor: 'var(--line)' };
  const commitZoom = (value: string) => {
    if (!cancelZoomDraft.current && zoomDraft !== null) {
      const next = parseZoomPercent(value);
      if (next !== null) onZoom(next);
    }
    cancelZoomDraft.current = false;
    setZoomDraft(null);
  };
  return <div className="view-controls">
    <IconButton label={t('Previous page')} disabled={busy || page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={16} /></IconButton>
    <label className="page-number-input"><span className="sr-only">{t('Page')}</span><input aria-label={t('Page')} type="number" min={pages ? 1 : 0} max={pages} key={page} defaultValue={page} disabled={busy || !pages}
      onBlur={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= pages) onPage(value); else event.target.value = String(page || 1); }}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /><span>/ {pages}</span></label>
    <IconButton label={t('Next page')} disabled={busy || page >= pages} onClick={() => onPage(page + 1)}><ChevronRight size={16} /></IconButton>
    <span className="toolbar-divider" />
    <IconButton label={t('Zoom out')} disabled={busy || !pages || zoom <= MIN_VIEW_ZOOM} onClick={() => onZoom(clampViewZoom(zoom / 1.25))}><Minus size={16} /></IconButton>
    <label className="page-number-input"><span className="sr-only">{t('Zoom')}</span>
      <input aria-label={t('Zoom')} title={t('Zoom (25–400%)')} type="text" inputMode="decimal" list={presetsId}
        style={{ width: 70 }} value={zoomDraft ?? formatZoomPercent(zoom)} disabled={busy || !pages}
        onFocus={event => { cancelZoomDraft.current = false; event.currentTarget.select(); }}
        onChange={event => setZoomDraft(event.target.value)} onBlur={event => commitZoom(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelZoomDraft.current = true; setZoomDraft(null); event.currentTarget.blur(); }
        }} />
      <datalist id={presetsId}>{[25, 50, 75, 100, 125, 150, 200, 300, 400].map(percent => <option key={percent} value={`${percent}%`} />)}</datalist>
    </label>
    <IconButton label={t('Zoom in')} disabled={busy || !pages || zoom >= MAX_VIEW_ZOOM} onClick={() => onZoom(clampViewZoom(zoom * 1.25))}><Plus size={16} /></IconButton>
    {onFitWidth && <IconButton label={t('Fit width')} disabled={busy || !pages} aria-pressed={zoomMode === 'fit-width'}
      style={zoomMode === 'fit-width' ? fitStyle : undefined} onClick={onFitWidth}><MoveHorizontal size={16} /></IconButton>}
    <IconButton label={t('Fit page')} disabled={busy || !pages} aria-pressed={zoomMode === 'fit-page'}
      style={zoomMode === 'fit-page' ? fitStyle : undefined} onClick={onFit}><Maximize size={16} /></IconButton>
  </div>;
}

export { Tooltip, PanelRightClose, Bookmark, FilePlus2 };
