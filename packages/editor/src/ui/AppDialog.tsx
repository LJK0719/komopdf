import type { ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { useI18n } from './i18n.js';

export function AppDialog({ open, onOpenChange, title, children }: { open: boolean; onOpenChange(open: boolean): void; title: string; children: ReactNode }) {
  const { t } = useI18n();
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal><Dialog.Backdrop className="app-dialog-backdrop" />
      <Dialog.Popup className="app-dialog"><header><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label={t('Close')}><X size={18} /></Dialog.Close></header>
        <div className="app-dialog-content">{children}</div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
