'use client';

import Link from 'next/link';
import { Monitor, Apple, Globe, Download, ArrowRight } from 'lucide-react';
import { SiteNav, SiteFooter } from './navigation';
import { useI18n } from '@pdf-editor/editor/i18n';
import { type ReleaseManifest, desktopTargets, TARGET_METADATA, formatFileSize, getArtifactForTarget } from '@/lib/desktop-release';

export function DesktopDownloads({ manifest }: { manifest: ReleaseManifest }) {
  const { t } = useI18n();
  const availableTargets = desktopTargets.filter(target => getArtifactForTarget(manifest, target));
  return <main className="site-shell"><SiteNav /><header className="site-page-heading"><span className="site-kicker">{t('Download')}</span><h1>{t('Choose where you work.')}</h1><p>{t('Open the web editor to get started. Install the desktop app for offline editing, folders and text recognition.')}</p></header>
    <section className="download-grid" aria-label={t('Available downloads')}><article className="download-card"><Globe size={28} strokeWidth={1.6} aria-hidden="true" /><h2>{t('Web editor')}</h2><p>{t('Start right away. No installation, no account.')}</p><small>{t('Up to 50 MB and 200 pages per PDF.')}</small><p className="download-version">{t('Works in your browser')}</p><Link href="/editor/" className="site-button site-button-primary">{t('Open editor')}<ArrowRight size={16} aria-hidden="true" /></Link></article>
      {availableTargets.map(target => {
        const meta = TARGET_METADATA[target]; const artifact = getArtifactForTarget(manifest, target)!; const Icon = meta.platform === 'windows' ? Monitor : Apple;
        return <article key={target} className="download-card"><Icon size={28} strokeWidth={1.6} aria-hidden="true" /><h2>{meta.title}</h2><p>{meta.platform === 'windows' ? t('For your Windows PC.') : target.includes('arm64') ? t('For Mac with Apple silicon.') : t('For Mac with an Intel processor.')}</p><small>{artifact.minimumOs ?? meta.defaultMinimumOs}</small>
          <p className="download-version">{t('Version {version}', { version: manifest.version! })}{manifest.releaseUrl ? <> · <a href={manifest.releaseUrl} target="_blank" rel="noreferrer">{t('Release notes')}</a></> : null}</p><a href={artifact.url} download={artifact.name} className="site-button site-button-primary"><Download size={16} aria-hidden="true" />{t('Download')} · {formatFileSize(artifact.bytes)}</a><details><summary>{t('File details')}</summary><small>{artifact.name}</small><code>SHA-256: {artifact.sha256}</code></details>
        </article>;
      })}</section>
    {!availableTargets.length ? <p className="download-note">{t('No desktop release is available right now. You can use the web editor.')}</p> : null}
    <section className="site-prose download-note"><h2>{t('Moving from web to desktop?')}</h2><p>{t('Download a copy of your PDF in the web editor, then open that file in the desktop app. Open documents do not transfer automatically.')}</p><Link className="site-text-link" href="/help/">{t('Read the quick guide')}<ArrowRight size={15} aria-hidden="true" /></Link></section>
    <SiteFooter /></main>;
}
