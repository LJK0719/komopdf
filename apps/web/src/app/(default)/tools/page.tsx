import { pageMetadata, structuredData } from '@/lib/site-seo';
export async function generateMetadata() { return pageMetadata('en', '/tools/'); }
import { ToolsIndex } from '@/components/site-pages/tools';
export default async function Page() { const locale = 'en';
return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(await structuredData(locale, '/tools/')).replace(/</g, '\\u003c') }} /><ToolsIndex locale={locale} /></>; }
