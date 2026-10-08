import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { AccountStore, FREE_TOKENS } from '../src/account-store.js';
import { AccountService } from '../src/accounts.js';
import { buildGateway } from '../src/server.js';
import { AI_LIMITS } from '@pdf-editor/contracts';
import type { GatewayConfig } from '../src/config.js';

const stores: AccountStore[] = [];
const apps: ReturnType<typeof buildGateway>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const app of apps.splice(0)) await app.close(); for (const store of stores.splice(0)) store.close(); });
function store() { const result = new AccountStore(':memory:'); stores.push(result); return result; }
const config: GatewayConfig = { provider: { baseUrl: 'https://example.invalid', model: 'gemini-3.8-flash-high', displayName: 'test' }, credentialName: 'test',
  limits: { ...AI_LIMITS, agentBodyBytes: AI_LIMITS.imageBodyBytes, upstreamFrameBytes: AI_LIMITS.upstreamBytes,
    upstreamStreamBytes: AI_LIMITS.upstreamBytes * 4, agentMaxOutputTokens: 32_768 } };

describe('KOMO accounts and token ledger (isolated in-memory database)', () => {
  it('grants 1,000 credits once, counts actual tokens and settles each request once', () => {
    const db = store();
    expect(db.snapshot('user-a').remainingCredits).toBe(1000);
    const { lease } = db.reserve('user-a', 5000, 1000);
    db.settle(lease, { promptTokenCount: 110, candidatesTokenCount: 90, totalTokenCount: 200 }, true);
    db.settle(lease, { totalTokenCount: 200 }, true);
    expect(db.snapshot('user-a').remainingCredits).toBe(999.98);
    expect(db.snapshot('user-a').tokensPerCredit).toBe(10_000);
    expect(FREE_TOKENS).toBe(10_000_000);
    expect(db.snapshot('user-b').remainingCredits).toBe(1000);
    expect(db.user('user-a').spent).toBe(200);
  });
  it('reserves concurrent requests and clamps output to remaining free tokens', () => {
    const db = store(); const first = db.reserve('u', FREE_TOKENS - 40_000, 30_000);
    expect(() => db.reserve('u', 10_000, 100)).toThrow('Not enough credits');
    expect(db.reserve('u', 9900, 1000).maxOutput).toBe(100);
    db.settle(first.lease, null, false);
    expect(db.snapshot('u').remainingCredits).toBe(999);
  });
  it('charges partial observed usage on cancellation, not a failed request without usage', () => {
    const db = store();
    const partial = db.reserve('u', 10_000, 1000);
    db.settle(partial.lease, { promptTokenCount: 500, candidatesTokenCount: 100, totalTokenCount: 600 }, false);
    const failed = db.reserve('u', 10_000, 1000); db.settle(failed.lease, null, false);
    expect(db.snapshot('u').remainingCredits).toBe(999.94);
  });
  it('removes the ceiling only for a paid active subscription, and keeps end-of-period access after cancellation', () => {
    const db = store(); db.user('u');
    db.setSubscription('u', 'sub_test', 'active', Date.now() / 1000 + 3600, true);
    const charge = db.reserve('u', FREE_TOKENS * 2, 32_000);
    db.settle(charge.lease, { totalTokenCount: FREE_TOKENS * 2 }, true);
    expect(db.snapshot('u').plan).toBe('plus');
    expect(db.reserve('u', 200_000, 32_000).maxOutput).toBe(32_000);
    db.setSubscription('u', 'sub_test', 'past_due', Date.now() / 1000 + 3600, false);
    expect(db.snapshot('u').plan).toBe('free');
    expect(() => db.reserve('u', 100, 100)).toThrow();
  });
  it('does not replace an explicitly reported zero usage with the reserved ceiling', () => {
    const db = store();
    const charge = db.reserve('u', 10_000, 1000);
    db.settle(charge.lease, { totalTokenCount: 0 }, true);
    expect(db.snapshot('u').remainingCredits).toBe(1000);
  });
  it('coalesces concurrent Checkout requests and uses a new key after a closed session', async () => {
    const db = store(); db.setCustomer('u', 'cus_test');
    const service = new AccountService(db, { publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder',
      publicOrigin: 'https://komopdf.com', stripeKey: 'rk_test_placeholder', stripePriceId: 'price_test' });
    const stripe = service.stripe!;
    vi.spyOn(stripe.prices, 'retrieve').mockResolvedValue({ active: true, currency: 'usd', unit_amount: 499,
      recurring: { interval: 'month', interval_count: 1 } } as never);
    vi.spyOn(stripe.subscriptions, 'list').mockResolvedValue({ data: [] } as never);
    vi.spyOn(stripe.checkout.sessions, 'list').mockResolvedValue({ data: [] } as never);
    const create = vi.spyOn(stripe.checkout.sessions, 'create').mockResolvedValue({ url: 'https://checkout.stripe.com/test' } as never);
    await Promise.all([service.checkout('u'), service.checkout('u')]);
    expect(create).toHaveBeenCalledOnce();
    const firstKey = create.mock.calls[0]![1]?.idempotencyKey;
    await service.checkout('u');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![1]?.idempotencyKey).not.toBe(firstKey);
  });
  it('prefills Checkout customer identity from the signed-in account', async () => {
    const service = new AccountService(store(), { publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder',
      publicOrigin: 'https://komopdf.com', stripeKey: 'rk_test_placeholder', stripePriceId: 'price_test' });
    vi.spyOn(service.clerk.users, 'getUser').mockResolvedValue({ fullName: 'Reader', primaryEmailAddressId: 'email-1',
      emailAddresses: [{ id: 'email-1', emailAddress: 'reader@example.com' }], imageUrl: '' } as never);
    vi.spyOn(service.stripe!.prices, 'retrieve').mockResolvedValue({ active: true, currency: 'usd', unit_amount: 499,
      recurring: { interval: 'month', interval_count: 1 } } as never);
    const create = vi.spyOn(service.stripe!.customers, 'create').mockResolvedValue({ id: 'cus_reader' } as never);
    vi.spyOn(service.stripe!.subscriptions, 'list').mockResolvedValue({ data: [] } as never);
    vi.spyOn(service.stripe!.checkout.sessions, 'list').mockResolvedValue({ data: [] } as never);
    vi.spyOn(service.stripe!.checkout.sessions, 'create').mockResolvedValue({ url: 'https://checkout.stripe.com/test' } as never);
    await service.checkout('reader');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ email: 'reader@example.com', name: 'Reader' }), expect.anything());
  });
  it('removes Plus access when the current subscription no longer contains the KOMO price', async () => {
    const db = store(); db.setCustomer('u', 'cus_test');
    db.setSubscription('u', 'sub_test', 'active', Date.now() / 1000 + 3600, false);
    const service = new AccountService(db, { publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder',
      publicOrigin: 'https://komopdf.com', stripeKey: 'rk_test_placeholder', stripePriceId: 'price_test' });
    vi.spyOn(service.stripe!.subscriptions, 'retrieve').mockResolvedValue({ id: 'sub_test', customer: 'cus_test',
      status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_other' } }] } } as never);
    await service.syncSubscription('u', 'sub_test');
    expect(db.snapshot('u').plan).toBe('free');
  });
  it('releases a reservation when an agent request times out before forwarding', async () => {
    const db = store(); const token = db.createSession('u');
    const service = new AccountService(db, { publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder', publicOrigin: 'https://komopdf.com' });
    vi.spyOn(service, 'reserve').mockImplementation((...args) => {
      const result = db.reserve(...args);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + config.limits.requestTimeoutMs + 1);
      return result;
    });
    const forward = vi.fn(async () => { throw new Error('Must not forward an expired request'); });
    const app = buildGateway({ config, accounts: service, agentProxy: { forward },
      provider: { generate: async () => { throw new Error('unused'); }, async *stream() {} } }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/api/agent/v1/messages',
      headers: { authorization: `Bearer ${token}` }, payload: { max_tokens: 100, messages: [] } });
    expect(response.statusCode).toBe(504); expect(forward).not.toHaveBeenCalled();
    expect(db.snapshot('u').remainingCredits).toBe(1000);
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM leases').get()!.count).toBe(0);
  });
  it('exchanges an authenticated browser login only with its PKCE verifier, once', () => {
    const db = store(); const verifier = 'a'.repeat(43);
    const redirect = 'http://127.0.0.1:49152/callback/11111111-1111-4111-8111-111111111111';
    const id = db.createLogin(createHash('sha256').update(verifier).digest('base64url'), redirect, 'state');
    const result = new URL(db.completeLogin(id, 'clerk-user'));
    expect(result.searchParams.get('state')).toBe('state');
    const code = result.searchParams.get('code')!;
    expect(() => db.exchangeLogin(code, 'b'.repeat(43), redirect)).toThrow();
    expect(() => db.exchangeLogin(code, verifier, redirect + 'other')).toThrow();
    const token = db.exchangeLogin(code, verifier, redirect);
    expect(db.session(token)).toBe('clerk-user');
    expect(() => db.exchangeLogin(code, verifier, redirect)).toThrow();
    expect(JSON.stringify(db.db.prepare('SELECT * FROM sessions').all())).not.toContain(token);
    db.revoke(token); expect(db.session(token)).toBeUndefined();
  });
  it('rejects non-loopback callbacks and requires Clerk authentication to complete login', async () => {
    const service = new AccountService(store(), { publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder', publicOrigin: 'https://komopdf.com' });
    const app = buildGateway({ config, accounts: service, provider: { generate: async () => { throw new Error('unused'); }, async *stream() {} } }); apps.push(app);
    for (const redirectUri of ['https://evil.example/callback/x', 'http://localhost:9000/callback/x', 'http://127.0.0.1:9000/not-a-callback']) {
      expect((await app.inject({ method: 'POST', url: '/api/account/login', payload: { redirectUri, codeChallenge: 'a'.repeat(43), state: 'a'.repeat(43) } })).statusCode).toBe(400);
    }
    const started = await app.inject({ method: 'POST', url: '/api/account/login', payload: {
      redirectUri: 'http://127.0.0.1:49152/callback/11111111-1111-4111-8111-111111111111', codeChallenge: 'a'.repeat(43), state: 'a'.repeat(43) } });
    expect(started.statusCode).toBe(200);
    expect(started.json().authorizationUrl).toMatch(/^https:\/\/komopdf.com\/sign-in\/\?desktop=/);
    expect(started.json()).not.toHaveProperty('code');
    expect((await app.inject({ method: 'POST', url: '/api/account/login/complete', payload: { id: 'a'.repeat(43) } })).statusCode).toBe(401);
  });
  it('completes browser authentication, returns a loopback code and exchanges it for an account session', async () => {
    const db = store();
    const service = new AccountService(db, { publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder', publicOrigin: 'https://komopdf.com' });
    const app = buildGateway({ config, accounts: service, provider: { generate: async () => { throw new Error('unused'); }, async *stream() {} } }); apps.push(app);
    const verifier = 'v'.repeat(43);
    const redirectUri = 'http://127.0.0.1:49152/callback/11111111-1111-4111-8111-111111111111';
    const response = await app.inject({ method: 'POST', url: '/api/account/login', payload: { redirectUri,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'), state: 's'.repeat(43) } });
    const id = new URL(response.json().authorizationUrl).searchParams.get('desktop');
    const auth = vi.spyOn(service, 'authenticate').mockResolvedValueOnce('browser-user');
    const complete = await app.inject({ method: 'POST', url: '/api/account/login/complete', payload: { id } });
    expect(auth.mock.calls[0]?.[1]).toBe(true);
    auth.mockRestore();
    const callback = new URL(complete.json().redirectUrl);
    expect(callback.origin).toBe('http://127.0.0.1:49152');
    expect(callback.searchParams.get('state')).toBe('s'.repeat(43));
    const exchange = await app.inject({ method: 'POST', url: '/api/account/login/exchange', payload: {
      code: callback.searchParams.get('code'), codeVerifier: verifier, redirectUri } });
    expect(exchange.statusCode).toBe(200);
    expect(db.session(exchange.json().token)).toBe('browser-user');
    const replay = await app.inject({ method: 'POST', url: '/api/account/login/exchange', payload: {
      code: callback.searchParams.get('code'), codeVerifier: verifier, redirectUri } });
    expect(replay.statusCode).toBe(400);
  });
  it('coalesces profile reads but keeps credit balances fresh', async () => {
    const db = store(); const service = new AccountService(db, { publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder', publicOrigin: 'https://komopdf.com' });
    const getUser = vi.spyOn(service.clerk.users, 'getUser').mockResolvedValue({ fullName: 'Reader', emailAddresses: [], imageUrl: '' } as never);
    await Promise.all([service.account('u'), service.account('u'), service.account('u')]);
    expect(getUser).toHaveBeenCalledOnce();
    const { lease } = db.reserve('u', 100, 100);
    db.settle(lease, { totalTokenCount: 200 }, true);
    expect((await service.account('u')).remainingCredits).toBe(999.98);
    expect(getUser).toHaveBeenCalledOnce();
  });
  it('does not let a running model request block account status from the same client', async () => {
    const db = store(); const token = db.createSession('u');
    const service = new AccountService(db, { publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder', publicOrigin: 'https://komopdf.com' });
    vi.spyOn(service.clerk.users, 'getUser').mockResolvedValue({ fullName: 'Reader', emailAddresses: [], imageUrl: '' } as never);
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
    const app = buildGateway({ config: { ...config, limits: { ...config.limits, perIpInFlight: 1 } }, accounts: service,
      provider: { generate: async () => { throw new Error('unused'); }, async *stream() {} },
      agentProxy: { forward: async request => {
        started(); await waiting; request.response.writeHead(200, { 'content-type': 'application/json' }); request.response.end('{}');
        return { usage: { totalTokenCount: 0 }, finishReason: 'end_turn', streamError: false };
      } } }); apps.push(app);
    const pending = app.inject({ method: 'POST', url: '/api/agent/v1/messages', headers: { authorization: `Bearer ${token}` },
      payload: { max_tokens: 100, messages: [] } }).then(response => response);
    await ready;
    try {
      const response = await app.inject({ url: '/api/account', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(200); expect(response.json().profile.name).toBe('Reader');
    } finally { finish(); await pending; }
  });
  it('fails closed for all paid AI routes, but leaves health and metadata public', async () => {
    const app = buildGateway({ config, provider: { generate: async () => { throw new Error('Must not call provider'); }, async *stream() { throw new Error('Must not call provider'); } } });
    apps.push(app);
    for (const url of ['/api/v1/ai/requests', '/api/v1/ai/image-requests', '/api/agent/v1/messages', '/api/agent/v1/messages/count_tokens']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(503);
    }
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });
  it('authenticates a paired desktop session and rejects forged Stripe events', async () => {
    const db = store(); const token = db.createSession('u');
    const service = new AccountService(db, { publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder', publicOrigin: 'https://komopdf.com', stripeKey: 'rk_test_placeholder', webhookSecret: 'whsec_placeholder' });
    const app = buildGateway({ config, accounts: service, provider: { generate: async () => { throw new Error('unused'); }, async *stream() {} } }); apps.push(app);
    expect((await app.inject('/api/account')).statusCode).toBe(401);
    vi.spyOn(service.clerk.users, 'getUser').mockResolvedValue({ fullName: 'Test Reader', firstName: 'Test',
      primaryEmailAddressId: 'email-1', emailAddresses: [{ id: 'email-1', emailAddress: 'reader@example.com' }], imageUrl: '' } as never);
    const account = await app.inject({ url: '/api/account', headers: { authorization: `Bearer ${token}` } });
    expect(account.json().remainingCredits).toBe(1000);
    expect((await app.inject({ method: 'POST', url: '/api/account/webhook', headers: { 'stripe-signature': 'fake' }, payload: { type: 'customer.subscription.updated' } })).statusCode).toBe(400);
    expect(db.snapshot('u').plan).toBe('free');
  });
});
