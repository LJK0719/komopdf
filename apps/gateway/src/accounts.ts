import { createClerkClient, verifyToken } from '@clerk/backend';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AccountError, AccountStore, type AccountLease } from './account-store.js';

export type AccountConfig = { publishableKey: string; secretKey: string; publicOrigin: string;
  stripeKey?: string | undefined; stripePriceId?: string | undefined; stripePortalConfigurationId?: string | undefined;
  webhookSecret?: string | undefined; automaticTax?: boolean };
export class AccountService {
  readonly stripe: Stripe | undefined;
  readonly clerk: ReturnType<typeof createClerkClient>;
  private readonly checkouts = new Map<string, Promise<string>>();
  constructor(readonly store: AccountStore, readonly config: AccountConfig) {
    this.stripe = config.stripeKey ? new Stripe(config.stripeKey) : undefined;
    this.clerk = createClerkClient({ secretKey: config.secretKey, publishableKey: config.publishableKey });
  }
  async account(id: string) {
    const user = await this.clerk.users.getUser(id);
    return { ...this.store.snapshot(id), billingAvailable: Boolean(this.stripe && this.config.stripePriceId && this.config.webhookSecret),
      profile: { name: user.fullName || user.firstName || '',
        email: user.emailAddresses.find(email => email.id === user.primaryEmailAddressId)?.emailAddress || '', imageUrl: user.imageUrl } };
  }
  async authenticate(request: FastifyRequest, clerkOnly = false): Promise<string> {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new AccountError('SIGN_IN_REQUIRED', 401, 'Sign in to continue.');
    if (!clerkOnly && token.startsWith('komo_')) {
      const id = this.store.session(token);
      if (id) return id;
    } else {
      try {
        const claims = await verifyToken(token, { secretKey: this.config.secretKey,
          authorizedParties: [this.config.publicOrigin] });
        if (claims.sub && claims.iss) return claims.sub;
      } catch { /* Return a safe authentication error, never a token or SDK detail. */ }
    }
    throw new AccountError('SESSION_EXPIRED', 401, 'Your session has expired. Sign in again.');
  }
  reserve(id: string, inputBytes: number, output: number, minimumOutput = 1): { lease: AccountLease; maxOutput: number } {
    return this.store.reserve(id, inputBytes, output, minimumOutput);
  }
  private billing(): Stripe {
    if (!this.stripe || !this.config.stripePriceId) throw new AccountError('BILLING_NOT_CONFIGURED', 503, 'Subscriptions are currently unavailable. Please try again later.');
    return this.stripe;
  }
  async syncSubscription(id: string, subscriptionId: string): Promise<void> {
    const subscription = await this.billing().subscriptions.retrieve(subscriptionId);
    const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    if (this.store.user(id).customer !== customer) throw new AccountError('INVALID_SUBSCRIPTION', 400, 'Subscription does not belong to this account.');
    const item = subscription.items.data.find(item => item.price.id === this.config.stripePriceId);
    const current = this.store.user(id);
    if (!item) {
      if (current.subscription === subscription.id) {
        this.store.setSubscription(id, subscription.id, subscription.status, 0, subscription.cancel_at_period_end);
      }
      return;
    }
    if (current.subscription && current.subscription !== subscription.id && subscription.status !== 'active') return;
    this.store.setSubscription(id, subscription.id, subscription.status, item.current_period_end, subscription.cancel_at_period_end);
  }
  checkout(id: string): Promise<string> {
    const pending = this.checkouts.get(id);
    if (pending) return pending;
    const checkout = this.createCheckout(id).finally(() => this.checkouts.delete(id));
    this.checkouts.set(id, checkout);
    return checkout;
  }
  private async createCheckout(id: string): Promise<string> {
    const stripe = this.billing();
    const price = await stripe.prices.retrieve(this.config.stripePriceId!);
    if (!price.active || price.currency !== 'usd' || price.unit_amount !== 499 || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) {
      throw new AccountError('INVALID_PRICE', 503, 'The $4.99/month subscription price is not configured correctly.');
    }
    let user = this.store.user(id);
    if (!user.customer) {
      const customer = await stripe.customers.create({ metadata: { komoUserId: id, product: 'komopdf' } }, { idempotencyKey: `komopdf-customer-${id}` });
      this.store.setCustomer(id, customer.id); user = this.store.user(id);
    }
    // Check Stripe too: a delayed webhook must not cause a duplicate subscription.
    const existing = await stripe.subscriptions.list({ customer: user.customer!, status: 'all', limit: 100 });
    if (existing.data.some(sub => ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'].includes(sub.status)
      && sub.items.data.some(item => item.price.id === this.config.stripePriceId))) return this.portal(id);
    const openSessions = await stripe.checkout.sessions.list({ customer: user.customer!, status: 'open', limit: 100 });
    const pending = openSessions.data.find(session => session.mode === 'subscription' && session.client_reference_id === id
      && session.metadata?.komoPriceId === this.config.stripePriceId && session.url);
    if (pending?.url) return pending.url;
    const session = await stripe.checkout.sessions.create({ mode: 'subscription', customer: user.customer!,
      line_items: [{ price: this.config.stripePriceId!, quantity: 1 }], client_reference_id: id,
      metadata: { komoUserId: id, komoPriceId: this.config.stripePriceId! }, subscription_data: { metadata: { komoUserId: id, product: 'komopdf' } },
      customer_update: { address: 'auto' }, automatic_tax: { enabled: this.config.automaticTax ?? true },
      success_url: `${this.config.publicOrigin}/account/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.config.publicOrigin}/account/?checkout=cancelled`,
    }, { idempotencyKey: `komopdf-checkout-${id}-${randomUUID()}` });
    if (!session.url) throw new AccountError('CHECKOUT_UNAVAILABLE', 503, 'Checkout is unavailable.');
    return session.url;
  }
  async portal(id: string): Promise<string> {
    const customer = this.store.user(id).customer;
    if (!customer) throw new AccountError('NO_SUBSCRIPTION', 400, 'No billing account exists yet.');
    return (await this.billing().billingPortal.sessions.create({ customer, return_url: `${this.config.publicOrigin}/account/`,
      ...(this.config.stripePortalConfigurationId ? { configuration: this.config.stripePortalConfigurationId } : {}) })).url;
  }
  register(app: FastifyInstance): void {
    const route = (handler: (request: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
      reply.header('cache-control', 'no-store');
      try { return await handler(request); }
      catch (error) {
        const known = error instanceof AccountError;
        return reply.code(known ? error.statusCode : 503).send({ error: { code: known ? error.code : 'ACCOUNT_UNAVAILABLE', message: known ? error.message : 'Account service temporarily unavailable.' } });
      }
    };
    app.get('/api/account/config', async () => ({ publishableKey: this.config.publishableKey }));
    app.get('/api/account', route(async request => this.account(await this.authenticate(request))));
    app.post('/api/account/login', route(async request => {
      const body = request.body as { redirectUri?: unknown; codeChallenge?: unknown; state?: unknown };
      let redirect: URL;
      try { redirect = new URL(String(body?.redirectUri)); } catch { throw new AccountError('INVALID_REQUEST', 400, 'Invalid sign-in request.'); }
      if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port
        || !/^\/callback\/[a-f0-9-]{36}$/.test(redirect.pathname) || redirect.search || redirect.hash || redirect.username || redirect.password
        || typeof body?.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.codeChallenge)
        || typeof body?.state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(body.state)) {
        throw new AccountError('INVALID_REQUEST', 400, 'Invalid sign-in request.');
      }
      const id = this.store.createLogin(body.codeChallenge, redirect.href, body.state);
      return { authorizationUrl: `${this.config.publicOrigin}/sign-in/?desktop=${id}` };
    }));
    app.post('/api/account/login/complete', route(async request => {
      const userId = await this.authenticate(request, true);
      const id = (request.body as { id?: unknown })?.id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw new AccountError('INVALID_REQUEST', 400, 'Invalid sign-in request.');
      return { redirectUrl: this.store.completeLogin(id, userId) };
    }));
    app.post('/api/account/login/exchange', route(async request => {
      const body = request.body as { code?: unknown; codeVerifier?: unknown; redirectUri?: unknown };
      if (typeof body?.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.code)
        || typeof body.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier)
        || typeof body.redirectUri !== 'string') throw new AccountError('INVALID_REQUEST', 400, 'Invalid sign-in request.');
      return { token: this.store.exchangeLogin(body.code, body.codeVerifier, body.redirectUri) };
    }));
    app.post('/api/account/logout', route(async request => {
      const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      if (token.startsWith('komo_')) this.store.revoke(token);
      else await this.authenticate(request);
      return { ok: true };
    }));
    app.post('/api/account/checkout', route(async request => ({ url: await this.checkout(await this.authenticate(request)) })));
    app.post('/api/account/portal', route(async request => ({ url: await this.portal(await this.authenticate(request)) })));
    app.post('/api/account/checkout/confirm', route(async request => {
      const id = await this.authenticate(request);
      const sessionId = (request.body as { sessionId?: unknown })?.sessionId;
      if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new AccountError('INVALID_REQUEST', 400, 'Invalid checkout session.');
      const session = await this.billing().checkout.sessions.retrieve(sessionId);
      if (session.client_reference_id !== id || session.customer !== this.store.user(id).customer || session.status !== 'complete') {
        throw new AccountError('CHECKOUT_PENDING', 409, 'Payment is not confirmed yet.');
      }
      if (typeof session.subscription === 'string') await this.syncSubscription(id, session.subscription);
      return this.store.snapshot(id);
    }));
    // Encapsulated raw parser: Stripe signatures cover the exact bytes, not JSON reserialization.
    app.register(async webhook => {
      webhook.removeContentTypeParser('application/json');
      webhook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
      webhook.post('/api/account/webhook', async (request, reply) => {
        if (!this.stripe || !this.config.webhookSecret) return reply.code(503).send({ error: 'Webhook is not configured' });
        let event: Stripe.Event;
        try { event = this.stripe.webhooks.constructEvent(request.body as Buffer, request.headers['stripe-signature'] as string, this.config.webhookSecret); }
        catch { return reply.code(400).send({ error: 'Invalid webhook signature' }); }
        try {
          if (event.type.startsWith('customer.subscription.')) {
            const subscription = event.data.object as Stripe.Subscription;
            const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
            const id = this.store.customerUser(customer);
            if (id) await this.syncSubscription(id, subscription.id);
          } else if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
            const session = event.data.object as Stripe.Checkout.Session;
            const id = typeof session.customer === 'string' ? this.store.customerUser(session.customer) : undefined;
            if (id && typeof session.subscription === 'string') await this.syncSubscription(id, session.subscription);
          }
          return { received: true };
        } catch { return reply.code(503).send({ error: 'Webhook processing temporarily unavailable' }); }
      });
    });
  }
}
