import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test.use({ channel: 'msedge', locale: 'en-US' });
let bundle: string, styles: string;
test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../packages/editor/', import.meta.url)), loader: 'tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { PdfSearchPanel } from './src/ui/PdfSearchPanel.tsx';
    import { OcrPanel } from './src/ui/OcrPanel.tsx';
    import { addImportedFont } from './src/ui/font-resources.ts';
    import './src/ui/workspace.css';
    const pages = Object.fromEntries(['p1', 'p2'].map(id => [id, { id, widthPt: 600, heightPt: 800, rotation: 0, objects: [{
      id: 'scan-' + id, pageId: id, type: 'image', bounds: { x: 0, y: 0, width: 600, height: 800 },
      locator: { pageId: id, containerPath: [], objectIndex: 0 }, transform: [1,0,0,1,0,0]
    }] }]));
    function textObject(id, pageId, text, bounds, isOcr = false) {
      return { id, pageId, type: 'text', bounds, locator: { pageId, containerPath: [], objectIndex: 1 }, transform: [1,0,0,1,0,0],
        textBlock: { id: id + ':text', pageId, sourceId: 's', sourceObjectIds: [id], isOcr, editability: 'direct', bounds,
          runs: [{ text, style: { fontId: 'noto-test', fontSize: 12 }, sourceObjectIds: [id] }] } };
    }
    pages.p1.objects.push(textObject('number', 'p1', '1', { x: 280, y: 760, width: 10, height: 12 }));
    window.ocrCalls = []; window.searchLocations = [];
    let revision = 0;
    const engine = {
      describePage: async (_, id) => structuredClone(pages[id]),
      recognizeOcr: async request => { window.ocrCalls.push(request.pageId); return { lines: [
        { text: 'Recognized words', confidence: 0.99, bounds: { x: 30, y: 60, width: 180, height: 20 } },
        { text: '1', confidence: 0.99, bounds: { x: 280, y: 760, width: 10, height: 12 } }
      ] }; },
      previewTransaction: async () => ({ pageOrder: ['p1', 'p2'] }),
      apply: async transaction => {
        for (const command of transaction.commands) {
          if (command.type === 'text.insert') pages[command.pageId].objects.push(textObject(command.objectId, command.pageId, command.text, command.bounds, true));
        }
        return { docId: 'doc', revision: ++revision, changedPageIds: transaction.commands.map(c => c.pageId) };
      },
    };
    addImportedFont(engine, { id: 'noto-test', family: 'Noto Sans', style: 'Regular', format: 'ttf', registered: true });
    function App() {
      const [info, setInfo] = useState({ id: 'doc', revision: 0, savedRevision: 0, pageOrder: ['p1', 'p2'], sourceIds: ['s'],
        permissions: { modify: true, copy: true, annotate: true, fillForms: true, encrypted: false, signed: false }, capabilities: ['text.insert', 'objects.transform'] });
      const [tool, setTool] = useState('search'), [busy, setBusy] = useState(false), [request, setRequest] = useState(null), [resume, setResume] = useState(0);
      const commit = async result => setInfo(previous => ({ ...previous, revision: result.revision }));
      return <><div hidden={tool !== 'search'}><PdfSearchPanel document={info} engine={engine} active={tool === 'search'} disabled={busy} resumeSearch={resume}
        onLocate={match => window.searchLocations.push(match)} onRequestOcr={() => { setTool('ocr'); setRequest({ id: 'request', documentId: 'doc' }); }} /></div>
        <div hidden={tool !== 'ocr'}><OcrPanel document={info} page={pages.p1} selectedIds={[]} engine={engine} disabled={busy}
          request={request} onBusyChange={setBusy} onCommitted={commit} onBatchFinished={() => { setRequest(null); setTool('search'); setResume(n => n + 1); }} /></div></>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  ` }, bundle: true, write: false, outfile: 'ocr-fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' } });
  bundle = result.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  styles = result.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});

test('search offers full OCR, includes scanned pages with page numbers, and resumes the retained query', async ({ page }) => {
  await page.route('https://ocr.invalid/', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.route('https://ocr.invalid/fonts/font-resources.json', route => route.fulfill({ json: [] }));
  await page.goto('https://ocr.invalid/');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: bundle });
  const prompt = page.getByRole('dialog', { name: 'Recognize text for search?', exact: true });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Not now', exact: true }).click();
  const query = page.getByRole('textbox', { name: 'Find text', exact: true });
  await query.fill('Recognized'); await query.press('Enter');
  await page.getByRole('button', { name: 'Recognize entire document', exact: true }).click();
  await prompt.getByRole('button', { name: 'Recognize entire document', exact: true }).click();
  await expect(page.locator('.pdf-search-panel')).toContainText('1 of 2');
  await expect(query).toHaveValue('Recognized');
  expect(await page.evaluate(() => (window as any).ocrCalls)).toEqual(['p1', 'p2']);
  expect(await page.evaluate(() => (window as any).searchLocations.at(-1).isOcr)).toBe(true);
});
