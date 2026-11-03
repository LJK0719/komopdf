import type { ReactNode } from 'react';
import { SiteRoot, siteViewport } from '@/components/site-root';
export const viewport = siteViewport;
export default function Layout({ children }: { children: ReactNode }) { return <SiteRoot locale="en">{children}</SiteRoot>; }
