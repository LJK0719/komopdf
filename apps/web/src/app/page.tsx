import Link from 'next/link';
import { SiteNav, SiteFooter } from '@/components/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';
import { FileText, Shield, Cpu, Layers, Sparkles, Download, BookOpen } from 'lucide-react';

export default function HomePage() {
  return (
    <main className="min-h-screen px-[clamp(20px,5vw,72px)] py-6 bg-[#e8e6df] text-[#20231f]">
      <SiteNav />

      <section className="grid grid-cols-1 lg:grid-cols-[1.5fr_0.8fr] gap-12 lg:gap-20 items-end min-h-[calc(100vh-140px)] py-16">
        <FadeIn className="max-w-[850px]">
          <span className="inline-block text-[11px] font-extrabold tracking-[0.2em] text-[#5d6159] uppercase mb-4">
            LOCAL FIRST · WEB &amp; DESKTOP PDF EDITOR
          </span>
          <h1 className="font-serif font-normal text-[clamp(46px,7.5vw,104px)] leading-[0.92] tracking-[-0.05em] text-[#20231f] mb-6">
            Documents stay on<br />your device.
          </h1>
          <p className="max-w-[580px] text-[15px] leading-[1.75] text-[#5b5e58] mb-8">
            komopdf modifies real PDF objects inside your browser WebAssembly environment or offline desktop application.
            Transactions, font metrics, undo/redo logs, and encryption stay local. No document telemetry, no screenshot overlays.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant="brand" size="lg" className="rounded-sm">
              <Link href="/editor/">Open Web Editor</Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="rounded-sm border-[#20231f] bg-transparent text-[#20231f] hover:bg-[#20231f]/5">
              <Link href="/download/">
                <Download className="mr-2 h-4 w-4" />
                Desktop Releases
              </Link>
            </Button>
            <Button asChild variant="ghost" size="lg" className="rounded-sm text-[#5b5e58] hover:text-[#20231f]">
              <Link href="/help/">
                <BookOpen className="mr-2 h-4 w-4" />
                Documentation
              </Link>
            </Button>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <aside className="border-t-[5px] border-[#ff623d] bg-[#d4d3cd] p-6 shadow-sm" id="current-status">
            <div className="text-xs font-bold uppercase tracking-wider text-[#5d6159] pb-3 border-b border-[#aaa9a2]">
              Execution Boundaries &amp; Guarantees
            </div>
            <div className="divide-y divide-[#aaa9a2]">
              <div className="grid grid-cols-[40px_1fr] gap-3 py-4">
                <span className="font-serif text-sm text-[#777a73]">01</span>
                <strong className="text-xs font-medium leading-relaxed text-[#20231f]">
                  Web version processes documents in-memory; maximum 50 MiB and 200 pages per file with zero cloud storage.
                </strong>
              </div>
              <div className="grid grid-cols-[40px_1fr] gap-3 py-4">
                <span className="font-serif text-sm text-[#777a73]">02</span>
                <strong className="text-xs font-medium leading-relaxed text-[#20231f]">
                  Core PDF operations run in a dedicated WebAssembly worker thread, isolating rendering and transaction memory.
                </strong>
              </div>
              <div className="grid grid-cols-[40px_1fr] gap-3 py-4">
                <span className="font-serif text-sm text-[#777a73]">03</span>
                <strong className="text-xs font-medium leading-relaxed text-[#20231f]">
                  Agent komo produces previewable candidates without bypassing the local command layer or exposing private credentials.
                </strong>
              </div>
              <div className="grid grid-cols-[40px_1fr] gap-3 py-4">
                <span className="font-serif text-sm text-[#777a73]">04</span>
                <strong className="text-xs font-medium leading-relaxed text-[#20231f]">
                  Desktop editions bundle offline QPDF 12.4.1, full 6-family 18-face typography, and Claude Agent SDK support.
                </strong>
              </div>
            </div>
            <p className="mt-4 text-[11px] leading-normal text-[#696c66] pt-2 border-t border-[#aaa9a2]/60">
              Built on immutable candidate logs and atomic commits. No artificial paywalls, no tracking cookies.
            </p>
          </aside>
        </FadeIn>
      </section>

      {/* Core Architectural Capabilities */}
      <section className="py-16 border-t border-[#a9aaa4]">
        <div className="mb-10">
          <Badge variant="muted" className="mb-2">CORE CAPABILITIES</Badge>
          <h2 className="font-serif text-3xl font-medium tracking-tight text-[#20231f]">
            Genuine PDF Structure Manipulation
          </h2>
          <p className="text-sm text-[#5b5e58] mt-2 max-w-2xl">
            Unlike web tools that render PDF pages into background images and layer HTML text boxes on top,
            komopdf parses and serializes real PDF syntax objects according to the PDF 1.7 / 2.0 specifications.
          </p>
        </div>

        <StaggerContainer className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <StaggerItem>
            <Card className="h-full bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
              <CardHeader>
                <div className="w-8 h-8 rounded-sm bg-[#20231f] text-[#d7ff37] flex items-center justify-center mb-2">
                  <FileText className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-semibold text-[#20231f]">Direct Typography &amp; Layout</CardTitle>
                <CardDescription className="text-xs text-[#5b5e58]">
                  Replace existing characters, apply typeface/weight variations, or insert multi-line paragraphs with automatic line wrapping and metrics.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-[#696c66] leading-relaxed">
                Integrated with 6 font families (18 faces) including Noto Sans/Serif CJK SC, LXGW WenKai, and Liberation families. Supports TTC selection and custom TTF/CFF imports.
              </CardContent>
            </Card>
          </StaggerItem>

          <StaggerItem>
            <Card className="h-full bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
              <CardHeader>
                <div className="w-8 h-8 rounded-sm bg-[#20231f] text-[#d7ff37] flex items-center justify-center mb-2">
                  <Layers className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-semibold text-[#20231f]">Page &amp; Object Geometry</CardTitle>
                <CardDescription className="text-xs text-[#5b5e58]">
                  Rotate, reorder, duplicate, insert blank pages, or import pages from external PDF documents while preserving internal tags and links.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-[#696c66] leading-relaxed">
                Transform vector elements and images with affine matrices. High-resolution raster images support alpha channels and non-destructive cropping.
              </CardContent>
            </Card>
          </StaggerItem>

          <StaggerItem>
            <Card className="h-full bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
              <CardHeader>
                <div className="w-8 h-8 rounded-sm bg-[#20231f] text-[#d7ff37] flex items-center justify-center mb-2">
                  <Shield className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-semibold text-[#20231f]">Local QPDF Encryption</CardTitle>
                <CardDescription className="text-xs text-[#5b5e58]">
                  AES-256 document protection, password-based unlocking, and lossless structure linearization executed entirely client-side.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-[#696c66] leading-relaxed">
                Powered by QPDF 12.4.1 compiled to WebAssembly for browser environments and native binaries for desktop. Passwords never touch the network.
              </CardContent>
            </Card>
          </StaggerItem>

          <StaggerItem>
            <Card className="h-full bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
              <CardHeader>
                <div className="w-8 h-8 rounded-sm bg-[#20231f] text-[#d7ff37] flex items-center justify-center mb-2">
                  <Sparkles className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-semibold text-[#20231f]">komo Agent Assistance</CardTitle>
                <CardDescription className="text-xs text-[#5b5e58]">
                  Intelligent document assistance powered by Claude Agent SDK. Performs translation, tone adjustment, and structured table insertion.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-[#696c66] leading-relaxed">
                Every agent proposal generates an immutable candidate diff. You preview and explicitly accept changes before any PDF bytes are altered.
              </CardContent>
            </Card>
          </StaggerItem>

          <StaggerItem>
            <Card className="h-full bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
              <CardHeader>
                <div className="w-8 h-8 rounded-sm bg-[#20231f] text-[#d7ff37] flex items-center justify-center mb-2">
                  <Cpu className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-semibold text-[#20231f]">Atomic Transaction Log</CardTitle>
                <CardDescription className="text-xs text-[#5b5e58]">
                  Unified 16-command ABI with full undo/redo stacks, crash recovery journals, and separate staged export confirmation.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-[#696c66] leading-relaxed">
                A failed command never leaves half-written state. Unsaved document guards prevent accidental navigation or tab closure.
              </CardContent>
            </Card>
          </StaggerItem>

          <StaggerItem>
            <Card className="h-full bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
              <CardHeader>
                <div className="w-8 h-8 rounded-sm bg-[#20231f] text-[#d7ff37] flex items-center justify-center mb-2">
                  <Download className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-semibold text-[#20231f]">Multi-Platform Distribution</CardTitle>
                <CardDescription className="text-xs text-[#5b5e58]">
                  Available immediately in any standard modern web browser, with standalone Windows x64 and macOS packages in staging.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-[#696c66] leading-relaxed">
                Desktop packages bundle all runtime dependencies, fonts, and OCR models for full offline functionality without cloud accounts.
              </CardContent>
            </Card>
          </StaggerItem>
        </StaggerContainer>
      </section>

      <SiteFooter />
    </main>
  );
}
