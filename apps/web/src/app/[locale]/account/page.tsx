import { pageMetadata, structuredData, routeLocale } from '@/lib/site-seo';
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) { return pageMetadata(routeLocale((await params).locale), '/account/', { noindex: true }); }
import Content from '@/components/site-pages/account';
export default async function Page({ params }: { params: Promise<{ locale: string }> }) { const locale = routeLocale((await params).locale);
return <><Content /></>; }
