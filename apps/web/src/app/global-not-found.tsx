import Link from 'next/link';
import { siteMetadata } from '@/components/site-root';
import './globals.css';

export const metadata = { ...siteMetadata, title: '404 · komopdf', robots: { index: false, follow: true } };
export default function GlobalNotFound() {
  return <html lang="en"><body><main className="site-shell"><header className="site-page-heading"><h1>404</h1><p>Page not found.</p><Link className="site-button site-button-primary" href="/">komopdf</Link></header></main></body></html>;
}
