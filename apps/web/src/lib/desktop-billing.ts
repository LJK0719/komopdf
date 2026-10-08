export const DESKTOP_BILLING_KEY = 'komopdf.desktop.billing';
export type DesktopBilling = { url: string; returnUrl: string; state: string; sessionId: string | null; expires: number; lang: 'en' | 'zh-CN' };
export function desktopBilling(value: unknown, now = Date.now()): DesktopBilling | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (typeof data.url !== 'string' || typeof data.returnUrl !== 'string' || typeof data.state !== 'string'
    || !/^[A-Za-z0-9_-]{32,128}$/.test(data.state) || typeof data.expires !== 'number'
    || !Number.isFinite(data.expires) || data.expires <= now || data.expires > now + 30 * 60_000
    || (data.sessionId !== null && (typeof data.sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(data.sessionId)))) return null;
  try {
    const stripe = new URL(data.url); const callback = new URL(data.returnUrl);
    if (!['https://checkout.stripe.com', 'https://billing.stripe.com'].includes(stripe.origin)
      || (stripe.hostname === 'checkout.stripe.com' ? !data.sessionId : data.sessionId !== null)
      || stripe.username || stripe.password || callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1'
      || !callback.port || !/^\/billing\/[a-f0-9-]{36}$/.test(callback.pathname)
      || callback.search || callback.hash || callback.username || callback.password) return null;
    return { url: stripe.href, returnUrl: callback.href, state: data.state, sessionId: data.sessionId as string | null,
      expires: data.expires, lang: data.lang === 'zh-CN' ? 'zh-CN' : 'en' };
  } catch { return null; }
}
export function billingCallback(data: DesktopBilling, query: URLSearchParams): string | null {
  const checkout = query.get('checkout');
  if (data.sessionId) {
    if (checkout !== 'success' && checkout !== 'cancelled') return null;
    if (checkout === 'success' && query.get('session_id') !== data.sessionId) return null;
  } else if (checkout) return null;
  const callback = new URL(data.returnUrl); callback.searchParams.set('state', data.state);
  if (checkout) callback.searchParams.set('checkout', checkout);
  if (checkout === 'success' && data.sessionId) callback.searchParams.set('session_id', data.sessionId);
  return callback.href;
}
