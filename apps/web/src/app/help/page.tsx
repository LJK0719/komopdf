import Link from 'next/link';
import { SiteNav, SiteFooter } from '@/components/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FadeIn } from '@/components/motion-wrapper';
import { Type, Image, Layers, Shield, Sparkles, RotateCw, Undo2, Key } from 'lucide-react';

export const metadata = {
  title: 'Documentation & Help · komopdf',
  description: 'Technical documentation and user guides for komopdf features and operations.',
};

export default function HelpPage() {
  return (
    <main className="min-h-screen px-[clamp(20px,5vw,72px)] py-6 bg-[#e8e6df] text-[#20231f]">
      <SiteNav />

      <section className="py-12 max-w-4xl">
        <FadeIn>
          <Badge variant="muted" className="mb-3">DOCUMENTATION &amp; SPECIFICATION</Badge>
          <h1 className="font-serif text-4xl sm:text-5xl font-normal tracking-tight text-[#20231f] mb-4">
            komopdf Feature Guide
          </h1>
          <p className="text-base text-[#5b5e58] leading-relaxed max-w-2xl">
            This guide covers features currently implemented and active in the komopdf engine.
            All operations follow an atomic transaction model with full undo/redo support.
          </p>
        </FadeIn>
      </section>

      <div className="space-y-10 max-w-5xl">
        {/* Typography & Text Editing */}
        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Type className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-lg font-semibold text-[#20231f]">Text Editing &amp; Font System</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-3 leading-relaxed">
            <p>
              komopdf modifies text at the PDF stream operator level rather than drawing HTML overlays:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>In-Place Replacement:</strong> Select existing text blocks or characters to replace their string content while maintaining grapheme cluster boundaries and baseline alignment.</li>
              <li><strong>Multi-Line Insertion:</strong> Insert paragraphs inside a text box with automatic wrapping, custom line height, and left, center, right or justified alignment. Empty lines retain their spacing without adding text glyphs.</li>
              <li><strong>Typography &amp; Styles:</strong> Format selected characters with font size, color, spacing and vector underlines. Weight and italic use actual registered font faces, never synthetic distortion. Missing faces are reported without silently replacing the font.</li>
              <li><strong>Tagged Content:</strong> Text editing, object grouping and paragraph operations preserve supported MCID, ActualText and structure-tree references. Adjacent fully selected paragraph/span leaves can be merged. Ambiguous partial ActualText scopes and merges across different table/list roles are rejected rather than silently losing semantics.</li>
              <li><strong>Bundled Fonts (6 families, 18 faces):</strong> Noto Sans CJK SC (Regular/Bold), Noto Serif CJK SC (Regular/Bold), LXGW WenKai (Regular/Medium), Liberation Sans (4 styles), Liberation Serif (4 styles), and Liberation Mono (4 styles).</li>
              <li><strong>Custom Font Import:</strong> Load external TTF or OpenType/CFF files, select individual faces from TrueType Collection (.ttc) files, or query authorized browser system fonts.</li>
            </ul>
          </CardContent>
        </Card>

        {/* Page Geometry & Document Structuring */}
        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <RotateCw className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-lg font-semibold text-[#20231f]">Page Operations &amp; Assembly</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-3 leading-relaxed">
            <p>
              Manipulate individual pages or merge multi-document content seamlessly:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Rotation:</strong> Rotate selected pages by 90&deg;, 180&deg;, or 270&deg;. Existing page annotations and form fields adapt accordingly.</li>
              <li><strong>Page Reordering:</strong> Drag and drop page thumbnails to reorder document sequences in a single atomic transaction.</li>
              <li><strong>Page Insertion &amp; Duplication:</strong> Insert blank pages at any position or clone existing pages along with their vector resources.</li>
              <li><strong>Import &amp; Extract:</strong> Copy selected pages as real PDF pages, retaining supported links, bookmarks, fields and tagged structure without rasterization. Internal links and bookmarks that target omitted pages are removed rather than left pointing at the wrong page. Field names are disambiguated when importing into an existing document.</li>
              <li><strong>Page Deletion:</strong> Remove pages together with their annotations and fields. Incoming links and bookmarks with no surviving target are removed in the same undoable transaction. Documents must retain at least one page.</li>
            </ul>
          </CardContent>
        </Card>

        {/* Objects & Images */}
        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Image className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-lg font-semibold text-[#20231f]">Objects, Vectors &amp; Images</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-3 leading-relaxed">
            <p>
              Object-level operations operate through stable object identifiers and affine transformations:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Image Insertion:</strong> Embed PNG and JPEG images with preservation of full alpha transparency and resolution.</li>
              <li><strong>Shared Instance Isolation:</strong> Replacing an image that appears multiple times in a document automatically isolates the modified instance so other pages remain untouched.</li>
              <li><strong>Reversible Crop:</strong> Crop raster images non-destructively by adjusting clipping paths. Original image byte streams are preserved in the transaction history.</li>
              <li><strong>Object Transformation:</strong> Move, scale, rotate, align and distribute text, images, paths and gradients using mouse handles or numerical inputs. Shared Form instances are isolated before editing.</li>
              <li><strong>Persistent Groups:</strong> Group adjacent objects without rasterizing them. Double-click a group or choose “Edit group contents” to edit its members, and use “Select parent group” to leave that level. Groups and nested groups remain editable after saving.</li>
            </ul>
          </CardContent>
        </Card>

        {/* QPDF & Security */}
        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-lg font-semibold text-[#20231f]">Document Protection &amp; QPDF Optimization</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-3 leading-relaxed">
            <p>
              Security operations are driven by QPDF 12.4.1 compiled to WebAssembly (browser) and native binaries (desktop):
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>AES-256 Encryption:</strong> Apply standard 256-bit AES encryption with user and owner passwords. Specify permissions for printing, copying, and modification.</li>
              <li><strong>Password Protected Opening:</strong> Open encrypted PDFs with user or owner credentials. If a password fails, retry without corrupting previously loaded workspace state.</li>
              <li><strong>Lossless Linearization:</strong> Optimize PDF object streams, cross-reference tables, and unreferenced object garbage collection without lossy image re-compression.</li>
              <li><strong>Zero Cloud Leakage:</strong> Passwords and encryption keys are processed strictly in memory within the local browser tab or native process.</li>
            </ul>
          </CardContent>
        </Card>

        {/* AI Assistance (komo) */}
        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-lg font-semibold text-[#20231f]">AI Agent komo &amp; Candidate Verification</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-3 leading-relaxed">
            <p>
              The built-in assistant <strong>komo</strong> operates under strict verification protocols:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Candidate Generation:</strong> komo never writes directly to your PDF file. AI suggestions are rendered as previewable diff candidates.</li>
              <li><strong>Explicit Acceptance:</strong> You review the proposed changes before committing them into the transaction log. A discarded suggestion leaves zero artifacts.</li>
              <li><strong>Scoped Payloads:</strong> Only the specific text snippet, prompt instruction, or bounding box necessary to fulfill your request is transmitted to the gateway.</li>
              <li><strong>Rate &amp; Budget Limits:</strong> The gateway enforces strict token and request limits to ensure service stability without tracking user identities.</li>
            </ul>
          </CardContent>
        </Card>

        {/* Keyboard Shortcuts & Transactions */}
        <Card className="bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Undo2 className="h-5 w-5 text-[#20231f]" />
              <CardTitle className="text-lg font-semibold text-[#20231f]">Transaction History &amp; Shortcuts</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#5b5e58] space-y-3 leading-relaxed">
            <p>
              komopdf maintains an immutable command journal enabling reliable state recovery:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Undo / Redo:</strong> <kbd className="px-1.5 py-0.5 bg-[#d4d3cd] rounded text-[11px] font-mono">Ctrl+Z</kbd> / <kbd className="px-1.5 py-0.5 bg-[#d4d3cd] rounded text-[11px] font-mono">Cmd+Z</kbd> to undo; <kbd className="px-1.5 py-0.5 bg-[#d4d3cd] rounded text-[11px] font-mono">Ctrl+Y</kbd> / <kbd className="px-1.5 py-0.5 bg-[#d4d3cd] rounded text-[11px] font-mono">Cmd+Shift+Z</kbd> to redo.</li>
              <li><strong>Grapheme Navigation:</strong> <kbd className="px-1.5 py-0.5 bg-[#d4d3cd] rounded text-[11px] font-mono">Arrow</kbd> keys and <kbd className="px-1.5 py-0.5 bg-[#d4d3cd] rounded text-[11px] font-mono">Shift</kbd> selections navigate by Unicode grapheme clusters, preventing corrupted surrogate pairs.</li>
              <li><strong>Save Safeguards:</strong> Navigating away from a modified document prompts a confirmation modal to avoid accidental data loss.</li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="mt-12 flex items-center justify-center gap-4">
        <Button asChild variant="brand" size="lg" className="rounded-sm">
          <Link href="/editor/">Launch Web Editor</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="rounded-sm border-[#20231f] bg-transparent text-[#20231f]">
          <Link href="/download/">View Desktop Downloads</Link>
        </Button>
      </div>

      <SiteFooter />
    </main>
  );
}
