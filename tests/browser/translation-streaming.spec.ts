import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import type { TextActionRequest } from '@pdf-editor/contracts';
import { openAiPdf, selectAiText } from './ai-integration-helpers';

for (const stop of [false, true]) test(`translation previews arrive before completion${stop ? ' and can be stopped' : ''}`, async ({ page }) => {
  let response: ServerResponse | undefined, input: TextActionRequest | undefined, disconnected = false;
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type,accept');
    if (req.method === 'OPTIONS') { res.end(); return; }
    expect(req.headers.accept).toBe('text/event-stream');
    let body = ''; for await (const chunk of req) body += chunk;
    input = JSON.parse(body); response = res;
    res.on('close', () => { disconnected = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: delta\ndata: {"type":"delta","text":"你好，"}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  try {
    await page.addInitScript(origin => {
      localStorage.setItem('komopdf.ui.language', 'en');
      const original = window.fetch;
      window.fetch = (url, init) => original(typeof url === 'string' && url === '/api/v1/ai/text-actions' ? origin + url : url, init);
    }, `http://127.0.0.1:${address.port}`);
    await page.goto('/editor/'); await openAiPdf(page); await selectAiText(page);
    await page.getByRole('menuitem', { name: 'Translate', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Translate selected text', exact: true });
    await dialog.getByRole('combobox').selectOption('zh');
    await dialog.getByRole('button', { name: 'Translate', exact: true }).click();
    const panel = page.getByRole('region', { name: 'AI text tools', exact: true });
    await expect(panel.getByRole('textbox', { name: 'Translation', exact: true })).toHaveValue('你好，');
    await expect(panel.getByRole('button', { name: 'Apply to PDF', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Copy translation', exact: true })).toHaveCount(0);
    await expect(page.locator('.save-state')).toHaveText('No changes');
    if (stop) {
      await panel.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(panel.getByText('Stopped', { exact: true })).toBeVisible();
      await expect(panel.getByRole('textbox', { name: 'Translation', exact: true })).toHaveCount(0);
      await expect.poll(() => disconnected).toBe(true);
    } else {
      await page.screenshot({ path: 'tmp/browser/translation-streaming-preview.png' });
      const result = { requestId: input!.requestId, action: 'translate', detectedLanguage: 'en', segments: [{ id: input!.segments[0]!.id, text: '你好，世界。' }] };
      response!.end(`event: delta\ndata: {"type":"delta","text":"世界。"}\n\nevent: result\ndata: ${JSON.stringify({ type: 'result', result })}\n\n`);
      await expect(panel.getByRole('textbox', { name: 'AI result on page 1', exact: true })).toHaveValue('你好，世界。');
      await expect(panel.getByRole('button', { name: 'Copy translation', exact: true })).toBeEnabled();
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
