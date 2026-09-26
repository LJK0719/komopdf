'use client';

import dynamic from 'next/dynamic';
import { EditorLoading } from './editor-loading';

const EditorClient = dynamic(() => import('./editor-client'), { ssr: false, loading: EditorLoading });

export function EditorWrapper() {
  return <EditorClient />;
}
