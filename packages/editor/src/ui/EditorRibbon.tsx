import type { ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { TEXT_ACTIONS, type TextAction } from '@pdf-editor/contracts';
import { TEXT_ACTION_LABELS } from './text-actions.js';
import { Languages } from 'lucide-react';
import { Hand, MousePointer2, Type, ImagePlus, FilePlus2, Copy, Trash2, RotateCcw, RotateCw, Search,
  Printer, Download, ScanText, PenLine, MessageSquare, LayoutGrid, BookOpen, File, Play, Maximize, MoveHorizontal,
  Square, StickyNote, Files, PanelLeft, Crop, Hash, Stamp, PanelTop, ListChecks, Ellipsis } from 'lucide-react';
import type { EditorTool } from './EditorChrome.js';
import type { PageView, PointerTool } from './DocumentViewport.js';
import { useI18n } from './i18n.js';
import type { PageTools, PageAction } from './PageOrganizer.js';

export type RibbonTab = 'home' | 'edit' | 'insert' | 'comment' | 'pages' | 'forms' | 'view';
export type RibbonAction = 'insertText' | 'insertImage' | 'blankPage' | 'importPages' | 'duplicatePage' | 'deletePage' |
  'rotatePageLeft' | 'rotatePageRight' | 'duplicate' | 'delete' | 'replaceImage' | 'cropImage' | 'rotateLeft' | 'rotateRight' | 'present' | 'fit' |
  'copyPages' | 'pastePages' | 'extractPages' | 'pageNumbers' | 'watermark' | 'headerFooter' | 'cropPage' | 'flipHorizontal' | 'flipVertical' |
  'fitWidth' | 'note' | 'rectangle' | 'ink';
type RibbonItem = { label: string; Icon: typeof Type; run(): void; disabled: boolean; pressed?: boolean };

export function EditorRibbon({ tab, onTab, pointer, onPointer, onTool, onAction, view, continuous, onView, onContinuous,
  hasDocument, busy, ocr, railOpen, onToggleRail, selection, children, pageTools, overviewColumns, onOverviewColumns, annotationTool, canAnnotate = true, zoomMode, onTextAction, onCaptureSelection }: {
  onTextAction?: ((action: TextAction | 'ask') => void) | undefined; onCaptureSelection?(): void;
  pageTools: PageTools; overviewColumns: number; onOverviewColumns(columns: number): void;
  annotationTool?: 'text' | 'rectangle' | 'ink' | null; canAnnotate?: boolean;
  zoomMode?: 'manual' | 'fit-width' | 'fit-page';
  tab: RibbonTab; onTab(tab: RibbonTab): void; pointer: PointerTool; onPointer(tool: PointerTool): void;
  onTool(tool: EditorTool): void; onAction(action: RibbonAction): void; view: PageView; continuous: boolean;
  onView(view: PageView): void; onContinuous(): void; hasDocument: boolean; busy: boolean; ocr: boolean;
  railOpen: boolean; onToggleRail(): void; selection: 'text' | 'image' | 'objects' | null; children?: ReactNode;
}) {
  const { t } = useI18n();
  const tabs: [RibbonTab, string][] = [['home', 'Home'], ['edit', 'Edit'], ['insert', 'Insert'], ['comment', 'Comment'], ['pages', 'Pages'], ['forms', 'Fill & sign'], ['view', 'View']];
  const items: RibbonItem[] = [];
  const add = (label: string, Icon: typeof Type, run: () => void, pressed?: boolean) => items.push({ label, Icon, run, disabled: !hasDocument || busy, ...(pressed !== undefined ? { pressed } : {}) });
  const page = (label: string, Icon: typeof Type, action: PageAction) => items.push({ label, Icon, run: () => void pageTools.run(action), disabled: !pageTools.can(action) });
  if (tab === 'home') {
    add('Find & replace', Search, () => onTool('search'));
    add('Organize pages', LayoutGrid, () => onTab('pages'));
    page('Extract pages', Files, 'extractPages');
    add('Fill & forms', ListChecks, () => onTool('forms'));
    add('Sign', PenLine, () => onTool('sign'));
    add('Export', Download, () => onTool('export'));
    add('Print', Printer, () => onTool('print'));
  }
  if (tab === 'edit') {
    if (!selection) {
      add('Add text', Type, () => onAction('insertText'));
      add('Add image', ImagePlus, () => onAction('insertImage'));
      if (ocr) add('Recognize text', ScanText, () => onTool('ocr'));
      add('Fonts', Type, () => onTool('fonts'));
    } else if (selection === 'text') add('Paragraph & arrangement', LayoutGrid, () => onTool('arrange'));
    else {
      if (selection === 'image') {
        add('Replace image', ImagePlus, () => onAction('replaceImage'));
        add('Crop image', Crop, () => onAction('cropImage'));
        add('Flip horizontally', ImagePlus, () => onAction('flipHorizontal'));
        add('Flip vertically', ImagePlus, () => onAction('flipVertical'));
      }
      add('Arrange objects', LayoutGrid, () => onTool('arrange'));
      add('Duplicate', Copy, () => onAction('duplicate'));
      add('Rotate left', RotateCcw, () => onAction('rotateLeft'));
      add('Rotate right', RotateCw, () => onAction('rotateRight'));
      add('Delete', Trash2, () => onAction('delete'));
    }
  }
  if (tab === 'insert') {
    add('Add text', Type, () => onAction('insertText'));
    add('Add image', ImagePlus, () => onAction('insertImage'));
    page('Add blank page', FilePlus2, 'blankPage');
    page('Import PDF pages', Files, 'importPages');
    add('Page number', Hash, () => onAction('pageNumbers'));
    add('Watermark', Stamp, () => onAction('watermark'));
    add('Header & footer', PanelTop, () => onAction('headerFooter'));
    add('Fill & forms', ListChecks, () => onTool('forms'));
  }
  if (tab === 'comment') {
    if (canAnnotate) {
      add('Sticky note', StickyNote, () => onAction('note'), annotationTool === 'text');
      add('Rectangle', Square, () => onAction('rectangle'), annotationTool === 'rectangle');
      add('Freehand', PenLine, () => onAction('ink'), annotationTool === 'ink');
    }
    add('Comment', MessageSquare, () => onTool('comment'));
  }
  if (tab === 'forms') {
    add('Fill & forms', ListChecks, () => onTool('forms'));
    add('Sign', PenLine, () => onTool('sign'));
  }
  if (tab === 'pages') {
    page('Add blank page', FilePlus2, 'blankPage');
    page('Import PDF pages', Files, 'importPages');
    page('Extract pages', Files, 'extractPages');
    page('Rotate left', RotateCcw, 'rotatePageLeft');
    page('Rotate right', RotateCw, 'rotatePageRight');
    page('Delete selected pages', Trash2, 'deletePage');
    page('Copy pages', Copy, 'copyPages');
    page('Paste pages', Files, 'pastePages');
    page('Duplicate pages', Copy, 'duplicatePage');
    add('Crop current page', Crop, () => onAction('cropPage'));
    add('Page number', Hash, () => onAction('pageNumbers'));
    add('Watermark', Stamp, () => onAction('watermark'));
    add('Header & footer', PanelTop, () => onAction('headerFooter'));
    add('More page tools', LayoutGrid, () => onTool('pages'));
  }
  if (tab === 'view') {
    add('Single page', File, () => onView('single'), view === 'single');
    add('Facing pages', BookOpen, () => onView('double'), view === 'double');
    add('Continuous scrolling', Files, onContinuous, continuous);
    add('Fit width', MoveHorizontal, () => onAction('fitWidth'), zoomMode === 'fit-width');
    add('Fit page', Maximize, () => onAction('fit'), zoomMode === 'fit-page');
    add('Slide show', Play, () => onAction('present'));
    add('Toggle pages', PanelLeft, onToggleRail, railOpen);
  }
  const priority = (index: number) => index < 2 ? 'primary' : index < 4 ? 'medium' : index < 6 ? 'wide' : 'overflow';
  return <div className="editor-ribbon">
    <nav className="ribbon-tabs" aria-label={t('PDF tools')}>
      {tabs.map(([id, label]) => <button type="button" key={id} disabled={busy || !hasDocument} aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>{t(label)}</button>)}
      {tab === 'edit' && selection && <span className="context-tab">{t(selection === 'text' ? 'Text editing' : selection === 'image' ? 'Image editing' : 'Object editing')}</span>}
    </nav>
    <div className="ribbon-content" role="toolbar" aria-label={t('Document tools')}>
      {tab === 'pages' ? <div className="ribbon-page-view">
        <button className="ribbon-button" type="button" onClick={() => onTab('home')} disabled={busy}><BookOpen size={18} /><span>{t('Back to document')}</span></button>
        <label className="overview-columns">{t('Columns')}<select aria-label={t('Page columns')} value={overviewColumns} disabled={busy} onChange={event => onOverviewColumns(Number(event.target.value))}>
          <option value="0">{t('Automatic')}</option>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}
        </select></label>
      </div> : <div className="ribbon-pointer-tools" aria-label={t('Interaction mode')}>
        {([['select', 'Select', MousePointer2], ['hand', 'Hand', Hand], ['edit', 'Edit content', Type]] as const).map(([mode, label, Icon]) =>
          <button type="button" className="ribbon-button" key={mode} disabled={!hasDocument || busy} aria-pressed={pointer === mode}
            onClick={() => onPointer(mode)} title={t(label)}><Icon size={17} /><span>{t(label)}</span></button>)}
      </div>}
      {tab === 'edit' && selection === 'text' && <div className="ribbon-text-properties">{children}</div>}
      {onTextAction && <Menu.Root onOpenChange={open => { if (open) onCaptureSelection?.(); }}>
        <Menu.Trigger className="ribbon-button ai-owned-focus ribbon-ai-tools" disabled={!hasDocument || busy} onPointerDownCapture={onCaptureSelection}><Languages size={20} /><span>{t('AI tools')}</span></Menu.Trigger>
        <Menu.Portal><Menu.Positioner sideOffset={6}><Menu.Popup className="ui-menu ai-owned-focus">
          {TEXT_ACTIONS.map(action => <Menu.Item className="ui-menu-item" key={action} onClick={() => onTextAction(action)}>{t(TEXT_ACTION_LABELS[action])}</Menu.Item>)}
          <Menu.Item className="ui-menu-item" onClick={() => onTextAction('ask')}>{t('Ask KOMO about selection')}</Menu.Item>
          <Menu.Separator className="ui-menu-separator" />
          <Menu.Item className="ui-menu-item" onClick={() => onTool('translate-document')}>{t('Translate entire PDF…')}</Menu.Item>
        </Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root>}
      <div className="ribbon-actions">
        {items.map(({ label, Icon, run, disabled, pressed }, index) => <button type="button" key={label}
          className={'ribbon-button ribbon-priority-' + priority(index)} disabled={disabled} aria-pressed={pressed} onClick={run}><Icon size={20} strokeWidth={1.7} /><span>{t(label)}</span></button>)}
        {items.length > 2 && <Menu.Root><Menu.Trigger className={'ribbon-button ribbon-more ribbon-more-' + (items.length > 6 ? 'always' : items.length > 4 ? 'medium' : 'small')} aria-label={t('More tools')}><Ellipsis size={20} /><span>{t('More')}</span></Menu.Trigger>
          <Menu.Portal><Menu.Positioner sideOffset={6} align="end"><Menu.Popup className="ui-menu">
            {items.slice(2).map(({ label, Icon, run, disabled }, offset) => <Menu.Item key={label} className={'ui-menu-item ribbon-overflow-' + priority(offset + 2)} disabled={disabled} onClick={run}><Icon size={16} />{t(label)}</Menu.Item>)}
          </Menu.Popup></Menu.Positioner></Menu.Portal>
        </Menu.Root>}
      </div>
    </div>
  </div>;
}
