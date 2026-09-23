import Link from 'next/link';

export function SiteNav() {
  return (
    <nav className="flex items-center justify-between border-b border-[#a9aaa4] pb-4.5" aria-label="Main navigation">
      <Link className="flex items-center gap-2.5 font-serif font-semibold text-[17px] leading-none text-[#20231f] no-underline" href="/">
        <span
          className="grid place-items-center w-[30px] h-[37px] text-[#20231f] bg-[#d7ff37] font-serif font-bold text-base not-italic shadow-sm"
          style={{ clipPath: 'polygon(0 0, 78% 0, 100% 22%, 100% 100%, 0 100%)' }}
          aria-hidden="true"
        >
          K
        </span>
        <span className="tracking-tight">komopdf</span>
      </Link>

      <div className="flex items-center gap-6 text-sm font-medium text-[#5b5e58]">
        <Link href="/download/" className="hover:text-[#20231f] transition-colors">
          Download
        </Link>
        <Link href="/help/" className="hover:text-[#20231f] transition-colors">
          Help
        </Link>
        <Link href="/privacy/" className="hover:text-[#20231f] transition-colors">
          Privacy
        </Link>
        <Link
          href="/editor/"
          className="rounded-sm bg-[#20231f] px-3.5 py-2 text-xs font-bold text-[#f7f5ed] no-underline hover:bg-[#333831] transition-colors shadow-sm"
        >
          Open Editor
        </Link>
      </div>
    </nav>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-[#a9aaa4] pt-8 pb-12 flex flex-col sm:flex-row items-center justify-between text-xs text-[#696c66] gap-4">
      <div>
        <span>komopdf &copy; 2026. Local-first PDF document editor & AI agent runtime.</span>
      </div>
      <div className="flex items-center gap-5">
        <Link href="/help/" className="hover:text-[#20231f]">Documentation</Link>
        <Link href="/download/" className="hover:text-[#20231f]">Desktop Releases</Link>
        <Link href="/privacy/" className="hover:text-[#20231f]">Privacy Policy</Link>
        <Link href="/editor/" className="hover:text-[#20231f]">Web Editor</Link>
      </div>
    </footer>
  );
}
