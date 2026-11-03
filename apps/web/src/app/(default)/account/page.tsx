import { pageMetadata, structuredData } from '@/lib/site-seo';
export async function generateMetadata() { return pageMetadata('en', '/account/', { noindex: true }); }
import Content from '@/components/site-pages/account';
export default async function Page() { const locale = 'en';
return <><Content /></>; }
