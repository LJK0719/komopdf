import type { MetadataRoute } from 'next';
import { SITE_ORIGIN } from '@/lib/site-seo';

export const dynamic = 'force-static';
export default function robots(): MetadataRoute.Robots {
  // Account/auth pages remain crawlable so their server-rendered noindex is seen.
  return { rules: { userAgent: '*', allow: '/', disallow: ['/api/'] },
    sitemap: `${SITE_ORIGIN}/sitemap.xml`, host: SITE_ORIGIN };
}
