import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AccountService } from '../accounts.js';
import { normalizeUiLocale } from '../../../../packages/editor/src/ui/locales.js';
import { supportCopy } from '../../../../packages/editor/src/ui/support/copy.js';
import { SupportRate, SupportError, supportAction, supportChat, supportObject, sendSupportMail, type SupportEnvironment, type SupportIdentity } from './engine.js';
import { SupportSqliteStore } from './store.js';

export type SupportOptions = { store: SupportSqliteStore; environment: SupportEnvironment; adminIds: string[] };
export function registerSupport(app: FastifyInstance, options: SupportOptions, accounts?: AccountService) {
  const rate = new SupportRate();
  const fail = (reply: FastifyReply, error: unknown) => {
    const known = error as { status?: number; statusCode?: number };
    const status = known?.status || known?.statusCode || 503;
    return reply.code(status).send({ error: { code: status === 403 ? 'FORBIDDEN' : 'SUPPORT_REQUEST_FAILED' } });
  };
  async function identity(request: FastifyRequest, reply: FastifyReply): Promise<SupportIdentity> {
    const origin = request.headers.origin;
    if (origin && origin !== new URL(options.environment.appUrl).origin || request.headers['sec-fetch-site'] === 'cross-site') throw new SupportError(403,'FORBIDDEN');
    if (request.headers.authorization) {
      if (!accounts) throw new SupportError(401,'SIGN_IN_REQUIRED');
      const id = await accounts.authenticate(request);
      return { key: `user:${id}`, userId: id, isAdmin: options.adminIds.includes(id) };
    }
    const cookie = /(?:^|;\s*)komo_support_guest=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
    const header = request.headers['x-support-guest'];
    let token = typeof header === 'string' && /^[A-Za-z0-9_-]{43}$/.test(header) ? header : cookie;
    if (!token) {
      token = randomBytes(32).toString('base64url');
      reply.header('set-cookie', `komo_support_guest=${token}; HttpOnly; Secure; SameSite=Lax; Path=/api/support; Max-Age=2592000`);
      if (!origin && request.headers['x-support-client'] === 'desktop') (request as FastifyRequest & { supportGuest?: string }).supportGuest = token;
    }
    return { key: `guest:${createHash('sha256').update(token).digest('hex')}`, userId: null, isAdmin: false };
  }
  app.post('/api/support', { bodyLimit: 100_000 }, async (request, reply) => {
    reply.header('cache-control','no-store');
    try {
      const actor = await identity(request,reply); const body = supportObject(request.body); const locale = normalizeUiLocale(String(body.locale || 'en')) || 'en';
      rate.take(`request:${request.ip}`,90);
      const notify = async (id: string, messageId: string, retry = false) => {
        const ticket = options.store.detail(actor,id);
        void sendSupportMail(options.store,actor,id,messageId,options.environment,supportCopy(String(ticket.locale)),retry).catch(() => {
          console.error(JSON.stringify({ event: 'support.mail.failure', ticketId: id }));
        });
      };
      const data = await supportAction(options.store,actor,body,locale,notify);
      const guest = (request as FastifyRequest & { supportGuest?: string }).supportGuest;
      return { data: guest && body.action === 'session' ? { ...supportObject(data), guestToken: guest } : data };
    } catch (error) { return fail(reply,error); }
  });
  app.post('/api/support/chat', { bodyLimit: 100_000 }, async (request, reply) => {
    reply.header('cache-control','no-store');
    try {
      await identity(request,reply); rate.take(`chat:${request.ip}`,20);
      const body = supportObject(request.body); const locale = normalizeUiLocale(String(body.locale || 'en')) || 'en';
      const controller = new AbortController(); reply.raw.once('close', () => controller.abort());
      const response = await supportChat(body,locale,options.environment,controller.signal);
      reply.type('text/plain; charset=utf-8');
      return reply.send(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream));
    } catch (error) { return fail(reply,error); }
  });
}
