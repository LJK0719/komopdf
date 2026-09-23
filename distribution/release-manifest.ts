export const releaseRepository = 'LJK0719/komopdf-releases';
export const desktopTargets = ['windows-x64', 'macos-arm64', 'macos-x64'] as const;
export type DesktopTarget = typeof desktopTargets[number];

export interface DesktopArtifact {
  target: DesktopTarget;
  name: string;
  url: string;
  sha256: string;
  bytes: number;
  minimumOs: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: 'komopdf';
  channel: 'stable';
  version: string | null;
  publishedAt: string | null;
  releaseUrl: string | null;
  artifacts: DesktopArtifact[];
}

export function releaseAssetName(version: string, target: DesktopTarget): string {
  return target === 'windows-x64'
    ? `komopdf-${version}-windows-x64-setup.exe`
    : `komopdf-${version}-${target}.dmg`;
}

export function releasePageUrl(version: string): string {
  return `https://github.com/${releaseRepository}/releases/tag/v${version}`;
}

export function releaseAssetUrl(version: string, name: string): string {
  return `https://github.com/${releaseRepository}/releases/download/v${version}/${name}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a release manifest object.');
  }
  return value as Record<string, unknown>;
}

/** The website and the release publisher consume the same public format. */
export function parseReleaseManifest(input: unknown): ReleaseManifest {
  const value = record(input);
  if (value.schemaVersion !== 1 || value.product !== 'komopdf' || value.channel !== 'stable' || !Array.isArray(value.artifacts)) {
    throw new Error('Unsupported komopdf release manifest.');
  }
  if (value.version === null) {
    if (value.publishedAt !== null || value.releaseUrl !== null || value.artifacts.length !== 0) {
      throw new Error('An unpublished release cannot contain downloads.');
    }
    return { schemaVersion: 1, product: 'komopdf', channel: 'stable', version: null, publishedAt: null, releaseUrl: null, artifacts: [] };
  }
  if (typeof value.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)) {
    throw new Error('Stable releases require a numeric major.minor.patch version.');
  }
  const version = value.version;
  if (typeof value.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.publishedAt) || !Number.isFinite(Date.parse(value.publishedAt))) {
    throw new Error('A published release requires a UTC publication timestamp.');
  }
  if (value.releaseUrl !== releasePageUrl(version) || value.artifacts.length === 0) {
    throw new Error('A published release requires its canonical release page and at least one installer.');
  }
  const targets = new Set<string>();
  const artifacts = value.artifacts.map((entry): DesktopArtifact => {
    const asset = record(entry);
    if (!desktopTargets.includes(asset.target as DesktopTarget) || targets.has(asset.target as string)) {
      throw new Error('Invalid or duplicate desktop target.');
    }
    const target = asset.target as DesktopTarget;
    targets.add(target);
    const name = releaseAssetName(version, target);
    if (asset.name !== name || asset.url !== releaseAssetUrl(version, name)) {
      throw new Error('Installer URLs must refer to the matching version and architecture in the public release repository.');
    }
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256) || typeof asset.bytes !== 'number' || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
      throw new Error('An installer requires its actual SHA-256 and byte size.');
    }
    if (typeof asset.minimumOs !== 'string' || !asset.minimumOs.trim() || asset.minimumOs.length > 120) {
      throw new Error('An installer requires its minimum OS.');
    }
    return { target, name, url: asset.url, sha256: asset.sha256, bytes: asset.bytes, minimumOs: asset.minimumOs };
  });
  return { schemaVersion: 1, product: 'komopdf', channel: 'stable', version, publishedAt: value.publishedAt, releaseUrl: value.releaseUrl, artifacts };
}
