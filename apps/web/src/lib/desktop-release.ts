import {
  parseReleaseManifest,
  desktopTargets,
  type ReleaseManifest,
  type DesktopArtifact,
  type DesktopTarget,
} from '../../../../distribution/release-manifest';
import stableJson from '../../public/releases/stable.json';

export {
  parseReleaseManifest,
  desktopTargets,
  type ReleaseManifest,
  type DesktopArtifact,
  type DesktopTarget,
};

export interface TargetMetadata {
  target: DesktopTarget;
  platform: 'windows' | 'macos';
  title: string;
  architecture: string;
  packageFormat: string;
  defaultMinimumOs: string;
  description: string;
}

export const TARGET_METADATA: Record<DesktopTarget, TargetMetadata> = {
  'windows-x64': {
    target: 'windows-x64',
    platform: 'windows',
    title: 'Windows x64',
    architecture: 'x64 (64-bit)',
    packageFormat: 'NSIS Setup (.exe)',
    defaultMinimumOs: 'Windows 10 22H2 or Windows 11 (64-bit)',
    description: 'Native desktop installer for 64-bit Windows systems.',
  },
  'macos-arm64': {
    target: 'macos-arm64',
    platform: 'macos',
    title: 'macOS Apple Silicon',
    architecture: 'arm64 (M1 / M2 / M3 / M4)',
    packageFormat: 'Apple Disk Image (.dmg)',
    defaultMinimumOs: 'macOS 13.0 (Ventura) or later',
    description: 'Native arm64 binary optimized for Apple Silicon hardware.',
  },
  'macos-x64': {
    target: 'macos-x64',
    platform: 'macos',
    title: 'macOS Intel',
    architecture: 'x64 (64-bit)',
    packageFormat: 'Apple Disk Image (.dmg)',
    defaultMinimumOs: 'macOS 13.0 (Ventura) or later',
    description: 'Native x64 binary for Intel-based Mac computers.',
  },
};

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

export function formatPublishedDate(isoDate: string | null): string {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().split('T')[0];
}

export function getStableRelease(manifestData: unknown = stableJson): ReleaseManifest {
  return parseReleaseManifest(manifestData);
}

export function getArtifactForTarget(
  manifest: ReleaseManifest,
  target: DesktopTarget,
): DesktopArtifact | undefined {
  return manifest.artifacts.find((a) => a.target === target);
}
