import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test.use({ channel: 'msedge', locale: 'en-US' });
let bundle: string;
test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../packages/editor/', import.meta.url)), loader: 'tsx', contents: `
    import React, { useState, useRef } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AnnotationLayer } from './src/ui/AnnotationLayer.tsx';
    import { AnnotationPopup } from './src/ui/AnnotationPopup.tsx';
    import { DocumentToolsPanel } from './src/ui/DocumentToolsPanel.tsx';
    const info = { id: 'doc', revision: 0, pageOrder: ['p1', 'p2'], permissions: { annotate: true }, capabilities: ['annotation.add', 'annotation.update'] };
    const page = { id: 'p1', widthPt: 600, heightPt: 800, rotation: 0, objects: [] };
    const note = { id: 'note', pageId: 'p1', subtype: 'text', text: 'A readable note', bounds: { x: 20, y: 20, width: 24, height: 24 }, color: [1, 1, 0], opacity: 1 };
    window.failComment = false;
    const engine = { describePage: async () => page, describeAnnotations: async (_, pageId) => {
      if (pageId === 'p2' || window.failComment) throw new Error('PDF worker returned invalid annotation information');
      return [note];
    } };
    function App() {
      const [selected, select] = useState(null); const ref = useRef(null);
      return <><div data-document-page="p1" style={{ position: 'relative', width: 600, height: 800 }}>
        <AnnotationLayer document={info} page={page} render={{ width: 600, height: 800 }} engine={engine} disabled={false} selected={selected} onOpen={select} />
      </div><DocumentToolsPanel document={info} page={page} engine={engine} selectedIds={[]} disabled={false} onNavigate={item => select({ documentId: 'doc', pageId: 'p1', id: item.id })} onBusyChange={() => {}} onCommitted={async () => {}} />
      {selected && <AnnotationPopup selection={selected} document={info} engine={engine} disabled={false} draftRef={ref} onDirty={() => {}} onBusyChange={() => {}} onCommitted={async () => {}} onClose={() => select(null)} />}</>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"test"' } });
  bundle = result.outputFiles[0]!.text;
});

test('one unreadable page keeps other comments, and card errors are contextual and retryable', async ({ page }) => {
  await page.route('https://comments.invalid/', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.route('https://comments.invalid/fonts/font-resources.json', route => route.fulfill({ json: [] }));
  await page.goto('https://comments.invalid/'); await page.addScriptTag({ content: bundle });
  await expect(page.locator('.annotation-list-item')).toContainText('A readable note');
  await expect(page.getByRole('alert')).toContainText('Comments on 1 pages could not be loaded.');
  await expect(page.locator('[data-document-page]')).not.toContainText('could not');
  await expect(page.locator('body')).not.toContainText('PDF worker');
  await page.evaluate(() => { (window as any).failComment = true; });
  await page.getByRole('button', { name: 'Open comment 1 on page 1', exact: true }).click();
  const card = page.getByRole('dialog', { name: 'Comment', exact: true });
  await expect(card).toContainText('This comment could not be loaded. Please try again.');
  await expect(card).not.toContainText('PDF worker');
  await page.evaluate(() => { (window as any).failComment = false; });
  await card.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(card.locator('.comment-body')).toHaveText('A readable note');
});
