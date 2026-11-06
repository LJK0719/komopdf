import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { AiRequest } from '@pdf-editor/contracts';

function samplePdf(scanned: boolean | 'mixed', count: number): Buffer {
  const pixels = 'ff000000ff000000ffffffff>';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < count; i++) {
    const content = scanned ? `q 240 0 0 240 30 30 cm /Scan Do Q${scanned === 'mixed' ? ` BT /F1 12 Tf 30 285 Td (Page ${i + 1}) Tj ET` : ''}`
      : `BT /F1 14 Tf 30 250 Td (Report page ${i + 1}: revenue increased 20 percent.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> ${scanned ? `/XObject << /Scan ${4 + count * 2} 0 R >>` : ''} >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  if (scanned) objects.push(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`);
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(pdf);
  return Buffer.from(pdf + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
async function openPdf(page: Page, scanned: boolean | 'mixed', count: number, name = scanned ? 'scanned.pdf' : 'report.pdf') {
  const chooser = page.waitForEvent('filechooser');
  const add = page.getByRole('button', { name: 'Open another PDF', exact: true });
  await (await add.count() ? add : page.getByRole('button', { name: 'Open PDF', exact: true })).click();
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: samplePdf(scanned, count) });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
  await expect(page.locator('.page-chip')).toHaveCount(count, { timeout: 60_000 });
}
// Only account state and answer delivery are fixtures; PDF extraction and navigation use the real WASM engine.
async function mockAccount(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('komopdf.ui.language', 'en');
    const user = { id: 'user_ui_test', organizationMemberships: [] };
    const session = { id: 'session_ui_test', status: 'active', user, getToken: async () => 'ui-test-only-token',
      lastActiveToken: { jwt: { claims: { sub: user.id, sid: 'session_ui_test' } } } };
    const resources = { client: { id: 'client_ui_test', sessions: [session] }, session, user, organization: null };
    const listeners = new Set<(value: unknown) => void>();
    Object.assign(window, { switchKomoTestAccount: (id: string) => {
      const nextUser = { ...user, id };
      const nextSession = { ...session, user: nextUser, id: `session_${id}`,
        lastActiveToken: { jwt: { claims: { sub: id, sid: `session_${id}` } } } };
      const next = { ...resources, user: nextUser, session: nextSession, client: { ...resources.client, sessions: [nextSession] } };
      Object.assign((window as unknown as { Clerk: object }).Clerk, next, { __internal_lastEmittedResources: next });
      listeners.forEach(listener => listener(next));
    }, Clerk: { ...resources, loaded: true, status: 'ready', __internal_lastEmittedResources: resources,
      load: async () => {}, addListener: (listener: (value: unknown) => void, options?: { skipInitialEmit?: boolean }) => {
        listeners.add(listener); if (!options?.skipInitialEmit) listener(resources); return () => { listeners.delete(listener); };
      }, on: (event: string, listener: (value: string) => void, options?: { notify?: boolean }) => {
        if (event === 'status' && options?.notify) listener('ready'); return () => {};
      }, off: () => {}, __internal_updateProps: async () => {}, telemetry: { record: () => {} },
    } });
  });
  await page.route('**/api/account/config', route => route.fulfill({ json: { publishableKey: `pk_test_${Buffer.from('ui-test.clerk.accounts.dev$').toString('base64')}` } }));
  await page.route('**/api/account', route => route.fulfill({ json: { userId: 'user_ui_test', plan: 'free', freeCredits: 1000,
    usedCredits: 0, remainingCredits: 1000, tokensPerCredit: 100, subscriptionStatus: null, currentPeriodEnd: null,
    cancelAtPeriodEnd: false, billingAvailable: false, profile: { name: 'UI test', email: 'ui@example.test', imageUrl: '' } } }));
}
function answerEvents(request: AiRequest, text: string): string {
  return [{ type: 'accepted', requestId: request.requestId }, { type: 'result', response: { protocolVersion: 1, requestId: request.requestId,
    document: { id: request.document.id, baseRevision: request.document.revision }, feature: request.feature,
    result: { kind: 'answer', text, citations: request.context.evidence.length ? [{ evidenceId: request.context.evidence.at(-1)!.id }] : [] },
  } }, { type: 'done', requestId: request.requestId }].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
const chatOn = async (page: Page) => {
  const toggle = page.getByRole('button', { name: 'Ask komo', exact: true });
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  return page.getByRole('region', { name: 'komo', exact: true });
};
test.beforeEach(async ({ page }) => { await mockAccount(page); await page.goto('/editor/'); });

test('komo toggles without losing the document or chat draft', async ({ page }) => {
  await openPdf(page, false, 1);
  const chat = await chatOn(page), shell = await page.locator('.editor-shell').elementHandle();
  const message = chat.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Keep this unfinished question.'); const node = await message.elementHandle();
  await page.getByRole('button', { name: 'Ask komo', exact: true }).click();
  await expect(page.locator('.inspector-panel')).toBeHidden();
  await chatOn(page); await expect(message).toHaveValue('Keep this unfinished question.');
  expect(await node!.evaluate(element => element.isConnected)).toBe(true); expect(await shell!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.locator('.page-chip')).toHaveCount(1);
});

test('the first question sends directly and follow-ups keep recent history', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, `komo answer ${requests.length}`) });
  });
  await openPdf(page, false, 2); const chat = await chatOn(page);
  await expect(chat.locator('.komo-chat-settings')).toHaveCount(0); await expect(chat.getByRole('checkbox')).toHaveCount(0);
  await chat.getByRole('button', { name: 'Summarize this document', exact: true }).click();
  await expect(chat.getByText('komo answer 1', { exact: true })).toBeVisible();
  expect(requests[0]!.context.evidence.map(item => item.pageNumber)).toEqual([1, 2]);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Why did that happen?'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('komo answer 2', { exact: true })).toBeVisible();
  expect(requests[1]!.context.history).toEqual([{ role: 'user', text: 'Summarize this document' }, { role: 'assistant', text: 'komo answer 1' }]);
  await chat.getByRole('button', { name: 'Clear conversation' }).click(); await expect(chat.locator('.ai-markdown')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('komo answer');
});

test('two scanned pages send real JPEG pixels and offer full-document reading', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/image-requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, 'Both pages contain colored squares.') });
  });
  await openPdf(page, true, 2); const chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('What is on these pages?'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('Both pages contain colored squares.', { exact: true })).toBeVisible();
  expect(requests[0]!.context.images).toHaveLength(2); expect(requests[0]!.context.evidence).toEqual([]);
  for (const image of requests[0]!.context.images!) {
    expect(Buffer.from(image.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const decoded = await page.evaluate(async data => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return { longest: Math.max(bitmap.width, bitmap.height), color: pixels.some((value, index) => index % 4 === 0 && value !== pixels[index + 1]) };
    }, image.data);
    expect(decoded.color).toBe(true); expect(decoded.longest).toBeLessThanOrEqual(1536);
  }
  await expect(chat.locator('.komo-chat-scan').getByRole('button', { name: 'Read full PDF', exact: true })).toBeVisible();
  await expect(chat).not.toContainText('Check OCR and complex layouts');
});

test('three scanned pages are read in full through visual batches', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/*requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, request.context.images
      ? `Visual pages ${request.context.pages!.map(page => page.pageNumber).join(', ')}.` : 'All three pages were read.') });
  });
  await openPdf(page, true, 3); const chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Summarize all pages.'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('All three pages were read.', { exact: true })).toBeVisible();
  expect(requests.filter(request => request.context.images).flatMap(request => request.context.pages!.map(page => page.pageNumber))).toEqual([1, 2, 3]);
  expect(requests.at(-1)!.context.referenceEvidence?.[0]?.text).toContain('Visual pages 3.');
  await expect(chat.getByRole('alert')).toHaveCount(0);
});

test('Markdown and source navigation fit a small window', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.route('**/api/v1/ai/requests', async route => route.fulfill({ contentType: 'text/event-stream',
    body: answerEvents(route.request().postDataJSON() as AiRequest, '## Revenue summary\n\n**Growth: 20%.**\n\n| Before | After |\n|---|---|\n| 100 | 120 |') }));
  await openPdf(page, false, 2); const chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Summarize revenue.'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('heading', { name: 'Revenue summary' })).toBeVisible(); await expect(chat.getByRole('table')).toBeVisible();
  const viewport = page.viewportSize()!;
  for (const control of [chat.getByRole('textbox', { name: 'Message' }), chat.getByRole('button', { name: 'Send', exact: true })]) {
    const bounds = (await control.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  }
  expect(await chat.locator('.komo-chat-transcript').evaluate(element => element.clientHeight)).toBeGreaterThan(110);
  await chat.getByRole('button', { name: 'Page 2', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page', exact: true })).toHaveValue('2');
  await page.screenshot({ path: 'tmp/browser/komo-small-window-fixed.png' });
});

test('mixed pages retain visual content even when a header is selectable', async ({ page }) => {
  let received: AiRequest | undefined;
  await page.route('**/api/v1/ai/image-requests', async route => {
    received = route.request().postDataJSON() as AiRequest;
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(received, 'The diagram contains colored squares.') });
  });
  await openPdf(page, 'mixed', 2); const chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Explain the diagram.'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('The diagram contains colored squares.', { exact: true })).toBeVisible();
  expect(received!.context.evidence.length).toBeGreaterThan(0); expect(received!.context.images).toHaveLength(2);
});

test('stop and rate-limit recovery preserve the sent question', async ({ page }) => {
  let mode: 'hold' | 'limited' | 'success' = 'hold'; const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    if (mode === 'hold') return;
    if (mode === 'limited') { await route.fulfill({ status: 429, body: '{}' }); return; }
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, 'Recovered answer.') });
  });
  await openPdf(page, false, 2); const chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Explain revenue.'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1); await expect(chat.locator('.komo-chat-user')).toContainText('Explain revenue.');
  await chat.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(chat.getByText('Stopped', { exact: true })).toBeVisible();
  mode = 'limited'; await chat.getByRole('button', { name: 'Try again', exact: true }).click(); await expect(chat.getByRole('alert')).toContainText('Wait a moment');
  mode = 'success'; await chat.getByRole('button', { name: 'Try again', exact: true }).last().click();
  await expect(chat.getByText('Recovered answer.', { exact: true })).toBeVisible(); expect(requests.at(-1)!.context.history).toEqual([]);
});

test('a partial answer stays readable and can be continued', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    const body = requests.length === 1
      ? `event: accepted\ndata: ${JSON.stringify({ type: 'accepted', requestId: request.requestId })}\n\nevent: delta\ndata: ${JSON.stringify({ type: 'delta', text: 'A useful partial answer.' })}\n\n`
      : answerEvents(request, 'The continued answer.');
    await route.fulfill({ contentType: 'text/event-stream', body });
  });
  await openPdf(page, false, 1); const chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Explain revenue.'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText('A useful partial answer.', { exact: true })).toBeVisible(); await expect(chat.getByText('Answer paused', { exact: true })).toBeVisible();
  await chat.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(chat.getByText('The continued answer.', { exact: true })).toBeVisible();
  expect(requests[1]!.context.history?.at(-1)).toEqual({ role: 'assistant', text: 'A useful partial answer.' });
});

test('continuing a partial answer after editing never sends stale history', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    await route.fulfill({ contentType: 'text/event-stream', body:
      `event: accepted\ndata: ${JSON.stringify({ type: 'accepted', requestId: request.requestId })}\n\nevent: delta\ndata: ${JSON.stringify({ type: 'delta', text: 'Old partial facts.' })}\n\n` });
  });
  await openPdf(page, false, 1); let chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Explain revenue.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'PDF tools', exact: true }).getByRole('button', { name: 'Pages', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate right', exact: true }).click();
  await expect(page.getByRole('button', { name: /Undo \(/ })).toBeEnabled();
  chat = await chatOn(page);
  await chat.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(chat.getByText('The original context has changed. Retry with the current version.', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('switching account cancels the old request even when the new profile is unavailable', async ({ page }) => {
  let calls = 0; const aborted: string[] = [];
  page.on('requestfailed', request => { if (request.url().includes('/api/v1/ai/requests')) aborted.push(request.url()); });
  await page.route('**/api/v1/ai/requests', () => { calls++; });
  await openPdf(page, false, 1); const chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Account A private question.');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await page.route('**/api/account', route => route.fulfill({ status: 503, json: { error: { message: 'Profile unavailable' } } }));
  await page.evaluate(() => (window as unknown as { switchKomoTestAccount(id: string): void }).switchKomoTestAccount('user_b'));
  await expect(page.locator('.komo-chat-user')).toHaveCount(0);
  await expect.poll(() => aborted.length).toBe(1);
  expect(calls).toBe(1);
});

test('each PDF keeps its own answers and unfinished draft', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, `Answer for ${request.document.id}`) });
  });
  await openPdf(page, false, 2, 'first.pdf'); let chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Read the first file.'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.locator('.ai-markdown')).toContainText('Answer for'); const firstAnswer = await chat.locator('.ai-markdown').innerText();
  await chat.getByRole('textbox', { name: 'Message' }).fill('Draft for first.pdf');
  await openPdf(page, false, 1, 'second.pdf'); chat = await chatOn(page);
  await expect(chat.locator('.ai-markdown')).toHaveCount(0); await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  await chat.getByRole('textbox', { name: 'Message' }).fill('Draft for second.pdf');
  await page.getByRole('tab', { name: 'first.pdf', exact: true }).click(); chat = await chatOn(page);
  await expect(chat.locator('.ai-markdown')).toHaveText(firstAnswer); await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft for first.pdf');
  await page.getByRole('tab', { name: 'second.pdf', exact: true }).click(); chat = await chatOn(page);
  await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft for second.pdf'); expect(requests).toHaveLength(1);
});

test('retry keeps the original page even after navigating elsewhere', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    if (requests.length === 1) await route.fulfill({ status: 429, body: '{}' });
    else await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, 'Retried the original page.') });
  });
  await openPdf(page, false, 2); const chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Explain this page.'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('alert')).toContainText('Wait a moment');
  const number = page.getByRole('spinbutton', { name: 'Page', exact: true }); await number.fill('2'); await number.press('Enter'); await expect(number).toHaveValue('2');
  await chat.getByRole('button', { name: 'Try again', exact: true }).click(); await expect(chat.getByText('Retried the original page.', { exact: true })).toBeVisible();
  expect(requests[0]!.context.scope).toBe('page'); expect(requests[0]!.context.evidence.map(evidence => evidence.pageNumber)).toEqual([1]);
  expect(requests[1]!.context).toEqual(requests[0]!.context);
});

test('editing keeps the conversation and retries against the current PDF directly', async ({ page }) => {
  const requests: AiRequest[] = [];
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    if (requests.length === 2) await route.fulfill({ status: 429, body: '{}' });
    else await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, requests.length === 1 ? 'Original answer.' : 'Current answer.') });
  });
  await openPdf(page, false, 2); let chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Read this document.'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('button', { name: 'Page 2', exact: true })).toBeVisible();
  await chat.getByRole('textbox', { name: 'Message' }).fill('A question before editing.'); await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByRole('button', { name: 'Try again', exact: true })).toBeVisible(); await chat.getByRole('textbox', { name: 'Message' }).fill('Draft survives editing');
  await page.getByRole('navigation', { name: 'PDF tools', exact: true }).getByRole('button', { name: 'Pages', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate right', exact: true }).click(); await expect(page.getByRole('button', { name: /Undo \(/ })).toBeEnabled();
  chat = await chatOn(page); await expect(chat.getByText('Original answer.', { exact: true })).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Page 2', exact: true })).toBeDisabled(); await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft survives editing');
  await chat.getByRole('button', { name: 'Try again', exact: true }).click(); await expect(chat.getByText('Current answer.', { exact: true })).toBeVisible();
  expect(requests[2]!.document.revision).toBeGreaterThan(requests[0]!.document.revision); expect(requests[2]!.context.history).toEqual([]);
  await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft survives editing');
});

test('account errors keep the draft editable without additional sharing controls', async ({ page }) => {
  await page.route('**/api/account', route => route.fulfill({ status: 503, json: { error: { message: 'Account service unavailable' } } })); await page.reload();
  await openPdf(page, false, 1); const chat = await chatOn(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('Keep this draft.'); await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft.');
  await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeDisabled(); await expect(chat.getByRole('checkbox')).toHaveCount(0);
  await expect(chat.getByText('Your account is currently unavailable.', { exact: true })).toBeVisible();
});

test('changed references refresh in memory and stay attached for follow-ups without saving', async ({ page }) => {
  const requests: AiRequest[] = []; let downloads = 0; page.on('download', () => downloads++);
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, `Reference answer ${requests.length}.`) });
  });
  await openPdf(page, false, 1, 'main.pdf'); await openPdf(page, false, 2, 'reference.pdf');
  await page.getByRole('tab', { name: 'main.pdf', exact: true }).click(); let chat = await chatOn(page);
  await chat.getByRole('combobox', { name: 'Add PDF', exact: true }).selectOption({ label: 'reference.pdf' }); await expect(chat.locator('.komo-material-card')).toHaveCount(1);
  await page.getByRole('tab', { name: 'reference.pdf', exact: true }).click();
  await page.getByRole('navigation', { name: 'PDF tools', exact: true }).getByRole('button', { name: 'Pages', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate right', exact: true }).click(); await expect(page.getByRole('button', { name: /Undo \(/ })).toBeEnabled();
  await page.getByRole('tab', { name: 'main.pdf', exact: true }).click(); chat = await chatOn(page);
  for (const [index, question] of ['Compare the latest reference.', 'Tell me more.'].entries()) {
    await chat.getByRole('textbox', { name: 'Message' }).fill(question); await chat.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(chat.getByText(`Reference answer ${index + 1}.`, { exact: true })).toBeVisible();
  }
  expect(requests).toHaveLength(2); expect(requests.every(request => request.context.referenceEvidence?.some(evidence => evidence.revision > 0 && evidence.kind === 'source'))).toBe(true);
  await expect(page.getByRole('dialog', { name: 'File changes detected. Save?' })).toHaveCount(0); expect(downloads).toBe(0);
  await expect(chat.locator('.komo-material-card')).toHaveCount(1);
});

test('a connected KolmoPDF reading is reused across questions and can be downloaded', async ({ page }) => {
  let parses = 0; const requests: AiRequest[] = [];
  const job = { id: 'job_read', status: 'succeeded', result: { filename: 'reading.md', kind: 'markdown', download_url: '/api/v1/jobs/job_read/download' } };
  await page.route('**/api/v1/kolmo/balance', route => route.fulfill({ json: { configured: true, points: 100 } }));
  await page.route('**/api/v1/kolmo/jobs/parse', route => { parses++; return route.fulfill({ json: job }); });
  await page.route('**/api/v1/kolmo/jobs/job_read', route => route.fulfill({ json: job }));
  await page.route('**/api/v1/kolmo/jobs/job_read/download', route => route.fulfill({ contentType: 'text/markdown', body: '# Full text\nKnown reading result.' }));
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as AiRequest; requests.push(request);
    await route.fulfill({ contentType: 'text/event-stream', body: answerEvents(request, `Reading answer ${requests.length}.`) });
  });
  await openPdf(page, false, 1); const chat = await chatOn(page);
  await chat.getByRole('button', { name: 'Connect KolmoPDF', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'KolmoPDF', exact: true });
  await dialog.getByLabel('KolmoPDF API key', { exact: true }).fill('test-key'); await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog.getByText('Connected', { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Read full PDF', exact: true }).click();
  await expect(chat.getByText('Full document ready', { exact: true })).toBeVisible();
  for (const [index, question] of ['Summarize this reading.', 'What else?'].entries()) {
    await chat.getByRole('textbox', { name: 'Message' }).fill(question); await chat.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(chat.getByText(`Reading answer ${index + 1}.`, { exact: true })).toBeVisible();
  }
  expect(parses).toBe(1); expect(requests.every(request => request.context.referenceEvidence?.[0]?.text.includes('Known reading result.'))).toBe(true);
  const downloading = page.waitForEvent('download'); await chat.getByRole('button', { name: 'Download Markdown', exact: true }).click(); const file = await downloading;
  expect(file.suggestedFilename()).toBe('reading.md'); expect(await readFile((await file.path())!, 'utf8')).toContain('Known reading result.');
});
