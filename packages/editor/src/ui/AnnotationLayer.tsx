import { useEffect, useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import type { DocumentInfo, EngineAdapter, PageModel, PdfAnnotationInfo } from '@pdf-editor/contracts';
import type { PageGeometry } from './draw-render.js';
import type { TextActionSelection } from './text-actions.js';
import { isRenderCancelled, renderWork } from './render-work.js';
import { useI18n } from './i18n.js';
import './annotations.css';

export type CommentSelection = { documentId: string; pageId: string; id: string; anchor?: TextActionSelection['anchor'] };
export function AnnotationLayer({ document, page, render, engine, disabled, selected, onOpen, annotations: supplied, loading = false }: {
  document: DocumentInfo; page: PageModel; render: PageGeometry; engine: EngineAdapter; disabled: boolean;
  selected: CommentSelection | null; onOpen(selection: CommentSelection): void; annotations?: PdfAnnotationInfo[] | undefined; loading?: boolean;
}) {
  const { t } = useI18n();
  const [cached, setAnnotations] = useState<{ engine: EngineAdapter; version: number; items: PdfAnnotationInfo[] } | null>(null);
  const version = engine.getPageVersion?.(document.id, page.id) ?? document.revision;
  const cachedCurrent = cached?.engine === engine && cached.version === version;
  useEffect(() => {
    if (supplied !== undefined) { setAnnotations({ engine, version, items: supplied }); return; }
    if (loading || cachedCurrent || !engine.describeAnnotations) return;
    const controller = new AbortController();
    void renderWork(engine, () => engine.describeAnnotations!(document.id, page.id), { signal: controller.signal, priority: 'page' })
      .then(items => { if (!controller.signal.aborted) setAnnotations({ engine, version, items }); })
      .catch(caught => { if (!isRenderCancelled(caught)) { setAnnotations(null); console.warn('Unable to load page comments', caught); } });
    return () => controller.abort();
  }, [engine, document.id, page.id, version, supplied, loading]);
  const annotations = supplied ?? (cachedCurrent ? cached!.items : []);
  const x = render.width / page.widthPt, y = render.height / page.heightPt;
  return <div className="annotation-interaction-layer" aria-label={t('Page comments')}>
    {annotations.filter(item => item.pageId === page.id && item.subtype !== 'link').map((item, index) => {
      const active = selected?.documentId === document.id && selected.pageId === page.id && selected.id === item.id;
      return <button key={item.id} type="button" className="annotation-marker" data-annotation-id={item.id} aria-pressed={active}
        aria-label={t('Open comment {number} on page {page}', { number: index + 1, page: document.pageOrder.indexOf(page.id) + 1 })}
        title={item.text || t('No comment text')} disabled={disabled}
        style={{ left: item.subtype === 'text' ? Math.min(Math.max(0, item.bounds.x * x), Math.max(0, render.width - 24)) : render.width + 4,
          top: Math.min(Math.max(0, item.bounds.y * y), Math.max(0, render.height - 24)),
          backgroundColor: `rgb(${item.color.map(value => Math.round(value * 255)).join(' ')})` }}
        onPointerDown={event => event.stopPropagation()} onClick={event => {
          event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect();
          onOpen({ documentId: document.id, pageId: page.id, id: item.id, anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } });
        }}><MessageSquareText size={17} aria-hidden="true" /></button>;
    })}
  </div>;
}
