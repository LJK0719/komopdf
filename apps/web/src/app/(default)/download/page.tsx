import { pageMetadata, structuredData } from '@/lib/site-seo';
export async function generateMetadata() { return pageMetadata('en', '/download/'); }
import { DesktopDownloads } from '@/components/desktop-downloads';
import { getStableRelease } from '@/lib/desktop-release';
export default async function Page() { const locale = 'en';
return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(await structuredData(locale, '/download/')).replace(/</g, '\\u003c') }} /><DesktopDownloads manifest={getStableRelease()} /></>; }
