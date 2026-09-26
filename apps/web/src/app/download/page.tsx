import { getStableRelease } from '@/lib/desktop-release';
import { DesktopDownloads } from '@/components/desktop-downloads';

export const metadata = { title: 'Download · komopdf', description: 'Get komopdf for your browser, Windows or Mac.' };

export default function DownloadPage() {
  return <DesktopDownloads manifest={getStableRelease()} />;
}
