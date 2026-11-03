import Link from 'next/link';
import './globals.css';

export const metadata = { title: '404 · komopdf', robots: { index: false, follow: true } };
export default function GlobalNotFound() {
  return <html lang="en"><body><main className="site-shell"><header className="site-page-heading"><h1>404</h1><p>Page not found.</p><Link className="site-button site-button-primary" href="/">komopdf</Link></header></main></body></html>;
}
