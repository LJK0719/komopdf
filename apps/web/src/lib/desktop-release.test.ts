import { describe, it, expect } from 'vitest';
import {
  getStableRelease,
  getArtifactForTarget,
  formatFileSize,
  formatPublishedDate,
  TARGET_METADATA,
  desktopTargets,
  parseReleaseManifest,
} from './desktop-release';

describe('desktop-release lib', () => {
  it('loads and validates the default unreleased stable.json', () => {
    const manifest = getStableRelease();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.product).toBe('komopdf');
    expect(manifest.channel).toBe('stable');
    expect(manifest.version).toBeNull();
    expect(manifest.publishedAt).toBeNull();
    expect(manifest.releaseUrl).toBeNull();
    expect(manifest.artifacts).toEqual([]);
  });

  it('parses a valid published release with all targets', () => {
    const rawData = {
      schemaVersion: 1,
      product: 'komopdf',
      channel: 'stable',
      version: '1.2.3',
      publishedAt: '2026-09-23T12:00:00.000Z',
      releaseUrl: 'https://github.com/LJK0719/komopdf-releases/releases/tag/v1.2.3',
      artifacts: [
        {
          target: 'windows-x64',
          name: 'komopdf-1.2.3-windows-x64-setup.exe',
          url: 'https://github.com/LJK0719/komopdf-releases/releases/download/v1.2.3/komopdf-1.2.3-windows-x64-setup.exe',
          sha256: 'a'.repeat(64),
          bytes: 84000000,
          minimumOs: 'Windows 10 (version 1809+) or Windows 11 (64-bit)',
        },
        {
          target: 'macos-arm64',
          name: 'komopdf-1.2.3-macos-arm64.dmg',
          url: 'https://github.com/LJK0719/komopdf-releases/releases/download/v1.2.3/komopdf-1.2.3-macos-arm64.dmg',
          sha256: 'b'.repeat(64),
          bytes: 92000000,
          minimumOs: 'macOS 13.0 or later',
        },
        {
          target: 'macos-x64',
          name: 'komopdf-1.2.3-macos-x64.dmg',
          url: 'https://github.com/LJK0719/komopdf-releases/releases/download/v1.2.3/komopdf-1.2.3-macos-x64.dmg',
          sha256: 'c'.repeat(64),
          bytes: 95000000,
          minimumOs: 'macOS 13.0 or later',
        },
      ],
    };

    const manifest = getStableRelease(rawData);
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.artifacts).toHaveLength(3);

    const win = getArtifactForTarget(manifest, 'windows-x64');
    expect(win).toBeDefined();
    expect(win?.name).toBe('komopdf-1.2.3-windows-x64-setup.exe');

    const macArm = getArtifactForTarget(manifest, 'macos-arm64');
    expect(macArm).toBeDefined();
    expect(macArm?.name).toBe('komopdf-1.2.3-macos-arm64.dmg');

    const macX64 = getArtifactForTarget(manifest, 'macos-x64');
    expect(macX64).toBeDefined();
    expect(macX64?.name).toBe('komopdf-1.2.3-macos-x64.dmg');
  });

  it('handles partial releases where some targets are unreleased', () => {
    const rawPartial = {
      schemaVersion: 1,
      product: 'komopdf',
      channel: 'stable',
      version: '0.2.0',
      publishedAt: '2026-09-23T08:30:00Z',
      releaseUrl: 'https://github.com/LJK0719/komopdf-releases/releases/tag/v0.2.0',
      artifacts: [
        {
          target: 'windows-x64',
          name: 'komopdf-0.2.0-windows-x64-setup.exe',
          url: 'https://github.com/LJK0719/komopdf-releases/releases/download/v0.2.0/komopdf-0.2.0-windows-x64-setup.exe',
          sha256: 'f'.repeat(64),
          bytes: 80000000,
          minimumOs: 'Windows 10 (1809+)',
        },
      ],
    };

    const manifest = getStableRelease(rawPartial);
    expect(getArtifactForTarget(manifest, 'windows-x64')).toBeDefined();
    expect(getArtifactForTarget(manifest, 'macos-arm64')).toBeUndefined();
    expect(getArtifactForTarget(manifest, 'macos-x64')).toBeUndefined();
  });

  it('rejects invalid manifests across all constraint dimensions', () => {
    // Non-object input
    expect(() => parseReleaseManifest(null)).toThrow();
    expect(() => parseReleaseManifest('invalid')).toThrow();
    expect(() => parseReleaseManifest([])).toThrow();

    // Wrong schemaVersion, product, or channel
    expect(() =>
      parseReleaseManifest({
        schemaVersion: 2,
        product: 'komopdf',
        channel: 'stable',
        version: null,
        publishedAt: null,
        releaseUrl: null,
        artifacts: [],
      }),
    ).toThrow();

    // Unpublished with artifacts or publishedAt
    expect(() =>
      parseReleaseManifest({
        schemaVersion: 1,
        product: 'komopdf',
        channel: 'stable',
        version: null,
        publishedAt: null,
        releaseUrl: null,
        artifacts: [{ target: 'windows-x64' }],
      }),
    ).toThrow();

    // Invalid version format (e.g. leading v)
    expect(() =>
      parseReleaseManifest({
        schemaVersion: 1,
        product: 'komopdf',
        channel: 'stable',
        version: 'v1.0.0',
        publishedAt: '2026-09-23T00:00:00Z',
        releaseUrl: 'https://github.com/LJK0719/komopdf-releases/releases/tag/vv1.0.0',
        artifacts: [],
      }),
    ).toThrow();

    // Non-UTC timestamp
    expect(() =>
      parseReleaseManifest({
        schemaVersion: 1,
        product: 'komopdf',
        channel: 'stable',
        version: '1.0.0',
        publishedAt: '2026-09-23 12:00:00',
        releaseUrl: 'https://github.com/LJK0719/komopdf-releases/releases/tag/v1.0.0',
        artifacts: [
          {
            target: 'windows-x64',
            name: 'komopdf-1.0.0-windows-x64-setup.exe',
            url: 'https://github.com/LJK0719/komopdf-releases/releases/download/v1.0.0/komopdf-1.0.0-windows-x64-setup.exe',
            sha256: 'a'.repeat(64),
            bytes: 1000,
            minimumOs: 'Windows 10',
          },
        ],
      }),
    ).toThrow();

    // Mismatched asset name
    expect(() =>
      parseReleaseManifest({
        schemaVersion: 1,
        product: 'komopdf',
        channel: 'stable',
        version: '1.0.0',
        publishedAt: '2026-09-23T00:00:00Z',
        releaseUrl: 'https://github.com/LJK0719/komopdf-releases/releases/tag/v1.0.0',
        artifacts: [
          {
            target: 'windows-x64',
            name: 'wrong-name.exe',
            url: 'https://github.com/LJK0719/komopdf-releases/releases/download/v1.0.0/wrong-name.exe',
            sha256: 'a'.repeat(64),
            bytes: 1000,
            minimumOs: 'Windows 10',
          },
        ],
      }),
    ).toThrow();

    // Invalid SHA-256 (uppercase or wrong length)
    expect(() =>
      parseReleaseManifest({
        schemaVersion: 1,
        product: 'komopdf',
        channel: 'stable',
        version: '1.0.0',
        publishedAt: '2026-09-23T00:00:00Z',
        releaseUrl: 'https://github.com/LJK0719/komopdf-releases/releases/tag/v1.0.0',
        artifacts: [
          {
            target: 'windows-x64',
            name: 'komopdf-1.0.0-windows-x64-setup.exe',
            url: 'https://github.com/LJK0719/komopdf-releases/releases/download/v1.0.0/komopdf-1.0.0-windows-x64-setup.exe',
            sha256: 'A'.repeat(64),
            bytes: 1000,
            minimumOs: 'Windows 10',
          },
        ],
      }),
    ).toThrow();

    // Duplicate target
    expect(() =>
      parseReleaseManifest({
        schemaVersion: 1,
        product: 'komopdf',
        channel: 'stable',
        version: '1.0.0',
        publishedAt: '2026-09-23T00:00:00Z',
        releaseUrl: 'https://github.com/LJK0719/komopdf-releases/releases/tag/v1.0.0',
        artifacts: [
          {
            target: 'windows-x64',
            name: 'komopdf-1.0.0-windows-x64-setup.exe',
            url: 'https://github.com/LJK0719/komopdf-releases/releases/download/v1.0.0/komopdf-1.0.0-windows-x64-setup.exe',
            sha256: 'a'.repeat(64),
            bytes: 1000,
            minimumOs: 'Windows 10',
          },
          {
            target: 'windows-x64',
            name: 'komopdf-1.0.0-windows-x64-setup.exe',
            url: 'https://github.com/LJK0719/komopdf-releases/releases/download/v1.0.0/komopdf-1.0.0-windows-x64-setup.exe',
            sha256: 'b'.repeat(64),
            bytes: 2000,
            minimumOs: 'Windows 10',
          },
        ],
      }),
    ).toThrow();
  });

  it('formats file sizes accurately across magnitude ranges', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(-100)).toBe('0 B');
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(1024)).toBe('1.0 KiB');
    expect(formatFileSize(1048576)).toBe('1.0 MiB');
    expect(formatFileSize(84 * 1024 * 1024)).toBe('84 MiB');
    expect(formatFileSize(84.6 * 1024 * 1024)).toBe('85 MiB');
    expect(formatFileSize(1536 * 1024)).toBe('1.5 MiB');
    expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GiB');
  });

  it('formats publication dates properly', () => {
    expect(formatPublishedDate(null)).toBe('');
    expect(formatPublishedDate('not-a-date')).toBe('');
    expect(formatPublishedDate('2026-09-23T14:35:10.000Z')).toBe('2026-09-23');
  });

  it('maintains correct target metadata for distinct platforms and minimum macOS 13', () => {
    expect(desktopTargets).toEqual(['windows-x64', 'macos-arm64', 'macos-x64']);

    // Distinct architectures for Mac (not Universal)
    expect(TARGET_METADATA['macos-arm64'].architecture).toContain('arm64');
    expect(TARGET_METADATA['macos-x64'].architecture).toContain('x64');

    // macOS target minimum is 13 (not 12)
    expect(TARGET_METADATA['macos-arm64'].defaultMinimumOs).toContain('13');
    expect(TARGET_METADATA['macos-x64'].defaultMinimumOs).toContain('13');
    expect(TARGET_METADATA['macos-arm64'].defaultMinimumOs).not.toContain('12');

    // Platform mapping
    expect(TARGET_METADATA['windows-x64'].platform).toBe('windows');
    expect(TARGET_METADATA['macos-arm64'].platform).toBe('macos');
    expect(TARGET_METADATA['macos-x64'].platform).toBe('macos');
  });
});
