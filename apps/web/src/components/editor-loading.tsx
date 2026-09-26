'use client';

import { useI18n } from '@pdf-editor/editor/i18n';

export function EditorLoading() {
  const { t } = useI18n();
  return <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
    <div className="flex flex-col items-center gap-3" role="status">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
      <span className="text-sm font-medium">{t('Loading editor…')}</span>
    </div>
  </div>;
}
