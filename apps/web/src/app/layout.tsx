import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'komopdf · Local-First PDF Document Editor',
  description: 'Local-first PDF editor with shared core semantics, on-device WebAssembly, and Claude Agent SDK komo assistant.',
};

export const viewport: Viewport = {
  themeColor: '#1b1d1b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
