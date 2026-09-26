import type { ReactNode } from 'react';
import { Hand, MousePointer2, Type, ImagePlus, FilePlus2, Copy, Trash2, RotateCcw, RotateCw, Search,
  Printer, Download, ScanText, PenLine, MessageSquare, LayoutGrid, BookOpen, File, Play, Maximize, Scissors, Files, PanelLeft } from 'lucide-react';
import type { EditorTool } from './EditorChrome.js';
import type { PageView, PointerTool } from './DocumentViewport.js';
import { useI18n } from './i18n.js';
import type { PageTools, PageAction } from './PageOrganizer.js';

export type RibbonTab = 'home' | 'edit' | 'insert' | 'comment' | 'pages' | 'view';
export type RibbonAction = 'insertText' | 'insertImage' | 'blankPage' | 'importPages' | 'duplicatePage' | 'deletePage' |
  'rotatePageLeft' | 'rotatePageRight' | 'duplicate' | 'delete' | 'replaceImage' | 'cropImage' | 'rotateLeft' | 'rotateRight' | 'present' | 'fit' |
  'copyPages' | 'pastePages' | 'extractPages' | 'pageNumbers' | 'watermark' | 'headerFooter' | 'cropPage' | 'flipHorizontal' | 'flipVertical';
export function EditorRibbon({ tab, onTab, pointer, onPointer, onTool, onAction, view, continuous, onView, onContinuous,
  hasDocument, busy, ocr, railOpen, onToggleRail, selection, children, pageTools, overviewColumns, onOverviewColumns }: {
  pageTools: PageTools; overviewColumns: number; onOverviewColumns(columns: number): void;
  tab: RibbonTab; onTab(tab: RibbonTab): void; pointer: PointerTool; onPointer(tool: PointerTool): void;
  onTool(tool: EditorTool): void; onAction(action: RibbonAction): void; view: PageView; continuous: boolean;
  onView(view: PageView): void; onContinuous(): void; hasDocument: boolean; busy: boolean; ocr: boolean;
  railOpen: boolean; onToggleRail(): void; selection: 'text' | 'image' | 'objects' | null; children?: ReactNode;
}) {
  const { t } = useI18n();
  const tabs: [RibbonTab, string][] = [['home', 'Home'], ['edit', 'Edit'], ['insert', 'Insert'], ['comment', 'Comment'], ['pages', 'Pages'], ['view', 'View']];
  const button = (label: string, Icon: typeof Type, action: () => void, pressed?: boolean) =>
    <button type="button" className="ribbon-button" disabled={!hasDocument || busy} aria-pressed={pressed} onClick={action}><Icon size={21} strokeWidth={1.5} /><span>{t(label)}</span></button>;
  const pageButton = (label: string, Icon: typeof Type, action: PageAction) =>
    <button type="button" className="ribbon-button" disabled={!pageTools.can(action)} onClick={() => void pageTools.run(action)}><Icon size={21} strokeWidth={1.5} /><span>{t(label)}</span></button>;
  return <div className="editor-ribbon">
    <nav className="ribbon-tabs" aria-label={t('PDF tools')}>
      {tabs.map(([id, label]) => <button type="button" key={id} disabled={busy || (!hasDocument && id !== 'home')} aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>{t(label)}</button>)}
      {tab === 'edit' && selection && <span className="context-tab">{t(selection === 'text' ? 'Text editing' : selection === 'image' ? 'Image editing' : 'Object editing')}</span>}
    </nav>
    <div className="ribbon-content" role="toolbar" aria-label={t('Document tools')}>
      {tab === 'pages' ? <>
        {button('Back to document', BookOpen, () => onTab('home'))}
        <label className="overview-columns">{t('Columns')}<select aria-label={t('Page columns')} value={overviewColumns} disabled={busy} onChange={event => onOverviewColumns(Number(event.target.value))}>
          <option value="0">{t('Automatic')}</option>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}
        </select></label>
      </> : <div className="ribbon-pointer-tools">
        {button('Hand', Hand, () => onPointer('hand'), pointer === 'hand')}
        {button('Select', MousePointer2, () => onPointer('select'), pointer === 'select')}
      </div>}
      <span className="ribbon-separator" />
      {tab === 'home' && <>
        {button('Edit content', Type, () => onTab('edit'))}
        {button('Find & replace', Search, () => onTool('search'))}
        <span className="ribbon-separator" />
        {button('Organize pages', LayoutGrid, () => onTab('pages'))}
        {button('Extract pages', Scissors, () => onTool('pages'))}
        {button('Export', Download, () => onTool('export'))}
        {button('Print', Printer, () => onTool('print'))}
        <span className="ribbon-separator" />
      </>}
      {tab === 'edit' && !selection && <>
        {button('Edit content', Type, () => onPointer('edit'), pointer === 'edit')}
        {button('Add text', Type, () => onAction('insertText'))}
        {button('Add image', ImagePlus, () => onAction('insertImage'))}
        {button('Crop current page', Scissors, () => onAction('cropPage'))}
        {ocr && button('Recognize text', ScanText, () => onTool('ocr'))}
      </>}
      {tab === 'edit' && selection === 'text' && <>{children}{button('More text tools', Type, () => onTool('arrange'))}</>}
      {tab === 'edit' && selection && selection !== 'text' && <>
        {selection === 'image' && <>
          {button('Replace image', ImagePlus, () => onAction('replaceImage'))}
          {button('Crop image', Scissors, () => onAction('cropImage'))}
          {button('Flip horizontally', ImagePlus, () => onAction('flipHorizontal'))}
        </>}
        {button('Rotate left', RotateCcw, () => onAction('rotateLeft'))}
        {button('Rotate right', RotateCw, () => onAction('rotateRight'))}
        {button('Duplicate', Copy, () => onAction('duplicate'))}
        {button('Delete', Trash2, () => onAction('delete'))}
        {button('Arrange objects', LayoutGrid, () => onTool('arrange'))}
      </>}
      {tab === 'insert' && <>
        {button('Add text', Type, () => onAction('insertText'))}
        {button('Add image', ImagePlus, () => onAction('insertImage'))}
        <span className="ribbon-separator" />
        {button('Add blank page', FilePlus2, () => onAction('blankPage'))}
        {button('Import PDF pages', Files, () => onAction('importPages'))}
        {button('Page number', File, () => onAction('pageNumbers'))}
        {button('Watermark', File, () => onAction('watermark'))}
        {button('Header & footer', File, () => onAction('headerFooter'))}
        <span className="ribbon-separator" />
        {button('Sign', PenLine, () => onTool('sign'))}
        {button('Comment', MessageSquare, () => onTool('comment'))}
      </>}
      {tab === 'comment' && <>
        {button('Comment', MessageSquare, () => onTool('comment'))}
        {button('Sign', PenLine, () => onTool('sign'))}
        {button('Fill & forms', File, () => onTool('forms'))}
      </>}
      {tab === 'pages' && <>
        {pageButton('Add blank page', FilePlus2, 'blankPage')}
        {pageButton('Import PDF pages', Files, 'importPages')}
        {pageButton('Copy pages', Copy, 'copyPages')}
        {pageButton('Paste pages', Files, 'pastePages')}
        {pageButton('Duplicate pages', Copy, 'duplicatePage')}
        {pageButton('Delete selected pages', Trash2, 'deletePage')}
        <span className="ribbon-separator" />
        {pageButton('Rotate left', RotateCcw, 'rotatePageLeft')}
        {pageButton('Rotate right', RotateCw, 'rotatePageRight')}
        {pageButton('Extract pages', Scissors, 'extractPages')}
        {button('More page tools', LayoutGrid, () => onTool('pages'))}
      </>}
      {(tab === 'home' || tab === 'view') && <>
        {button('Single page', File, () => onView('single'), view === 'single')}
        {button('Facing pages', BookOpen, () => onView('double'), view === 'double')}
        {button('Continuous scrolling', Files, onContinuous, continuous)}
        {button('Fit page', Maximize, () => onAction('fit'))}
        {button('Slide show', Play, () => onAction('present'))}
        {tab === 'view' && button('Toggle pages', PanelLeft, onToggleRail, railOpen)}
        {tab === 'view' && button('Fonts', Type, () => onTool('fonts'))}
      </>}
      {tab === 'edit' && !selection && <span className="ribbon-hint">{t('Double-click text to edit. Drag objects to move them.')}</span>}
    </div>
  </div>;
}
