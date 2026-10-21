import { AppDialog } from './AppDialog.js';
import { useI18n } from './i18n.js';

export type SaveChoice = 'save' | 'discard' | 'cancel';
export type SavePrompt = { name: string; resolve(choice: SaveChoice): void; web?: boolean; downloaded?: boolean };

export function SaveChangesDialog({ prompt }: { prompt: SavePrompt }) {
  const { t } = useI18n();
  const downloaded = prompt.web && prompt.downloaded;
  return <AppDialog open onOpenChange={open => { if (!open) prompt.resolve('cancel'); }} title={t(downloaded ? 'Ready to close this PDF?' : 'Save your changes?')}>
    <p className="password-filename">{prompt.name}</p>
    <p className="dialog-description">{t(downloaded
      ? 'The download has started. Check your browser downloads before closing this document.'
      : prompt.web ? 'Download a copy to keep your changes before closing.' : 'Your changes will be lost if you do not save them.')}</p>
    <div className="dialog-actions">
      {!downloaded && <button className="button button-quiet" onClick={() => prompt.resolve('discard')}>{t(prompt.web ? 'Close without downloading' : 'Don’t save')}</button>}
      <span className="status-spacer" />
      <button className="button button-quiet" onClick={() => prompt.resolve('cancel')}>{t('Cancel')}</button>
      <button className="button button-primary" autoFocus onClick={() => prompt.resolve(downloaded ? 'discard' : 'save')}>
        {t(downloaded ? 'Close document' : prompt.web ? 'Download copy' : 'Save')}
      </button>
    </div>
  </AppDialog>;
}
