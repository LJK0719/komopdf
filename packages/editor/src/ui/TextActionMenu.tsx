import { ContextMenu } from '@base-ui/react/context-menu';
import { Languages, BookOpen, List, SpellCheck, PenLine, AlignLeft, MessageSquare } from 'lucide-react';
import type { TextAction } from '@pdf-editor/contracts';
import { TEXT_ACTION_LABELS } from './text-actions.js';
import { useI18n } from './i18n.js';

const actions = [
  ['translate', Languages], ['explain', BookOpen], ['summarize', List],
  ['proofread', SpellCheck], ['rewrite', PenLine], ['shorten', AlignLeft],
] as const;
export function TextActionMenuItems({ disabled = false, onAction }: {
  disabled?: boolean; onAction(action: TextAction | 'ask'): void;
}) {
  const { t } = useI18n();
  return <><ContextMenu.Separator className="ui-menu-separator" />
    {actions.map(([action, Icon]) => <ContextMenu.Item key={action} className="ui-menu-item" disabled={disabled} onClick={() => onAction(action)}>
      <Icon size={16} aria-hidden="true" />{t(TEXT_ACTION_LABELS[action])}
    </ContextMenu.Item>)}
    <ContextMenu.Item className="ui-menu-item" disabled={disabled} onClick={() => onAction('ask')}><MessageSquare size={16} aria-hidden="true" />{t('Ask KOMO about selection')}</ContextMenu.Item>
  </>;
}
