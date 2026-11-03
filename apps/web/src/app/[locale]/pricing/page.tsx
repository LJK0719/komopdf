import { pageMetadata, structuredData, routeLocale } from '@/lib/site-seo';
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) { return pageMetadata(routeLocale((await params).locale), '/pricing/'); }
import { PricingPage } from '@/components/site-pages/pricing';
export default async function Page({ params }: { params: Promise<{ locale: string }> }) { const locale = routeLocale((await params).locale);
return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(await structuredData(locale, '/pricing/')).replace(/</g, '\\u003c') }} /><PricingPage locale={locale} /></>; }
