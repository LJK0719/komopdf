'use client';

import { useI18n } from '@pdf-editor/editor/i18n';

export function EditorLoading() {
  const { t } = useI18n();
  return <div className="flex h-dvh w-full flex-col" aria-busy="true" style={{ background: 'var(--komo-canvas)', color: 'var(--komo-ink)' }}>
    <div className="flex h-[52px] shrink-0 items-center gap-2 border-b bg-white px-[14px]" style={{ borderColor: 'var(--komo-line)' }}>
      <span className="grid h-[31px] w-7 place-items-center rounded-md text-2xl font-bold italic text-white" style={{ background: 'var(--komo-accent-strong)', fontFamily: 'Georgia, serif' }} aria-hidden="true">k</span>
      <strong className="text-[17px] tracking-tight" translate="no">komopdf</strong>
    </div>
    <div className="flex flex-1 items-center justify-center gap-3 text-sm" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" aria-hidden="true" />
      <span>{t('Loading editor…')}</span>
    </div>
  </div>;
}
