import { pageMetadata, structuredData, routeLocale } from '@/lib/site-seo';
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) { return pageMetadata(routeLocale((await params).locale), '/sign-in/', { noindex: true }); }
import { AuthScreen } from '@/components/auth-screen';
export default async function Page({ params }: { params: Promise<{ locale: string }> }) { const locale = routeLocale((await params).locale);
return <><AuthScreen /></>; }
