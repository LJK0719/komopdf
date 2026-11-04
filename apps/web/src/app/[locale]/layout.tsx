import type { ReactNode } from 'react';
import { UI_LOCALES } from '@pdf-editor/editor/i18n-locales';
import { SiteRoot, siteViewport, siteMetadata } from '@/components/site-root';
export const metadata = siteMetadata;
import { routeLocale } from '@/lib/site-seo';
export const viewport = siteViewport;
export const dynamicParams = false;
export function generateStaticParams() { return UI_LOCALES.filter(locale => locale.id !== 'en').map(locale => ({ locale: locale.path })); }
export default async function Layout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) { const { locale } = await params; return <SiteRoot locale={routeLocale(locale)}>{children}</SiteRoot>; }
