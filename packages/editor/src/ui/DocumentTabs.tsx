import { Menu } from '@base-ui/react/menu';
import { ChevronDown, FileText, Plus, X } from 'lucide-react';
import { useI18n } from './i18n.js';

export type DocumentTab = { id: string; name: string; location?: string; dirty: boolean };
export function DocumentTabs({ tabs, activeId, disabled, previewName, onActivate, onClose, onOpen }: {
  tabs: DocumentTab[]; activeId: string | null; disabled: boolean; previewName?: string;
  onActivate(id: string): void; onClose(id: string): void; onOpen(): void;
}) {
  const { t } = useI18n();
  return <nav className="editor-document-tabs" aria-label={t('Open PDFs')}>
    <div className="document-tabs-scroll" role="tablist" aria-label={t('Documents')} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault(); event.stopPropagation();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[target]?.focus();
    }}>
      {tabs.map(tab => <div className={`document-tab ${activeId === tab.id && !previewName ? 'is-active' : ''}`} key={tab.id}>
        <button type="button" role="tab" aria-selected={activeId === tab.id && !previewName} aria-controls="document-workspace"
          tabIndex={activeId === tab.id ? 0 : -1} disabled={disabled} onClick={() => onActivate(tab.id)}
          title={tab.location ? `${tab.name}\n${tab.location}` : tab.name}>
          <FileText size={14} aria-hidden="true" /><span>{tab.name}</span>
          {tab.dirty && <span className="document-dirty" aria-label={t('Unsaved changes')}>●</span>}
        </button>
        <button type="button" className="document-tab-close" disabled={disabled} onClick={() => onClose(tab.id)}
          aria-label={t('Close {name}', { name: tab.name })} title={t('Close document')}><X size={14} /></button>
      </div>)}
      {previewName && <span className="document-preview-tab"><FileText size={14} aria-hidden="true" />{previewName}<small>{t('Read-only')}</small></span>}
    </div>
    <button className="icon-button document-tab-add" type="button" disabled={disabled} onClick={onOpen} aria-label={t('Open another PDF')} title={t('Open another PDF')}><Plus size={17} /></button>
    {tabs.length > 1 && <Menu.Root><Menu.Trigger className="icon-button" aria-label={t('All open documents')}><ChevronDown size={16} /></Menu.Trigger>
      <Menu.Portal><Menu.Positioner sideOffset={5} align="end"><Menu.Popup className="ui-menu document-tabs-menu">
        {tabs.map(tab => <Menu.Item key={tab.id} className="ui-menu-item" disabled={disabled} onClick={() => onActivate(tab.id)}>
          <FileText size={15} /><span>{tab.name}{tab.dirty ? ' ●' : ''}{tab.location && <small>{tab.location}</small>}</span>
        </Menu.Item>)}
      </Menu.Popup></Menu.Positioner></Menu.Portal>
    </Menu.Root>}
  </nav>;
}
