'use client';

import dynamic from 'next/dynamic';

const EditorClient = dynamic(() => import('./editor-client'), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen w-screen items-center justify-center bg-[#1b1d1b] text-[#f7f5ed]">
      <div className="flex flex-col items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#d7ff37] border-t-transparent" />
        <span className="text-sm font-medium tracking-wide">Loading komopdf Editor...</span>
      </div>
    </div>
  ),
});

export function EditorWrapper() {
  return <EditorClient />;
}
