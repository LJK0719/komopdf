import { AppDialog } from './AppDialog.js';
import { useI18n } from './i18n.js';

export type SaveChoice = 'save' | 'discard' | 'cancel';
export type SavePrompt = { name: string; resolve(choice: SaveChoice): void };

export function SaveChangesDialog({ prompt }: { prompt: SavePrompt }) {
  const { t } = useI18n();
  return <AppDialog open onOpenChange={open => { if (!open) prompt.resolve('cancel'); }} title={t('Save your changes?')}>
    <p className="password-filename">{prompt.name}</p>
    <p className="dialog-description">{t('Your changes will be lost if you do not save them.')}</p>
    <div className="dialog-actions"><button className="button button-quiet" onClick={() => prompt.resolve('discard')}>{t('Don’t save')}</button><span className="status-spacer" /><button className="button button-quiet" onClick={() => prompt.resolve('cancel')}>{t('Cancel')}</button><button className="button button-primary" autoFocus onClick={() => prompt.resolve('save')}>{t('Save')}</button></div>
  </AppDialog>;
}
