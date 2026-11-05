'use client';

import { preloadEditor } from './editor-preload';
import { Monitor, Apple, Globe, Download, ArrowRight } from 'lucide-react';
import { SiteNav, SiteFooter } from './navigation';
import { useI18n } from '@pdf-editor/editor/i18n';
import { localizedPath } from '@pdf-editor/editor/i18n-locales';
import { type ReleaseManifest, desktopTargets, TARGET_METADATA, getArtifactForTarget } from '@/lib/desktop-release';

export function DesktopDownloads({ manifest }: { manifest: ReleaseManifest }) {
  const { t, locale } = useI18n();
  const warmEditor = () => { void preloadEditor(locale).catch(() => undefined); };
  const availableTargets = desktopTargets.filter(target => getArtifactForTarget(manifest, target));
  return <main className="site-shell"><SiteNav /><header className="site-page-heading"><span className="site-kicker">{t('Download')}</span><h1>{t('Choose where you work.')}</h1><p>{t('Open the web editor to get started. Install the desktop app for offline editing, folders and text recognition.')}</p></header>
    <section className="download-grid" aria-label={t('Available downloads')}><article className="download-card"><Globe size={28} strokeWidth={1.6} aria-hidden="true" /><h2>{t('Web editor')}</h2><p>{t('Start right away. No installation, no account.')}</p><p className="download-version">{t('Works in your browser')}</p><a href={localizedPath('/', locale)} className="site-button site-button-primary" onPointerEnter={warmEditor} onFocus={warmEditor}>{t('Open editor')}<ArrowRight size={16} aria-hidden="true" /></a></article>
      {availableTargets.map(target => {
        const meta = TARGET_METADATA[target]; const artifact = getArtifactForTarget(manifest, target)!; const Icon = meta.platform === 'windows' ? Monitor : Apple;
        return <article key={target} className="download-card"><Icon size={28} strokeWidth={1.6} aria-hidden="true" /><h2>{meta.title}</h2><p>{meta.platform === 'windows' ? t('For your Windows PC.') : target.includes('arm64') ? t('For Mac with Apple silicon.') : t('For Mac with an Intel processor.')}</p><small>{artifact.minimumOs ?? meta.defaultMinimumOs}</small>
          <p className="download-version">{t('Version {version}', { version: manifest.version! })}{manifest.releaseUrl ? <> · <a href={manifest.releaseUrl} target="_blank" rel="noreferrer">{t('Release notes')}</a></> : null}</p><a href={artifact.url} download={artifact.name} className="site-button site-button-primary"><Download size={16} aria-hidden="true" />{t('Download')}</a>
        </article>;
      })}</section>
    {!availableTargets.length ? <p className="download-note">{t('No desktop release is available right now. You can use the web editor.')}</p> : null}
    <SiteFooter /></main>;
}
