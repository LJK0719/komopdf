import { useEffect, useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import type { DocumentInfo, EngineAdapter, PageModel, PdfAnnotationInfo, RenderResult } from '@pdf-editor/contracts';
import type { TextActionSelection } from './text-actions.js';
import { useI18n } from './i18n.js';
import './annotations.css';

export type CommentSelection = { documentId: string; pageId: string; id: string; anchor?: TextActionSelection['anchor'] };
export function AnnotationLayer({ document, page, render, engine, disabled, selected, onOpen }: {
  document: DocumentInfo; page: PageModel; render: RenderResult; engine: EngineAdapter; disabled: boolean;
  selected: CommentSelection | null; onOpen(selection: CommentSelection): void;
}) {
  const { t } = useI18n();
  const [annotations, setAnnotations] = useState<PdfAnnotationInfo[]>([]);
  const [error, setError] = useState(false);
  const version = engine.getPageVersion?.(document.id, page.id) ?? document.revision;
  useEffect(() => {
    let active = true; setError(false);
    void engine.describeAnnotations?.(document.id, page.id).then(items => { if (active) setAnnotations(items); })
      .catch(() => { if (active) { setAnnotations([]); setError(true); } });
    return () => { active = false; };
  }, [engine, document.id, page.id, version]);
  const x = render.width / page.widthPt, y = render.height / page.heightPt;
  return <div className="annotation-interaction-layer" aria-label={t('Page comments')}>
    {error && <span className="annotation-load-error" role="status">{t('Unable to load comments.')}</span>}
    {annotations.filter(item => item.subtype !== 'link').map((item, index) => {
      const active = selected?.documentId === document.id && selected.pageId === page.id && selected.id === item.id;
      return <button key={item.id} type="button" className="annotation-marker" data-annotation-id={item.id} aria-pressed={active}
        aria-label={t('Open comment {number} on page {page}', { number: index + 1, page: document.pageOrder.indexOf(page.id) + 1 })}
        title={item.text || t('No comment text')} disabled={disabled}
        style={{ left: Math.min(Math.max(0, item.bounds.x * x), Math.max(0, render.width - 24)),
          top: Math.min(Math.max(0, item.bounds.y * y), Math.max(0, render.height - 24)),
          backgroundColor: `rgb(${item.color.map(value => Math.round(value * 255)).join(' ')})` }}
        onPointerDown={event => event.stopPropagation()} onClick={event => {
          event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect();
          onOpen({ documentId: document.id, pageId: page.id, id: item.id, anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } });
        }}><MessageSquareText size={17} aria-hidden="true" /></button>;
    })}
  </div>;
}
