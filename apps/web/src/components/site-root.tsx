import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import { I18nProvider } from '@pdf-editor/editor/i18n';
import type { UiLocale } from '@pdf-editor/editor/i18n-locales';
import { getSiteI18n } from '@/lib/site-seo';
import '@/app/globals.css';

export const siteViewport: Viewport = { themeColor: '#1b1d1b', width: 'device-width', initialScale: 1 };

export async function SiteRoot({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  const { messages } = await getSiteI18n(locale);
  return <html lang={locale}><body className="min-h-screen antialiased">
    <I18nProvider key={locale} initialLocale={locale} messages={messages} detectLanguage={false} messageScope="public">{children}</I18nProvider>
  </body></html>;
}
