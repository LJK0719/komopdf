import { describe, expect, it } from 'vitest';
import { billingCallback, desktopBilling } from './desktop-billing';
const now = 1_000_000;
const checkout = { url: 'https://checkout.stripe.com/c/pay/cs_fixture',
  returnUrl: 'http://127.0.0.1:49152/billing/11111111-1111-4111-8111-111111111111',
  state: 'a'.repeat(43), sessionId: 'cs_fixture', expires: now + 600_000, lang: 'en' };
describe('desktop billing return context', () => {
  it('accepts a short-lived Stripe destination and loopback return', () => {
    expect(desktopBilling(checkout, now)).toEqual(checkout);
  });
  it.each([
    { url: 'https://example.invalid/checkout' }, { url: 'http://checkout.stripe.com/pay' },
    { url: 'https://checkout.stripe.com:444/pay' }, { returnUrl: 'https://example.invalid/callback' },
    { returnUrl: 'http://localhost:49152/billing/11111111-1111-4111-8111-111111111111' },
    { returnUrl: checkout.returnUrl + '?token=not-allowed' }, { returnUrl: checkout.returnUrl + '#fragment' },
    { sessionId: null }, { state: 'short' }, { expires: now - 1 }, { expires: now + 31 * 60_000 }, { expires: NaN },
  ])('rejects an invalid or expired context: %j', patch => {
    expect(desktopBilling({ ...checkout, ...patch }, now)).toBeNull();
  });
  it('returns only the expected Checkout session and carries its state', () => {
    const data = desktopBilling(checkout, now)!;
    const target = new URL(billingCallback(data, new URLSearchParams('checkout=success&session_id=cs_fixture'))!);
    expect(target.origin).toBe('http://127.0.0.1:49152');
    expect(target.searchParams.get('state')).toBe(checkout.state);
    expect(target.searchParams.get('session_id')).toBe('cs_fixture');
    expect(billingCallback(data, new URLSearchParams('checkout=success&session_id=cs_other'))).toBeNull();
    expect(billingCallback(data, new URLSearchParams())).toBeNull();
  });
  it('allows cancellation and Portal return without assigning paid status', () => {
    const data = desktopBilling(checkout, now)!;
    const cancelled = new URL(billingCallback(data, new URLSearchParams('checkout=cancelled'))!);
    expect(cancelled.searchParams.has('session_id')).toBe(false);
    const portal = desktopBilling({ ...checkout, url: 'https://billing.stripe.com/p/session/fixture', sessionId: null }, now)!;
    const callback = new URL(billingCallback(portal, new URLSearchParams())!);
    expect(callback.searchParams.get('state')).toBe(checkout.state);
    expect(callback.searchParams.has('checkout')).toBe(false);
  });
});
