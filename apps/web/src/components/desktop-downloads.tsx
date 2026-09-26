'use client';

import Link from 'next/link';
import { Monitor, Apple, Globe, Download } from 'lucide-react';
import { SiteNav, SiteFooter } from './navigation';
import { useI18n } from '@pdf-editor/editor/i18n';
import { type ReleaseManifest, desktopTargets, TARGET_METADATA, formatFileSize, getArtifactForTarget } from '@/lib/desktop-release';

export function DesktopDownloads({ manifest }: { manifest: ReleaseManifest }) {
  const { t } = useI18n();
  return <main className="site-shell"><SiteNav /><header className="site-page-heading"><span className="site-kicker">{t('At your desk. In your browser.')}</span><h1>{t('Make yourself at home.')}</h1><p>{t('Start in your browser, or take your workspace to the desktop for offline editing and text recognition.')}</p></header>
    <section className="download-grid"><article className="download-card"><Globe size={28} /><h2>{t('Web editor')}</h2><p>{t('Start right away. No installation, no account.')}</p><small>{t('Up to 50 MB and 200 pages per PDF.')}</small><Link href="/editor/" className="site-button site-button-primary">{t('Open editor')}</Link></article>
      {desktopTargets.map(target => { const meta = TARGET_METADATA[target]; const artifact = getArtifactForTarget(manifest, target); const Icon = meta.platform === 'windows' ? Monitor : Apple;
        return <article key={target} className="download-card"><Icon size={28} /><h2>{meta.title}</h2><p>{meta.platform === 'windows' ? t('For your Windows PC.') : target.includes('arm64') ? t('For Mac with Apple silicon.') : t('For Mac with an Intel processor.')}</p><small>{artifact?.minimumOs ?? meta.defaultMinimumOs}</small>
          {artifact ? <><a href={artifact.url} download={artifact.name} className="site-button site-button-primary"><Download size={16} />{t('Download')} · {formatFileSize(artifact.bytes)}</a><details><summary>{t('File details')}</summary><small>{artifact.name}</small><code style={{overflowWrap:'anywhere',fontSize:10}}>SHA-256: {artifact.sha256}</code></details></> : <><button className="site-button site-button-outline" disabled>{t('Coming soon')}</button><p>{t('The desktop app is on its way. Use the web editor today.')}</p></>}
        </article>;
      })}</section><SiteFooter /></main>;
}
