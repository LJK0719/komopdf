import Link from 'next/link';
import { SiteNav, SiteFooter } from '@/components/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FadeIn } from '@/components/motion-wrapper';
import { ShieldCheck, EyeOff, Server, Cookie, Lock, HardDrive } from 'lucide-react';

export const metadata = {
  title: 'Privacy Policy & Data Security · komopdf',
  description: 'Privacy architecture and data handling principles of komopdf.',
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen px-[clamp(20px,5vw,72px)] py-6 bg-[#e8e6df] text-[#20231f]">
      <SiteNav />

      <section className="py-12 max-w-4xl">
        <FadeIn>
          <Badge variant="muted" className="mb-3">PRIVACY ARCHITECTURE</Badge>
          <h1 className="font-serif text-4xl sm:text-5xl font-normal tracking-tight text-[#20231f] mb-4">
            Your Documents Never Leave Your Device
          </h1>
          <p className="text-base text-[#5b5e58] leading-relaxed max-w-2xl">
            komopdf was built from the ground up on local-first principles. We do not operate document storage servers,
            cloud synchronization databases, or behavioral tracking pipelines.
          </p>
        </FadeIn>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl">
        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <EyeOff className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-base font-semibold text-[#20231f]">No Document Uploads</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-2 leading-relaxed">
            <p>
              When you open a PDF in komopdf—whether using the browser Web edition or a native desktop package—the file
              is read directly from your local filesystem into browser WebAssembly memory or the native worker process.
            </p>
            <p>
              Raw PDF bytes are never transmitted to our web servers, CDNs, or any third-party storage infrastructure.
              Saving a document writes directly back to your local disk or browser download directory.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-base font-semibold text-[#20231f]">AI Gateway Data Handling</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-2 leading-relaxed">
            <p>
              Optional AI capabilities provided by <strong>komo</strong> communicate with our stateless gateway proxy
              at <code className="bg-[#d4d3cd] px-1 py-0.5 rounded text-[11px]">komopdf.com/api/agent</code>.
            </p>
            <p>
              Only the explicitly selected text passage, user prompt, or bounded image segment required to satisfy
              your request is sent to the model upstream. The gateway does not retain prompt or document text on disk,
              and Nginx access logging for AI endpoints is explicitly disabled.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-base font-semibold text-[#20231f]">Password &amp; Key Security</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-2 leading-relaxed">
            <p>
              When opening encrypted PDF files or applying AES-256 password protection, all cryptographic operations
              are performed locally by the bundled QPDF engine.
            </p>
            <p>
              Passwords, encryption keys, and unencrypted document buffers remain strictly in local RAM and are
              cleared when the tab or application session is closed.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Cookie className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-base font-semibold text-[#20231f]">Zero Telemetry &amp; Trackers</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-2 leading-relaxed">
            <p>
              komopdf employs no advertising networks, marketing pixels, or third-party analytics trackers
              (such as Google Analytics or Meta Pixel).
            </p>
            <p>
              We do not set tracking cookies. Server logs record only standard network connection metadata
              (IP address, HTTP method, status code) strictly for operational rate-limiting and DDoS mitigation,
              with automatic 7-day log rotation.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-base font-semibold text-[#20231f]">Local Storage &amp; Cache</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-2 leading-relaxed">
            <p>
              Browser Web edition uses client-side IndexedDB solely to cache font metrics and provide transient crash
              recovery for active editing sessions. You can clear this cache at any time via browser settings.
            </p>
            <p>
              Desktop editions maintain document state in isolated per-file workspace directories. Closing a document
              or quitting the application preserves your generated files without automatic deletion.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-base font-semibold text-[#20231f]">Voluntary Support &amp; Accounts</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-2 leading-relaxed">
            <p>
              komopdf requires no user registration, email sign-up, subscription tiers, or credit card collection.
            </p>
            <p>
              If you choose to support ongoing maintenance through voluntary donation platforms (such as Ko-fi),
              any transaction is handled directly on that platform and no financial records are stored by komopdf.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-12 text-xs text-[#696c66] max-w-5xl border-t border-[#a9aaa4] pt-6">
        <p>Policy effective date: September 22, 2026. Address inquiries to: <span className="font-mono text-[#20231f]">security@komopdf.com</span></p>
      </div>

      <SiteFooter />
    </main>
  );
}
