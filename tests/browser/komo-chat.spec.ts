import { test, expect, type Locator, type Page } from '@playwright/test';
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

async function openPdf(page: Page, scanned: boolean | 'mixed', count: number, name = scanned ? 'scanned.pdf' : 'report.pdf') {
  const chooser = page.waitForEvent('filechooser');
  const add = page.getByRole('button', { name: 'Open another PDF', exact: true });
  await (await add.count() ? add : page.getByRole('button', { name: 'Open PDF', exact: true })).click();
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: samplePdf(scanned, count) });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
  await expect(page.locator('.page-chip')).toHaveCount(count, { timeout: 60_000 });
}

async function allowSharing(chat: Locator) {
  await chat.locator('.komo-chat-settings > summary').click();
  const consent = chat.getByRole('checkbox');
  await expect(consent).not.toBeChecked();
  await consent.check();
}

// This suite exercises PDF/chat UI, not a real login or paid model. Give Clerk's
// browser adapter stable test resources; all account and answer requests stay local.
async function mockAccount(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('komopdf.ui.language', 'en');
    const user = { id: 'user_ui_test', organizationMemberships: [] };
    const session = { id: 'session_ui_test', status: 'active', user, getToken: async () => 'ui-test-only-token',
      lastActiveToken: { jwt: { claims: { sub: user.id, sid: 'session_ui_test' } } } };
    const resources = { client: { id: 'client_ui_test', sessions: [session] }, session, user, organization: null };
    Object.assign(window, { Clerk: {
      ...resources, loaded: true, status: 'ready', __internal_lastEmittedResources: resources,
      load: async () => {}, addListener: (listener: (value: unknown) => void, options?: { skipInitialEmit?: boolean }) => {
        if (!options?.skipInitialEmit) listener(resources);
        return () => {};
      },
      on: (event: string, listener: (value: string) => void, options?: { notify?: boolean }) => {
        if (event === 'status' && options?.notify) listener('ready');
        return () => {};
      }, off: () => {}, __internal_updateProps: async () => {}, telemetry: { record: () => {} },
    } });
  });
  await page.route('**/api/account/config', route => route.fulfill({ json: {
    publishableKey: `pk_test_${Buffer.from('ui-test.clerk.accounts.dev$').toString('base64')}`,
  } }));
  await page.route('**/api/account', route => route.fulfill({ json: {
    userId: 'user_ui_test', plan: 'free', freeCredits: 1000, usedCredits: 0, remainingCredits: 1000,
    tokensPerCredit: 100, subscriptionStatus: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
    billingAvailable: false, profile: { name: 'UI test', email: 'ui@example.test', imageUrl: '' },
  } }));
}

test.beforeEach(async ({ page }) => {
  await mockAccount(page);
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
  await expect(chat.locator('.komo-chat-settings')).not.toHaveAttribute('open');
  await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('Review and allow sharing before sending your question.', { exact: true })).toBeVisible();
  await expect(chat.getByRole('checkbox')).not.toBeChecked();
  await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Summarize this document');
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
  await allowSharing(chat);
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
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await page.keyboard.press('Escape');
  await expect(chat.locator('.komo-chat-scan')).toContainText('结构化文字');
  await page.screenshot({ path: 'tmp/browser/komo-web-scan-zh.png' });
});

test('longer scans do not silently upload only the first two pages', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/ai/')) requests.push(request.url()); });
  await openPdf(page, true, 3);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await allowSharing(chat);
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
  await allowSharing(chat);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Summarize and compare the figures.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('heading', { name: 'Revenue summary' })).toBeVisible();
  await expect(chat.getByRole('table')).toBeVisible();
  await expect(chat.getByRole('textbox', { name: 'Message' })).toBeFocused();
  const viewport = page.viewportSize()!;
  for (const control of [chat.getByRole('textbox', { name: 'Message' }), chat.getByRole('button', { name: 'Send', exact: true })]) {
    const bounds = (await control.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  }
  await page.screenshot({ path: 'tmp/browser/komo-small-window-fixed.png' });
  const layout = await chat.evaluate(element => Object.fromEntries([
    element, element.parentElement!, element.closest('.panel-content')!, element.closest('.editor-panel')!,
    ...element.children,
  ].filter(Boolean).map(node => [node.className, { height: node.getBoundingClientRect().height, flex: getComputedStyle(node).flex, overflow: getComputedStyle(node).overflow }])));
  expect(await chat.locator('.komo-chat-transcript').evaluate(element => element.clientHeight), JSON.stringify(layout)).toBeGreaterThan(110);
  await chat.getByRole('button', { name: 'report.pdf · Source · page 2', exact: true }).click();
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
  await allowSharing(chat);
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
  await page.screenshot({ path: 'tmp/browser/komo-mixed-page-fixed.png' });
  expect(visible.visible).toBeGreaterThanOrEqual(visible.height - 1);
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
  await allowSharing(chat);
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

test('each open document keeps its own answers, draft and sharing choice when switching back', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, `Answer for ${request.document.id}`) });
  });
  await openPdf(page, false, 2, 'first.pdf');
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await allowSharing(chat);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Read the first file.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.locator('.ai-markdown')).toContainText('Answer for');
  const firstAnswer = await chat.locator('.ai-markdown').innerText();
  await chat.getByRole('textbox', { name: 'Message' }).fill('Draft for first.pdf');
  await openPdf(page, false, 1, 'second.pdf');
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  await expect(chat.locator('.ai-markdown')).toHaveCount(0);
  await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  await chat.locator('.komo-chat-settings > summary').click();
  await expect(chat.getByRole('checkbox')).not.toBeChecked();
  await chat.locator('.komo-chat-settings > summary').click();
  await chat.getByRole('textbox', { name: 'Message' }).fill('Draft for second.pdf');
  await page.getByRole('tab', { name: 'first.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  await expect(chat.locator('.ai-markdown')).toHaveText(firstAnswer);
  await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft for first.pdf');
  await chat.locator('.komo-chat-settings > summary').click();
  await expect(chat.getByRole('checkbox')).toBeChecked();
  await chat.locator('.komo-chat-settings > summary').click();
  await page.getByRole('tab', { name: 'second.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft for second.pdf');
  expect(requests).toHaveLength(1);
});

for (const scope of ['page', 'selection'] as const) test(`retry preserves the original ${scope}, page, selection and image mode`, async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    if (requests.length === 1) await route.fulfill({ status: 429, body: '{}' });
    else await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, 'Retried the original material.') });
  });
  await openPdf(page, false, 2);
  if (scope === 'selection') {
    await page.getByRole('button', { name: 'Edit content', exact: true }).click();
    await page.locator('.object-hitbox[data-object-type="text"]').first().click();
  }
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await allowSharing(chat);
  await chat.getByRole('combobox', { name: 'Page images', exact: true }).selectOption('text');
  await chat.getByRole('combobox', { name: 'Context', exact: true }).selectOption(scope);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Explain the original passage.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('alert')).toContainText('Wait a moment');
  await chat.locator('.komo-chat-settings > summary').click();
  await chat.getByRole('combobox', { name: 'Context', exact: true }).selectOption('document');
  await chat.getByRole('combobox', { name: 'Page images', exact: true }).selectOption('always');
  await chat.locator('.komo-chat-settings > summary').click();
  const pageNumber = page.getByRole('spinbutton', { name: 'Page', exact: true });
  await pageNumber.fill('2'); await pageNumber.press('Enter');
  await expect(pageNumber).toHaveValue('2');
  await chat.getByRole('button', { name: 'Retry question', exact: true }).click();
  await expect(chat.getByText('Retried the original material.', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]!.context.scope).toBe(scope);
  expect(requests[0]!.context.evidence.map(evidence => evidence.pageNumber)).toEqual([1]);
  expect(requests[1]!.context).toEqual(requests[0]!.context);
  expect(requests[1]!.context.images).toBeUndefined();
});

test('a revision keeps old answers but invalidates sources, retry context and follow-up history', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    if (requests.length === 2) await route.fulfill({ status: 429, body: '{}' });
    else await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, requests.length === 1 ? 'Original version answer.' : 'Current version answer.') });
  });
  await openPdf(page, false, 2);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await allowSharing(chat);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Read this version.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('button', { name: 'report.pdf · Source · page 2', exact: true })).toBeVisible();
  await chat.getByRole('textbox', { name: 'Message' }).fill('Question from the old version.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('button', { name: 'Retry question', exact: true })).toBeVisible();
  await chat.getByRole('textbox', { name: 'Message' }).fill('Draft survives revision');
  await page.getByRole('navigation', { name: 'PDF tools', exact: true }).getByRole('button', { name: 'Pages', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate right', exact: true }).click();
  await expect(page.getByRole('button', { name: /Undo \(/ })).toBeEnabled();
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  await expect(chat.getByText('Original version answer.', { exact: true })).toHaveCount(1);
  await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft survives revision');
  await expect(chat.getByText('Earlier document version · source links are no longer available.', { exact: true }).first()).toBeVisible();
  await expect(chat.getByRole('button', { name: 'report.pdf · Source · page 2', exact: true })).toBeDisabled();
  await expect(chat.getByRole('button', { name: 'Retry question', exact: true })).toHaveCount(0);
  await expect(chat.getByText('The original context has changed. Retry with the current version.', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  await chat.getByRole('button', { name: 'Retry with current version', exact: true }).click();
  await expect(chat.getByText('Current version answer.', { exact: true })).toBeVisible();
  expect(requests[2]!.instruction).toBe('Question from the old version.');
  expect(requests[2]!.document.revision).toBeGreaterThan(requests[0]!.document.revision);
  expect(requests[2]!.context.history).toEqual([]);
  await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft survives revision');
});

test('an unavailable account explains why sending is disabled without granting sharing', async ({ page }) => {
  await page.route('**/api/account', route => route.fulfill({ status: 503, json: { error: { message: 'Account service unavailable' } } }));
  await page.reload();
  await openPdf(page, false, 1);
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  const chat = page.getByRole('region', { name: 'komo', exact: true });
  await expect(chat.getByRole('textbox', { name: 'Message' })).toBeEditable();
  await chat.getByRole('textbox', { name: 'Message' }).fill('Keep this draft until the account is available.');
  await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft until the account is available.');
  await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(chat.getByText('Your account is currently unavailable.', { exact: true })).toBeVisible();
  await chat.locator('.komo-chat-settings > summary').click();
  await expect(chat.getByRole('checkbox')).not.toBeChecked();
});

for (const decision of ['save', 'cancel', 'failed-save'] as const) {
  test(`updated reference ${decision} preserves the composer and saves before continuing automatically`, async ({ page }) => {
    const requests: AiRequest[] = [];
    await page.route('**/api/v1/ai/requests', async route => {
      const request = route.request().postDataJSON() as AiRequest; requests.push(request);
      await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, 'Latest reference answer.') });
    });
    await openPdf(page, false, 1, 'main.pdf');
    await openPdf(page, false, 2, 'reference.pdf');
    await page.getByRole('tab', { name: 'main.pdf', exact: true }).click();
    await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
    const chat = page.getByRole('region', { name: 'komo', exact: true });
    await allowSharing(chat);
    await chat.getByRole('combobox', { name: 'Add reference PDF', exact: true }).selectOption({ label: 'reference.pdf' });
    await expect(chat.locator('.komo-material-card')).toHaveCount(1);
    await expect(chat.getByRole('combobox', { name: 'Add reference PDF', exact: true })).toBeEnabled();
    await page.getByRole('tab', { name: /^reference\.pdf(?: Unsaved changes)?$/ }).click();
    await page.getByRole('navigation', { name: 'PDF tools', exact: true }).getByRole('button', { name: 'Pages', exact: true }).click();
    await page.getByRole('button', { name: 'Rotate right', exact: true }).click();
    await expect(page.getByRole('button', { name: /Undo \(/ })).toBeEnabled();
    await page.getByRole('tab', { name: 'main.pdf', exact: true }).click();
    await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
    const message = chat.getByRole('textbox', { name: 'Message', exact: true });
    await message.fill('Compare the latest reference.');
    await chat.getByRole('button', { name: 'Send', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'File changes detected. Save?', exact: true });
    await expect(dialog).toBeVisible(); expect(requests).toHaveLength(0);
    await expect(page.locator('#komo-question')).toHaveValue('Compare the latest reference.');
    await expect(page.locator('.komo-chat-exchange')).toHaveCount(0);
    if (decision === 'save') await page.screenshot({ path: 'tmp/browser/material-update-confirm.png' });
    if (decision === 'cancel') {
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(message).toHaveValue('Compare the latest reference.');
      await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
      await expect(chat.locator('.komo-material-card')).toHaveCount(1); expect(requests).toHaveLength(0);
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(dialog).toBeVisible();
    }
    if (decision === 'failed-save') {
      await page.evaluate(() => {
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.download) {
            HTMLAnchorElement.prototype.click = click;
            throw new Error('Synthetic download unavailable');
          }
          return click.call(this);
        };
      });
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(chat.getByText('Unable to save this PDF. Try saving again.', { exact: true })).toBeVisible();
      await expect(message).toHaveValue('Compare the latest reference.');
      await expect(chat.locator('.komo-chat-exchange')).toHaveCount(0); expect(requests).toHaveLength(0);
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(dialog).toBeVisible();
    }
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await downloading).suggestedFilename()).toBe('reference.pdf');
    await expect(chat.getByText('Latest reference answer.', { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.context.referenceEvidence?.some(evidence => evidence.revision > 0 && evidence.kind === 'source')).toBe(true);
    await expect(page.getByRole('tab', { name: 'main.pdf', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(message).toHaveValue('');
    await page.getByRole('tab', { name: /^reference\.pdf(?: Unsaved changes)?$/ }).click();
    await expect(page.locator('.save-state')).toHaveText('Download started');
    await page.screenshot({ path: `tmp/browser/material-update-${decision}.png` });
  });
}
