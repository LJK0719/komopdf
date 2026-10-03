import { test, expect, type Page } from '@playwright/test';
import type { AiRequest } from '@pdf-editor/contracts';

function samplePdf(scanned: boolean | 'mixed', count: number): Buffer {
  const pixels = 'ff000000ff000000ffffffff>';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 0; i < count; i++) {
    const content = scanned ? `q 240 0 0 240 30 30 cm /Scan Do Q${scanned === 'mixed' ? ` BT /F1 12 Tf 30 285 Td (Page ${i + 1}) Tj ET` : ''}`
      : `BT /F1 14 Tf 30 250 Td (Report page ${i + 1}: revenue increased 20 percent.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> ${scanned ? `/XObject << /Scan ${4 + count * 2} 0 R >>` : ''} >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  if (scanned) objects.push(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`);
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const position = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return position;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function openPdf(page: Page, scanned: boolean | 'mixed', count: number) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: scanned ? 'scanned.pdf' : 'report.pdf', mimeType: 'application/pdf', buffer: samplePdf(scanned, count) });
  await expect(page.locator('.page-chip')).toHaveCount(count, { timeout: 60_000 });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('komopdf.ui.language', 'en'));
  await page.goto('/editor/');
});

test('web komo asks permission, keeps follow-up context, clears and does not persist chat', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest;
    requests.push(request);
    const response = { protocolVersion: 1, requestId: request.requestId,
      document: { id: request.document.id, baseRevision: request.document.revision }, feature: request.feature,
      result: { kind: 'answer', text: `komo answer ${requests.length}`, citations: [{ evidenceId: request.context.evidence[0]!.id }] } };
    const events = [{ type: 'accepted', requestId: request.requestId }, { type: 'result', response },
      { type: 'done', requestId: request.requestId }];
    await route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') });
  });
  await openPdf(page, false, 2);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await chat.getByRole('button', { name: 'Summarize this document', exact: true }).click();
  await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect(requests).toHaveLength(0);
  await chat.getByRole('checkbox').check();
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('komo answer 1', { exact: true })).toBeVisible();
  expect(requests[0]!.context.evidence.map(item => item.pageNumber)).toEqual([1, 2]);
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('Why did that happen?');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('komo answer 2', { exact: true })).toBeVisible();
  expect(requests[1]!.context.history).toEqual([
    { role: 'user', text: 'Summarize this document' }, { role: 'assistant', text: 'komo answer 1' },
  ]);
  await page.screenshot({ path: 'tmp/browser/komo-web-chat.png' });
  await chat.getByRole('button', { name: 'Clear conversation' }).click();
  await expect(chat.getByText('komo answer 1', { exact: true })).toHaveCount(0);
  const persisted = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(persisted).not.toContain('komo answer');
});

test('two scanned pages send actual JPEG pixels and show the Markdown recommendation', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/image-requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    const response = { protocolVersion: 1, requestId: request.requestId,
      document: { id: request.document.id, baseRevision: request.document.revision }, feature: request.feature,
      result: { kind: 'answer', text: 'Both pages contain colored squares.', citations: [] } };
    await route.fulfill({ contentType: 'text/event-stream', body: [
      { type: 'accepted', requestId: request.requestId }, { type: 'result', response }, { type: 'done', requestId: request.requestId },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') });
  });
  await openPdf(page, true, 2);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await chat.getByRole('checkbox').check();
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('What is on these pages?');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('Both pages contain colored squares.', { exact: true })).toBeVisible();
  expect(requests[0]!.context.images).toHaveLength(2);
  expect(requests[0]!.context.evidence).toEqual([]);
  for (const image of requests[0]!.context.images!) {
    expect(image.mimeType).toBe('image/jpeg');
    expect(Buffer.from(image.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const decoded = await page.evaluate(async data => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return { width: bitmap.width, height: bitmap.height, hasColor: pixels.some((value, index) => index % 4 === 0 && value !== pixels[index + 1]) };
    }, image.data);
    expect(decoded.hasColor).toBe(true);
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(1536);
  }
  await expect(chat.locator('.komo-chat-scan')).toContainText('KOLMOPDF');
  await expect(chat.locator('.komo-chat-scan')).toContainText('Markdown');
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
  await expect(chat.locator('.komo-chat-scan')).toContainText('结构化文字');
  await page.screenshot({ path: 'tmp/browser/komo-web-scan-zh.png' });
});

test('longer scans do not silently upload only the first two pages', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/ai/')) requests.push(request.url()); });
  await openPdf(page, true, 3);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await chat.getByRole('checkbox').check();
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('Summarize all pages.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('alert')).toContainText('More than two pages');
  expect(requests).toEqual([]);
});

function answerEvents(request: AiRequest, text: string): string {
  return [{ type: 'accepted', requestId: request.requestId }, { type: 'result', response: {
    protocolVersion: 1, requestId: request.requestId, document: { id: request.document.id, baseRevision: request.document.revision }, feature: request.feature,
    result: { kind: 'answer', text, citations: request.context.evidence.length ? [{ evidenceId: request.context.evidence.at(-1)!.id }] : [] },
  } }, { type: 'done', requestId: request.requestId }].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

test('Markdown, clickable citations and a readable answer area in a small window', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest;
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, '## Revenue summary\n\n**Growth: 20%.**\n\n| Before | After |\n|---|---|\n| 100 | 120 |') });
  });
  await openPdf(page, false, 2);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await chat.getByRole('checkbox').check();
  await chat.getByRole('textbox', { name: 'Message' }).fill('Summarize and compare the figures.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('heading', { name: 'Revenue summary' })).toBeVisible();
  await expect(chat.getByRole('table')).toBeVisible();
  await expect(chat.getByRole('textbox', { name: 'Message' })).toBeFocused();
  expect(await chat.locator('.komo-chat-transcript').evaluate(element => element.clientHeight)).toBeGreaterThan(110);
  await chat.getByRole('button', { name: 'Source · page 2', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('2');
  await expect(chat.getByRole('table')).toHaveCount(1);
  await page.screenshot({ path: 'tmp/browser/komo-small-window-fixed.png' });
});

test('mixed pages with a text header still include their visual content', async ({ page }) => {
  let received: AiRequest | undefined;
  await page.route('**/api/v1/ai/image-requests', async route => {
    received = route.request().postDataJSON() as AiRequest;
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(received, 'The diagram contains colored squares.') });
  });
  await openPdf(page, 'mixed', 2);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await chat.getByRole('checkbox').check();
  await chat.getByRole('textbox', { name: 'Message' }).fill('Explain the diagram.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('The diagram contains colored squares.', { exact: true })).toBeVisible();
  expect(received!.context.evidence.length).toBeGreaterThan(0);
  expect(received!.context.images).toHaveLength(2);
  await expect(chat.locator('.komo-chat-scan')).not.toHaveAttribute('open');
  const visible = await chat.locator('.komo-chat-assistant .ai-markdown').evaluate(element => {
    const reply = element.getBoundingClientRect(), body = element.closest('.komo-chat-transcript')!.getBoundingClientRect();
    return { visible: Math.max(0, Math.min(reply.bottom, body.bottom) - Math.max(reply.top, body.top)), height: reply.height };
  });
  expect(visible.visible).toBeGreaterThanOrEqual(visible.height - 1);
  await page.screenshot({ path: 'tmp/browser/komo-mixed-page-fixed.png' });
});

test('sent questions appear immediately and cancelled or rate-limited turns can be retried', async ({ page }) => {
  let mode: 'hold' | 'limited' | 'success' = 'hold';
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    if (mode === 'hold') return;
    if (mode === 'limited') { await route.fulfill({ status: 429, body: '{}' }); return; }
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, 'Recovered answer.') });
  });
  await openPdf(page, false, 2);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await chat.getByRole('checkbox').check();
  await chat.getByRole('textbox', { name: 'Message' }).fill('Explain revenue.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(chat.locator('.komo-chat-user')).toContainText('Explain revenue.');
  await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  await expect(chat.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  await chat.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(chat.getByText('Stopped. You can edit your question and send it again.', { exact: true })).toBeVisible();
  mode = 'limited';
  await chat.getByRole('button', { name: 'Retry question', exact: true }).click();
  await expect(chat.getByRole('alert')).toContainText('Wait a moment');
  mode = 'success';
  await chat.getByRole('button', { name: 'Retry question', exact: true }).last().click();
  await expect(chat.getByText('Recovered answer.', { exact: true })).toBeVisible();
  expect(requests.at(-1)!.context.history).toEqual([]);
});
