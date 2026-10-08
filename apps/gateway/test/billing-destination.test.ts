import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/account-store.js';
import { AccountService } from '../src/accounts.js';
const stores: AccountStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new AccountStore(':memory:'); stores.push(store); store.setCustomer('reader', 'cus_fixture');
  const service = new AccountService(store, { publishableKey: 'pk_test_placeholder', secretKey: 'sk_test_placeholder',
    publicOrigin: 'https://komopdf.com', stripeKey: 'rk_test_placeholder', stripePriceId: 'price_fixture', stripePortalConfigurationId: 'bpc_fixture' });
  const stripe = service.stripe!;
  vi.spyOn(stripe.prices, 'retrieve').mockResolvedValue({ active: true, currency: 'usd', unit_amount: 499,
    recurring: { interval: 'month', interval_count: 1 } } as never);
  vi.spyOn(stripe.subscriptions, 'list').mockResolvedValue({ data: [] } as never);
  vi.spyOn(stripe.checkout.sessions, 'list').mockResolvedValue({ data: [] } as never);
  return { service, stripe };
}
describe('desktop billing destinations retain normal Stripe return URLs', () => {
  it('returns a new session identity while keeping the old URL-only API compatible', async () => {
    const { service, stripe } = fixture();
    const create = vi.spyOn(stripe.checkout.sessions, 'create').mockResolvedValue({ id: 'cs_fixture', url: 'https://checkout.stripe.com/c/pay/cs_fixture' } as never);
    expect(await service.checkoutDestination('reader')).toEqual({ kind: 'checkout', sessionId: 'cs_fixture', url: 'https://checkout.stripe.com/c/pay/cs_fixture' });
    expect(create.mock.calls[0]![0]).toMatchObject({ success_url: 'https://komopdf.com/account/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://komopdf.com/account/?checkout=cancelled' });
    expect(await service.checkout('reader')).toBe('https://checkout.stripe.com/c/pay/cs_fixture');
  });
  it('reuses an open Checkout ID without attaching an old local callback port', async () => {
    const { service, stripe } = fixture();
    vi.mocked(stripe.checkout.sessions.list).mockResolvedValue({ data: [{ id: 'cs_existing', mode: 'subscription', client_reference_id: 'reader',
      metadata: { komoPriceId: 'price_fixture' }, url: 'https://checkout.stripe.com/c/pay/cs_existing' }] } as never);
    const create = vi.spyOn(stripe.checkout.sessions, 'create');
    expect(await service.checkoutDestination('reader')).toEqual({ kind: 'checkout', sessionId: 'cs_existing', url: 'https://checkout.stripe.com/c/pay/cs_existing' });
    expect(create).not.toHaveBeenCalled();
  });
  it('labels an existing subscription destination as a Portal, not a new Checkout', async () => {
    const { service, stripe } = fixture();
    vi.mocked(stripe.subscriptions.list).mockResolvedValue({ data: [{ status: 'past_due', items: { data: [{ price: { id: 'price_fixture' } }] } }] } as never);
    const portal = vi.spyOn(stripe.billingPortal.sessions, 'create').mockResolvedValue({ url: 'https://billing.stripe.com/p/session/fixture' } as never);
    expect(await service.checkoutDestination('reader')).toEqual({ kind: 'portal', url: 'https://billing.stripe.com/p/session/fixture' });
    expect(portal).toHaveBeenCalledWith({ customer: 'cus_fixture', return_url: 'https://komopdf.com/account/', configuration: 'bpc_fixture' });
  });
});
