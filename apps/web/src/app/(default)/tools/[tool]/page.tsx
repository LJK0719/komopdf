import { notFound } from 'next/navigation';
import { UI_LOCALES } from '@pdf-editor/editor/i18n-locales';
import { toolsForLocale, getTool } from '@/lib/tool-content';
import { ToolPage } from '@/components/site-pages/tools';
import { pageMetadata } from '@/lib/site-seo';
export const dynamicParams = false;
export function generateStaticParams() { return toolsForLocale('en').map(tool => ({ tool: tool.slug })); }
export async function generateMetadata({ params }: { params: Promise<{ tool: string }> }) { const values = await params; const locale = 'en'; if (!getTool(values.tool, locale)) notFound(); return pageMetadata(locale, `/tools/${values.tool}/`); }
export default async function Page({ params }: { params: Promise<{ tool: string }> }) { const values = await params; const locale = 'en'; const tool = getTool(values.tool, locale); if (!tool) notFound(); return <ToolPage locale={locale} tool={tool} />; }
