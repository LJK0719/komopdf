import { pageMetadata, structuredData } from '@/lib/site-seo';
export async function generateMetadata() { return pageMetadata('en', '/help/'); }
import Content from '@/components/site-pages/help';
export default async function Page() { const locale = 'en';
return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(await structuredData(locale, '/help/')).replace(/</g, '\\u003c') }} /><Content /></>; }
