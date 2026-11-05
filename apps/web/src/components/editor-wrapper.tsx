'use client';

import { useEffect, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { I18nProvider, useI18n } from '@pdf-editor/editor/i18n';
import type { UiMessages } from '@pdf-editor/editor/i18n-resources';
import { loadEditorClient, preloadEditor } from './editor-preload';
import { EditorLoading } from './editor-loading';

const EditorClient = dynamic(() => loadEditorClient(), { ssr: false, loading: EditorLoading });

export function EditorWrapper({ initialTask, embedded = false, children }: {
  initialTask?: import('@pdf-editor/editor').EditorInitialTask;
  embedded?: boolean;
  children?: ReactNode;
}) {
  const { locale, t } = useI18n();
  const [initialLocale] = useState(locale);
  const [messages, setMessages] = useState<UiMessages | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    preloadEditor(initialLocale).then(value => { if (active) setMessages(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [initialLocale]);
  if (failed) return <div className="editor-load-error" role="alert"><p>{t('Unable to load the editor.')}</p>
    <button type="button" className="site-button site-button-primary" onClick={() => window.location.reload()}>{t('Try again')}</button></div>;
  if (!messages) return <EditorLoading />;
  return <I18nProvider initialLocale={initialLocale} messages={messages} documentLanguage={!embedded}>
    <WorkspaceContent embedded={embedded} initialTask={initialTask}>{children}</WorkspaceContent>
  </I18nProvider>;
}

function WorkspaceContent({ embedded, initialTask, children }: { embedded: boolean; initialTask?: import('@pdf-editor/editor').EditorInitialTask; children?: ReactNode }) {
  const { locale } = useI18n();
  const editor = <>{children}<EditorClient initialTask={initialTask} /></>;
  return embedded ? <div className="tool-workspace-content" lang={locale}>{editor}</div> : editor;
}
