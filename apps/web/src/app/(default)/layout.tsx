import type { ReactNode } from 'react';
import { SiteRoot, siteViewport, siteMetadata } from '@/components/site-root';
export const viewport = siteViewport;
export const metadata = siteMetadata;
export default function Layout({ children }: { children: ReactNode }) { return <SiteRoot locale="en">{children}</SiteRoot>; }
