import { notFound } from 'next/navigation';
import { UI_LOCALES } from '@pdf-editor/editor/i18n-locales';
import { toolsForLocale, getTool } from '@/lib/tool-content';
import { ToolPage } from '@/components/site-pages/tools';
import { pageMetadata, routeLocale } from '@/lib/site-seo';
export const dynamicParams = false;
export function generateStaticParams({ params }: { params: { locale: string } }) { return toolsForLocale(routeLocale(params.locale)).map(tool => ({ tool: tool.slug })); }
export async function generateMetadata({ params }: { params: Promise<{ locale: string; tool: string }> }) { const values = await params; const locale = routeLocale(values.locale); if (!getTool(values.tool, locale)) notFound(); return pageMetadata(locale, `/tools/${values.tool}/`); }
export default async function Page({ params }: { params: Promise<{ locale: string; tool: string }> }) { const values = await params; const locale = routeLocale(values.locale); const tool = getTool(values.tool, locale); if (!tool) notFound(); return <ToolPage locale={locale} tool={tool} />; }
