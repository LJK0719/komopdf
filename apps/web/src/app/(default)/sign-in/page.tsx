import { pageMetadata, structuredData } from '@/lib/site-seo';
export async function generateMetadata() { return pageMetadata('en', '/sign-in/', { noindex: true }); }
import { AuthScreen } from '@/components/auth-screen';
export default async function Page() { const locale = 'en';
return <><AuthScreen /></>; }
