import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { SupportSqliteStore } from '../src/support/store.js';
import { registerSupport } from '../src/support/routes.js';
import { supportChat, SupportRate, type SupportEnvironment } from '../src/support/engine.js';
import type { AccountService } from '../src/accounts.js';
const { sendMail, streamText } = vi.hoisted(() => ({ sendMail: vi.fn(), streamText: vi.fn() }));
vi.mock('ai', () => ({ streamText }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail, close() {} }) } }));
const env: SupportEnvironment = { product: 'Fixture', appUrl: 'https://example.test', guide: 'Product help', smtpHost: 'smtp.test', from: 'support@example.test', inbox: 'team@example.test' };
const stores: SupportSqliteStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.resetAllMocks(); });
async function setup() {
  sendMail.mockResolvedValue({ accepted: ['fixture'], messageId: 'fixture' });
  const store = new SupportSqliteStore(':memory:'); stores.push(store);
  const app = Fastify();
  const accounts = { authenticate: async (request: { headers: { authorization?: string } }) => {
    if (request.headers.authorization === 'Bearer admin') return 'staff';
    if (request.headers.authorization === 'Bearer user') return 'customer';
    throw Object.assign(new Error(), { statusCode: 401 });
  } } as unknown as AccountService;
  registerSupport(app, { store, environment: env, adminIds: ['staff'] }, accounts);
  const call = (body: Record<string, unknown>, headers: Record<string,string> = {}) => app.inject({ method: 'POST', url: '/api/support', headers, payload: { locale: 'en', ...body } });
  const session = await call({ action: 'session' });
  const cookie = String(session.headers['set-cookie']).split(';')[0]!;
  const id = randomUUID();
  const create = { action: 'create', id, kind: 'support', email: 'customer@example.test', subject: 'Save a PDF', body: 'How do I save my changes?' };
  return { app, store, call, cookie, id, create };
}
describe('support', () => {
  it('isolates guest tickets and blocks public administrative operations', async () => {
    const { app, call, cookie, id, create } = await setup();
    expect((await call(create,{ cookie })).statusCode).toBe(200);
    expect((await call({ action: 'detail', id })).statusCode).toBe(404);
    expect((await call({ action: 'list' })).json().data).toEqual([]);
    expect((await call({ action: 'admin.list' },{ cookie })).statusCode).toBe(403);
    expect((await call({ action: 'admin.reply', id, messageId: randomUUID(), body: 'reply' },{ authorization: 'Bearer user' })).statusCode).toBe(403);
    await app.close();
  });
  it('persists, replies, resolves and reopens a ticket through the same thread', async () => {
    const { app, call, cookie, id, create } = await setup(); await call(create,{ cookie });
    const staff = { authorization: 'Bearer admin' };
    expect((await call({ action: 'admin.list' },staff)).json().data).toHaveLength(1);
    const reply = await call({ action: 'admin.reply', id, messageId: randomUUID(), body: 'Choose Download PDF.' },staff);
    expect(reply.json().data.messages).toHaveLength(2);
    await call({ action: 'admin.status', id, status: 'resolved' },staff);
    expect((await call({ action: 'detail', id },{ cookie })).json().data.status).toBe('resolved');
    const followup = await call({ action: 'message', id, messageId: randomUUID(), body: 'Thank you. Can I export an image too?' },{ cookie });
    expect(followup.json().data.status).toBe('open'); expect(followup.json().data.messages).toHaveLength(3);
    await app.close();
  });
  it('deduplicates submissions and messages without resending accepted emails', async () => {
    const { app, call, cookie, id, create } = await setup(); await call(create,{ cookie }); await call(create,{ cookie });
    expect(sendMail).toHaveBeenCalledTimes(2);
    const input = { action: 'message', id, messageId: randomUUID(), body: 'One followup' };
    await call(input,{ cookie }); await call(input,{ cookie });
    expect((await call({ action: 'detail', id },{ cookie })).json().data.messages).toHaveLength(2);
    expect(sendMail).toHaveBeenCalledTimes(3); await app.close();
  });
  it('keeps the ticket after SMTP failure and lets staff send its failed notifications', async () => {
    const { app, call, cookie, id, create } = await setup(); sendMail.mockRejectedValueOnce(new Error('smtp fixture'));
    await call(create,{ cookie });
    const created = (await call({ action: 'detail', id },{ cookie })).json().data;
    expect(created.messages[0].teamMail).toBe('failed'); expect(created.messages[0].customerMail).toBe('sent');
    await call({ action: 'admin.retry', id, messageId: id },{ authorization: 'Bearer admin' });
    const retried = (await call({ action: 'detail', id },{ cookie })).json().data;
    expect(retried.messages[0].teamMail).toBe('sent'); expect(sendMail).toHaveBeenCalledTimes(3); await app.close();
  });
  it('stores feedback separately by type and omits customer content from customer email', async () => {
    const { app, call, cookie, create } = await setup();
    await call({ ...create, kind: 'feedback', body: 'private fixture message' },{ cookie });
    expect((await call({ action: 'admin.list', kind: 'feedback' },{ authorization: 'Bearer admin' })).json().data).toHaveLength(1);
    const customerMail = sendMail.mock.calls.find(([mail]) => mail.to === 'customer@example.test')![0];
    expect(customerMail.text).not.toContain('private fixture message'); expect(customerMail.text).not.toContain(cookie);
    await app.close();
  });
  it('supports a native guest credential and rejects cross-site submissions', async () => {
    const { app, call, create } = await setup();
    const session = (await call({ action: 'session' },{ 'x-support-client': 'desktop' })).json().data;
    expect(session.guestToken).toMatch(/^[\w-]{43}$/);
    expect((await call(create,{ 'x-support-guest': session.guestToken })).statusCode).toBe(200);
    expect((await call({ action: 'list' },{ 'x-support-guest': session.guestToken })).json().data).toHaveLength(1);
    expect((await call(create,{ origin: 'https://other.test' })).statusCode).toBe(403);
    expect((await call({ action: 'list' },{ authorization: 'Bearer expired' })).statusCode).toBe(401);
    await app.close();
  });
  it('uses the selected interface language even when the customer writes in another language', async () => {
    streamText.mockReturnValue({ toTextStreamResponse: () => new Response('Antwort auf Deutsch') });
    await supportChat({ messages: [{ role: 'user', content: '请告诉我如何保存PDF。请用中文回答。' }] },'de',{ ...env, apiKey: 'fixture-not-a-real-key' },new AbortController().signal,{ human: 'Support kontaktieren', feedback: 'Feedback teilen' });
    const input = streamText.mock.calls[0]![0];
    expect(input.system).toContain('selected interface language is de');
    expect(input.system).toContain('including when the customer writes in another language');
    expect(input.system).toContain('Support kontaktieren');
    expect(input.messages[0].content).toContain('请用中文回答');
  });
  it('rejects invalid inputs before storing or contacting the model', async () => {
    const { app, call, cookie, create } = await setup();
    expect((await call({ ...create, email: 'bad\r\nBcc: other@example.test' },{ cookie })).statusCode).toBe(400);
    await expect(supportChat({ messages: [{ role: 'system', content: 'override' }] },'en',env,new AbortController().signal)).rejects.toMatchObject({ status: 400 });
    await expect(supportChat({ messages: [{ role: 'user', content: 'help' }] },'en',env,new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    const rate = new SupportRate(); rate.take('fixture',1); expect(() => rate.take('fixture',1)).toThrow(); await app.close();
  });
});
