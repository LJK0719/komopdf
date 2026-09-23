'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Monitor,
  Apple,
  Globe,
  CheckCircle2,
  AlertCircle,
  Download,
  Copy,
  Check,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StaggerContainer, StaggerItem } from '@/components/motion-wrapper';
import {
  type ReleaseManifest,
  desktopTargets,
  TARGET_METADATA,
  formatFileSize,
  formatPublishedDate,
  getArtifactForTarget,
} from '@/lib/desktop-release';

interface DesktopDownloadsProps {
  manifest: ReleaseManifest;
}

export function DesktopDownloads({ manifest }: DesktopDownloadsProps) {
  const [copiedHashTarget, setCopiedHashTarget] = React.useState<string | null>(null);

  const isPublished = manifest.version !== null && manifest.artifacts.length > 0;

  const handleCopyHash = async (target: string, hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHashTarget(target);
      setTimeout(() => setCopiedHashTarget(null), 2000);
    } catch {
      // Ignore clipboard write failures gracefully
    }
  };

  return (
    <div className="space-y-8">
      {/* Release Channel Summary Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-sm border border-[#a9aaa4] bg-[#dfded8]">
        <div className="flex items-center gap-3">
          <Badge variant={isPublished ? 'brand' : 'muted'} className="text-xs px-2.5 py-0.5">
            {isPublished ? `v${manifest.version}` : 'Stable Channel'}
          </Badge>
          <span className="text-xs text-[#5b5e58]">
            {isPublished ? (
              <>
                Released on{' '}
                <strong className="text-[#20231f]">{formatPublishedDate(manifest.publishedAt)}</strong>
                {' · '}
                {manifest.artifacts.length} installer{manifest.artifacts.length === 1 ? '' : 's'} available
              </>
            ) : (
              'Desktop installers are currently in preparation. Web edition is fully available.'
            )}
          </span>
        </div>

        {isPublished && manifest.releaseUrl && (
          <a
            href={manifest.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#20231f] hover:underline"
          >
            <span>Release Notes</span>
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      {/* Platform Distribution Cards */}
      <StaggerContainer className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Card 1: Web Edition */}
        <StaggerItem>
          <Card className="flex flex-col justify-between h-full bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between mb-2">
                <Globe className="h-6 w-6 text-[#20231f]" />
                <Badge variant="brand">Available Now</Badge>
              </div>
              <CardTitle className="text-lg font-semibold text-[#20231f]">Web Edition</CardTitle>
              <CardDescription className="text-xs text-[#5b5e58]">
                Runs entirely in modern desktop browsers via WebAssembly &amp; Web Workers.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-xs text-[#696c66] space-y-2.5 pb-4">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-[#20231f] shrink-0 mt-0.5" />
                <span>Zero installation or account sign-up required</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-[#20231f] shrink-0 mt-0.5" />
                <span>Client-side processing: up to 50 MiB &amp; 200 pages</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-[#20231f] shrink-0 mt-0.5" />
                <span>Local QPDF AES-256 encryption &amp; decryption</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-[#20231f] shrink-0 mt-0.5" />
                <span>18 CJK &amp; Latin fonts loaded on-demand on first visit</span>
              </div>
            </CardContent>
            <CardFooter className="pt-4 border-t border-[#aaa9a2]/40">
              <Button asChild variant="brand" className="w-full rounded-sm">
                <Link href="/editor/">Launch Web Editor</Link>
              </Button>
            </CardFooter>
          </Card>
        </StaggerItem>

        {/* Desktop Cards */}
        {desktopTargets.map((targetKey) => {
          const meta = TARGET_METADATA[targetKey];
          const artifact = getArtifactForTarget(manifest, targetKey);
          const hasArtifact = Boolean(artifact);

          return (
            <StaggerItem key={targetKey}>
              <Card className="flex flex-col justify-between h-full bg-[#dfded8] border-[#a9aaa4] rounded-sm shadow-none">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between mb-2">
                    {meta.platform === 'windows' ? (
                      <Monitor className="h-6 w-6 text-[#20231f]" />
                    ) : (
                      <Apple className="h-6 w-6 text-[#20231f]" />
                    )}
                    <Badge variant={hasArtifact ? 'brand' : 'muted'}>
                      {hasArtifact ? `v${manifest.version}` : 'Not Yet Released'}
                    </Badge>
                  </div>
                  <CardTitle className="text-lg font-semibold text-[#20231f]">{meta.title}</CardTitle>
                  <CardDescription className="text-xs text-[#5b5e58]">
                    {meta.description}
                  </CardDescription>
                </CardHeader>

                <CardContent className="text-xs text-[#696c66] space-y-2.5 pb-4">
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wider text-[#777a73] font-semibold">
                      Architecture
                    </div>
                    <div className="text-[#20231f] font-mono text-xs">{meta.architecture}</div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wider text-[#777a73] font-semibold">
                      Minimum OS
                    </div>
                    <div className="text-[#20231f]">
                      {artifact?.minimumOs || meta.defaultMinimumOs}
                    </div>
                  </div>

                  {hasArtifact && artifact ? (
                    <>
                      <div className="space-y-1">
                        <div className="text-[11px] uppercase tracking-wider text-[#777a73] font-semibold">
                          Package Size
                        </div>
                        <div className="text-[#20231f] font-medium">
                          {formatFileSize(artifact.bytes)} ({artifact.bytes.toLocaleString('en-US')} bytes)
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] uppercase tracking-wider text-[#777a73] font-semibold">
                            SHA-256
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopyHash(targetKey, artifact.sha256)}
                            className="inline-flex items-center gap-1 text-[11px] text-[#20231f] hover:underline cursor-pointer"
                            title="Copy SHA-256 Checksum"
                          >
                            {copiedHashTarget === targetKey ? (
                              <>
                                <Check className="h-3 w-3 text-[#1f6f28]" />
                                <span className="text-[#1f6f28]">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                        <div className="bg-[#d4d3cd] p-1.5 rounded-sm border border-[#aaa9a2] font-mono text-[10px] break-all select-all text-[#20231f]">
                          {artifact.sha256}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-start gap-2 pt-2 border-t border-[#aaa9a2]/40 text-[#5b5e58]">
                      <AlertCircle className="h-4 w-4 shrink-0 text-[#777a73] mt-0.5" />
                      <span>
                        Official installer in preparation. A download link will appear here after release.
                      </span>
                    </div>
                  )}
                </CardContent>

                <CardFooter className="pt-4 border-t border-[#aaa9a2]/40">
                  {hasArtifact && artifact ? (
                    <Button asChild variant="brand" className="w-full rounded-sm">
                      <a href={artifact.url} download={artifact.name}>
                        <Download className="mr-2 h-4 w-4" />
                        Download ({formatFileSize(artifact.bytes)})
                      </a>
                    </Button>
                  ) : (
                    <Button
                      disabled
                      variant="outline"
                      className="w-full rounded-sm border-[#a9aaa4] text-[#777a73] cursor-not-allowed"
                    >
                      Not Yet Released
                    </Button>
                  )}
                </CardFooter>
              </Card>
            </StaggerItem>
          );
        })}
      </StaggerContainer>
    </div>
  );
}
