import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { I18nProvider } from '@pdf-editor/editor/i18n';
import type { UiLocale } from '@pdf-editor/editor/i18n-locales';
import { getSiteI18n } from '@/lib/site-seo';
import { SupportWidget } from './support-entry';
import '@/app/globals.css';

export const siteViewport: Viewport = { themeColor: '#1b1d1b', width: 'device-width', initialScale: 1 };
export const siteMetadata: Metadata = {
  icons: {
    icon: [{ url: '/favicon.ico', sizes: 'any' }, { url: '/icon.svg', type: 'image/svg+xml', sizes: 'any' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export async function SiteRoot({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  const { messages } = await getSiteI18n(locale);
  return <html lang={locale}><body className="min-h-screen antialiased">
    <I18nProvider key={locale} initialLocale={locale} messages={messages} detectLanguage={false} messageScope="public">{children}<SupportWidget /></I18nProvider>
  </body></html>;
}
