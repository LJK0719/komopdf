import type { MetadataRoute } from 'next';
import { UI_LOCALES } from '@pdf-editor/editor/i18n-locales';
import { absoluteUrl, CONTENT_MODIFIED, languageAlternates, publicPaths } from '@/lib/site-seo';

export const dynamic = 'force-static';
export default function sitemap(): MetadataRoute.Sitemap {
  return UI_LOCALES.flatMap(locale => publicPaths(locale.id).map(path => ({
    url: absoluteUrl(path, locale.id), lastModified: CONTENT_MODIFIED,
    alternates: { languages: languageAlternates(path) },
  })));
}
