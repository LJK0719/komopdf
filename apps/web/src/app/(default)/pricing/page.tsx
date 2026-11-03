import { pageMetadata, structuredData } from '@/lib/site-seo';
export async function generateMetadata() { return pageMetadata('en', '/pricing/'); }
import { PricingPage } from '@/components/site-pages/pricing';
export default async function Page() { const locale = 'en';
return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(await structuredData(locale, '/pricing/')).replace(/</g, '\\u003c') }} /><PricingPage locale={locale} /></>; }
