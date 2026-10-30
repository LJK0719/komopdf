import type { ReactNode } from 'react';
import { ArrowUpRight, Clock3, FileText, FolderOpen, LoaderCircle, X } from 'lucide-react';
import { useI18n } from './i18n.js';

export type RecentFileEntry = { id: string; name: string; kind: 'pdf' | 'folder'; location: string; updatedAt: number };
export function StartPage({ busy, isWeb, onOpen, onOpenFolder, recent = [], onOpenRecent, onForgetRecent, children, status }: {
  busy: boolean; isWeb: boolean; onOpen(): void; onOpenFolder?(): void; recent?: RecentFileEntry[];
  onOpenRecent?(entry: RecentFileEntry): void; onForgetRecent?(id: string): void; children?: ReactNode; status?: string;
}) {
  const { t } = useI18n();
  return <div className="start-page">
    <section className="start-dropzone" aria-label={t('Open documents')} aria-busy={busy}>
      <div className="start-document-icon" aria-hidden="true"><FileText size={36} strokeWidth={1.3} /></div>
      <header className="start-heading"><h1>{t('Open a PDF. Make it yours.')}</h1><p>{t(isWeb ? 'Drop your file here to start editing.' : 'Choose a document to start editing.')}</p></header>
      <button className="button button-primary button-large start-open" type="button" aria-label={t('Open PDF')} onClick={onOpen} disabled={busy}>
        {busy ? <LoaderCircle size={18} className="loading-spinner" aria-hidden="true" /> : <FolderOpen size={18} aria-hidden="true" />}
        {t(busy ? 'Opening…' : 'Open PDF')}
      </button>
      <p className="start-hint" role="status">{t(busy ? status ?? 'Opening…' : isWeb ? 'No sign-up. Files stay on your device.' : 'Choose one or more PDFs')}</p>
      {onOpenFolder && <button className="start-folder" type="button" onClick={onOpenFolder} disabled={busy}><FolderOpen size={16} aria-hidden="true" />{t('Open folder')}<ArrowUpRight size={14} aria-hidden="true" /></button>}
    </section>
    {children}
    {recent.length > 0 && <section className="start-recent" aria-label={t('Recent files')}>
      <header><Clock3 size={16} aria-hidden="true" /><h2>{t('Recent files')}</h2>{isWeb && <span>{t('Select the original file to reopen it')}</span>}</header>
      <ul>{recent.map(entry => <li key={entry.id}>
        <button type="button" className="recent-open" disabled={busy} onClick={() => onOpenRecent?.(entry)} title={entry.location || entry.name}>
          {entry.kind === 'folder' ? <FolderOpen size={19} aria-hidden="true" /> : <FileText size={19} aria-hidden="true" />}
          <span><strong>{entry.name}</strong><small>{entry.location || t(entry.kind === 'folder' ? 'Folder' : 'PDF document')}</small></span>
          <time dateTime={new Date(entry.updatedAt).toISOString()}>{new Date(entry.updatedAt).toLocaleDateString()}</time>
        </button>
        {onForgetRecent && <button className="recent-remove icon-button" type="button" disabled={busy}
          onClick={() => onForgetRecent(entry.id)} aria-label={t('Remove {name} from recent files', { name: entry.name })} title={t('Remove from recent files')}><X size={15} /></button>}
      </li>)}</ul>
    </section>}
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
