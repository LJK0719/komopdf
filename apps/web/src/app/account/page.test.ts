import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AccountPage from './page';

const account = vi.hoisted(() => ({ account: null, ready: true, signedIn: true,
  error: 'Account service is unavailable. Please try again.', profile: vi.fn(), logout: vi.fn(), request: vi.fn(), refresh: vi.fn() }));
vi.mock('../../components/account-provider', () => ({
  AccountProvider: ({ children }: { children: ReactNode }) => children,
  useKomoAccount: () => account,
}));
vi.mock('../../components/desktop-billing-return', () => ({ DesktopBillingReturn: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../components/navigation', () => ({ SiteNav: () => null, SiteFooter: () => null }));
vi.mock('@pdf-editor/editor/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (text: string) => text, setLocale: vi.fn() }) }));

beforeEach(() => {
  account.signedIn = true; account.error = 'Account service is unavailable. Please try again.';
});
describe('account loading failure recovery', () => {
  it.each(['Account service is unavailable. Please try again.', 'Your session has expired. Sign in again.'])(
    'keeps retry, reauthentication and sign-out available without an account snapshot: %s', error => {
      account.error = error;
      const html = renderToStaticMarkup(createElement(AccountPage));
      expect(html).toContain(error);
      for (const label of ['Retry', 'Sign in again', 'Sign out']) {
        const button = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
        expect(button).toBeDefined();
        expect(button).not.toContain('disabled');
      }
      expect(html).not.toContain('Loading your account…');
    });
  it('offers retry when the account configuration fails before sign-in loads', () => {
    account.signedIn = false;
    const html = renderToStaticMarkup(createElement(AccountPage));
    expect(html).toContain('>Retry</button>');
    expect(html).not.toContain('>Sign out</button>');
    expect(html).not.toContain('>Sign in again</button>');
  });
  it('does not offer recovery actions while the first account request is still pending', () => {
    account.error = '';
    const html = renderToStaticMarkup(createElement(AccountPage));
    expect(html).toContain('Loading your account…');
    expect(html).not.toContain('>Retry</button>');
    expect(html).not.toContain('>Sign in again</button>');
  });
});
