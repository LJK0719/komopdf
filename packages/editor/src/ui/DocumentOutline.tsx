import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { OutlineEntry } from '@pdf-editor/contracts';
import { useI18n } from './i18n.js';

type Node = OutlineEntry & { index: number; children: Node[] };
function outlineTree(entries: OutlineEntry[]): Node[] {
  const roots: Node[] = [], parents: Node[] = [];
  entries.forEach((entry, index) => {
    const node: Node = { ...entry, index, children: [] };
    while (parents.length && parents[parents.length - 1]!.level >= entry.level) parents.pop();
    (parents[parents.length - 1]?.children ?? roots).push(node);
    parents.push(node);
  });
  return roots;
}

export function DocumentOutline({ entries, pageOrder, currentPageId, disabled, loading, error, onNavigate }: {
  entries: OutlineEntry[]; pageOrder: string[]; currentPageId: string | undefined;
  disabled: boolean; loading: boolean; error: boolean; onNavigate(pageId: string): void;
}) {
  const { t } = useI18n();
  const roots = useMemo(() => outlineTree(entries), [entries]);
  const pages = useMemo(() => new Map(pageOrder.map((id, index) => [id, index + 1])), [pageOrder]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const toggle = (index: number) => setExpanded(previous => {
    const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next;
  });
  const render = (nodes: Node[]) => <ul className="outline-branches">{nodes.map(node => {
    const title = node.title || t('Untitled'), hasChildren = node.children.length > 0, open = expanded.has(node.index);
    const page = node.pageId ? pages.get(node.pageId) : undefined;
    return <li key={node.index}>
      <div className="outline-row">
        {hasChildren ? <button type="button" className="outline-toggle" aria-label={title} aria-expanded={open}
          onClick={() => toggle(node.index)}><ChevronRight size={14} aria-hidden="true" /></button> : <span className="outline-spacer" />}
        <button type="button" className="outline-link" title={title} disabled={disabled || (!page && !hasChildren)}
          aria-label={t('Go to bookmark {title}', { title })} aria-current={node.pageId === currentPageId ? 'page' : undefined}
          onClick={() => { if (node.pageId && page) onNavigate(node.pageId); else if (hasChildren) toggle(node.index); }}>
          <span>{title}</span>{page && <small>{page}</small>}
        </button>
      </div>
      {hasChildren && open && render(node.children)}
    </li>;
  })}</ul>;
  return <nav className="bookmark-list" aria-label={t('PDF bookmarks')}>
    {loading ? <span role="status">{t('Loading…')}</span> : error ? <span role="status">{t('Bookmarks could not be read')}</span>
      : roots.length ? render(roots) : <span>{t('No bookmarks in this document.')}</span>}
  </nav>;
}
