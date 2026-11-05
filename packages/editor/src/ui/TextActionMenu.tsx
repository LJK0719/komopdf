import { ContextMenu } from '@base-ui/react/context-menu';
import { Languages, Sparkles } from 'lucide-react';
import type { TextAction } from '@pdf-editor/contracts';
import { useI18n } from './i18n.js';

export function TextActionMenuItems({ disabled = false, onAction }: {
  disabled?: boolean; onAction(action: TextAction | 'ask'): void;
}) {
  const { t } = useI18n();
  return <><ContextMenu.Separator className="ui-menu-separator" />
    <ContextMenu.Item className="ui-menu-item" disabled={disabled} onClick={() => onAction('translate')}><Languages size={16} aria-hidden="true" />{t('Translate')}</ContextMenu.Item>
    <ContextMenu.Item className="ui-menu-item" disabled={disabled} onClick={() => onAction('assist')}><Sparkles size={16} aria-hidden="true" />{t('Use AI')}</ContextMenu.Item>
  </>;
}
