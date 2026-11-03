import { pageMetadata, structuredData } from '@/lib/site-seo';
export async function generateMetadata() { return pageMetadata('en', '/billing/', { noindex: true }); }
import Content from '@/components/site-pages/billing';
export default async function Page() { const locale = 'en';
return <><Content /></>; }
