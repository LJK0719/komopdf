import type { ReactNode } from 'react';
import { ArrowUpRight, Clock3, FileText, FolderOpen, X } from 'lucide-react';
import { useI18n } from './i18n.js';

export type RecentFileEntry = { id: string; name: string; kind: 'pdf' | 'folder'; location: string; updatedAt: number };
export function StartPage({ busy, isWeb, onOpen, onOpenFolder, recent = [], onOpenRecent, onForgetRecent, children }: {
  busy: boolean; isWeb: boolean; onOpen(): void; onOpenFolder?(): void; recent?: RecentFileEntry[];
  onOpenRecent?(entry: RecentFileEntry): void; onForgetRecent?(id: string): void; children?: ReactNode;
}) {
  const { t } = useI18n();
  return <div className="start-page">
    <header className="start-heading"><span className="start-brand" aria-hidden="true">k</span><div>
      <h1>{t('Your documents, ready to work.')}</h1><p>{t('Open a PDF, or bring a folder of materials.')}</p>
    </div></header>
    <div className="start-actions">
      <button className="start-action" type="button" aria-label={t('Open PDF')} onClick={onOpen} disabled={busy}>
        <FileText size={25} aria-hidden="true" /><span><strong>{t(busy ? 'Opening…' : 'Open PDF')}</strong>
          <small>{t('Choose one or more PDFs')}</small></span><ArrowUpRight size={18} aria-hidden="true" />
      </button>
      {onOpenFolder ? <button className="start-action" type="button" onClick={onOpenFolder} disabled={busy}>
        <FolderOpen size={25} aria-hidden="true" /><span><strong>{t('Open folder')}</strong>
          <small>{t('Keep your PDFs and materials together')}</small></span><ArrowUpRight size={18} aria-hidden="true" />
      </button> : <a className="start-desktop-link" href="/download/" target="_blank" rel="noreferrer">
        <FolderOpen size={23} aria-hidden="true" /><span><strong>{t('Work with a folder')}</strong><small>{t('Available in the desktop app')}</small></span><ArrowUpRight size={16} aria-hidden="true" />
      </a>}
    </div>
    <p className="start-hint">{t(isWeb ? 'You can also drop PDFs here. Your files stay on this device.' : 'Open files directly. No project setup needed.')}</p>
    {children}
    <section className="start-recent" aria-label={t('Recent files')}>
      <header><Clock3 size={16} aria-hidden="true" /><h2>{t('Recent files')}</h2>{isWeb && recent.length > 0 && <span>{t('Select the original file to reopen it')}</span>}</header>
      {!recent.length ? <p className="start-recent-empty">{t('Your recently opened files and folders will appear here.')}</p> : <ul>
        {recent.map(entry => <li key={entry.id}>
          <button type="button" className="recent-open" disabled={busy} onClick={() => onOpenRecent?.(entry)} title={entry.location || entry.name}>
            {entry.kind === 'folder' ? <FolderOpen size={19} aria-hidden="true" /> : <FileText size={19} aria-hidden="true" />}
            <span><strong>{entry.name}</strong><small>{entry.location || t(entry.kind === 'folder' ? 'Folder' : 'PDF document')}</small></span>
            <time dateTime={new Date(entry.updatedAt).toISOString()}>{new Date(entry.updatedAt).toLocaleDateString()}</time>
          </button>
          {onForgetRecent && <button className="recent-remove icon-button" type="button" disabled={busy}
            onClick={() => onForgetRecent(entry.id)} aria-label={t('Remove {name} from recent files', { name: entry.name })} title={t('Remove from recent files')}><X size={15} /></button>}
        </li>)}
      </ul>}
    </section>
  </div>;
}

const RECENT_KEY = 'komopdf.recent-files.v1';
export function readWebRecent(): RecentFileEntry[] {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(entries) ? entries.filter(entry => typeof entry?.id === 'string' && typeof entry.name === 'string' && Number.isFinite(entry.updatedAt)).slice(0, 12) : [];
  } catch { return []; }
}
export function writeWebRecent(entries: RecentFileEntry[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(entries)); } catch { /* Recent file names are optional. */ }
}
