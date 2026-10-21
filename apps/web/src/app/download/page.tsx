import { getStableRelease } from '@/lib/desktop-release';
import { DesktopDownloads } from '@/components/desktop-downloads';

export const metadata = { title: 'Download · komopdf', description: 'Download komopdf for your desktop or start editing PDFs in your browser.' };

export default function DownloadPage() {
  return <DesktopDownloads manifest={getStableRelease()} />;
}
