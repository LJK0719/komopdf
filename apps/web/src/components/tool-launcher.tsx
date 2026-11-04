'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useI18n } from '@pdf-editor/editor/i18n';
import type { ToolTask } from '@/lib/tool-content';

const Workspace = dynamic(() => import('./editor-wrapper').then(module => module.EditorWrapper), { ssr: false });
const OpenTool = createContext<(() => void) | null>(null);

export function ToolPageSession({ task, children }: { task: ToolTask; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  const { t } = useI18n();
  return <OpenTool.Provider value={() => setOpened(true)}>
    <div hidden={opened}>{children}</div>
    {opened ? <section className="tool-workspace" aria-label={t('Open editor')}>
      <Workspace initialTask={task} embedded><WorkspaceHeader /></Workspace>
    </section> : null}
  </OpenTool.Provider>;
}

function WorkspaceHeader() {
  const { t } = useI18n();
  // A document navigation reuses the editor's beforeunload protection, including pending drafts.
  return <header className="tool-workspace-header">
    <a className="site-text-link" href={typeof window === 'undefined' ? '' : window.location.href} onClick={event => { event.preventDefault(); window.location.reload(); }}><ArrowLeft size={16} aria-hidden="true" />{t('Back to the guide')}</a>
  </header>;
}

export function ToolLauncher({ label }: { label: string }) {
  const { t } = useI18n();
  const open = useContext(OpenTool);
  return <button type="button" className="site-button site-button-primary site-button-large" onClick={() => open?.()}>{t(label)}<ArrowRight size={16} aria-hidden="true" /></button>;
}
