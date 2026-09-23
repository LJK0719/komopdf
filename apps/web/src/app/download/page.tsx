import { SiteNav, SiteFooter } from '@/components/navigation';
import { Badge } from '@/components/ui/badge';
import { FadeIn } from '@/components/motion-wrapper';
import { ShieldCheck, HardDrive } from 'lucide-react';
import { getStableRelease } from '@/lib/desktop-release';
import { DesktopDownloads } from '@/components/desktop-downloads';

export const metadata = {
  title: 'Download Desktop & Web Editions · komopdf',
  description:
    'Download komopdf for Windows x64 and macOS (Apple Silicon arm64 & Intel x64), or run the WebAssembly editor directly in your browser.',
};

export default function DownloadPage() {
  const manifest = getStableRelease();
  const isPublished = manifest.version !== null && manifest.artifacts.length > 0;

  return (
    <main className="min-h-screen px-[clamp(20px,5vw,72px)] py-6 bg-[#e8e6df] text-[#20231f]">
      <SiteNav />

      <section className="py-12 max-w-4xl">
        <FadeIn>
          <Badge variant="muted" className="mb-3">
            PLATFORM DISTRIBUTION
          </Badge>
          <h1 className="font-serif text-4xl sm:text-5xl font-normal tracking-tight text-[#20231f] mb-4">
            Get komopdf for Your Device
          </h1>
          <p className="text-base text-[#5b5e58] leading-relaxed max-w-2xl">
            komopdf provides genuine local PDF manipulation. The Web edition runs instantly inside modern browsers
            via WebAssembly. Desktop packages are self-contained native applications bundling all core dependencies,
            offline fonts, and local tools.
          </p>
        </FadeIn>
      </section>

      {/* Downloads Grid & Channel Status */}
      <section className="max-w-6xl">
        <DesktopDownloads manifest={manifest} />
      </section>

      {/* Package Transparency & Verification */}
      <section className="mt-14 max-w-6xl border-t border-[#a9aaa4] pt-10">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div>
            <h2 className="font-serif text-xl font-medium text-[#20231f] mb-3 flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-[#20231f]" />
              Release Integrity Policy
            </h2>
            <p className="text-xs text-[#5b5e58] leading-relaxed mb-4">
              komopdf adheres to verifiable release practices. Official installers are distributed exclusively
              through the public release repository with SHA-256 checksums and platform signature verification. We do not publish mock
              binaries, third-party wrappers, or unverified packages.
            </p>
            <div className="text-xs font-mono text-[#5b5e58] bg-[#dfded8] p-3 rounded-sm border border-[#aaa9a2] space-y-1">
              <div className="text-[#777a73] font-sans text-[11px] mb-1">
                {isPublished
                  ? `SHA-256 Checksums for v${manifest.version}:`
                  : 'SHA-256 Checksums (published alongside official releases):'}
              </div>
              {isPublished ? (
                manifest.artifacts.map((artifact) => (
                  <div key={artifact.target} className="break-all select-all text-[#20231f]">
                    <span className="text-[#5b5e58]">{artifact.name}:</span>
                    <br />
                    {artifact.sha256}
                  </div>
                ))
              ) : (
                <>
                  <div className="text-[#777a73]"># Verify downloaded packages:</div>
                  <div>shasum -a 256 &lt;installer&gt; (macOS)</div>
                  <div>Get-FileHash &lt;installer&gt; -Algorithm SHA256 (Windows)</div>
                  <div className="text-[#777a73] pt-1">Release links will appear when verified installers are published.</div>
                </>
              )}
            </div>
          </div>

          <div>
            <h2 className="font-serif text-xl font-medium text-[#20231f] mb-3 flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-[#20231f]" />
              System Requirements
            </h2>
            <ul className="text-xs text-[#5b5e58] space-y-2.5 leading-relaxed">
              <li>
                <strong className="text-[#20231f]">Web Edition:</strong> A modern desktop browser with WebAssembly
                and Web Worker support enabled. Full cross-browser release validation is in progress.
              </li>
              <li>
                <strong className="text-[#20231f]">Windows Edition:</strong> Windows 10 22H2 or
                Windows 11 (64-bit); 4 GB RAM recommended.
              </li>
              <li>
                <strong className="text-[#20231f]">macOS Edition:</strong> macOS 13.0 (Ventura) or later. Dedicated
                packages for Apple Silicon (arm64) and Intel (x64) architectures.
              </li>
              <li>
                <strong className="text-[#20231f]">Network Connectivity:</strong> Desktop applications bundle 18
                offline fonts and local document processing engines. The Web edition needs a connection to load the
                application, engines, and fonts on demand. PDF processing runs locally; optional AI requests need a connection.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
