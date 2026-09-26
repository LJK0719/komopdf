import { useI18n } from './i18n.js';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { PageModel, PdfAnnotationInfo, RenderResult } from '@pdf-editor/contracts';

type Props = {
  annotations: PdfAnnotationInfo[];
  page: PageModel;
  render: RenderResult;
  pageOrder: string[];
  disabled?: boolean;
  onNavigate(targetPageId: string, targetTopPt?: number): void;
};

export function PdfLinkLayer({ annotations, page, render, pageOrder, disabled = false, onNavigate }: Props) {
  const { t } = useI18n();
  // Only render link annotations that have a safely resolved target page in pageOrder
  const validLinks = annotations.filter(
    (annot): annot is PdfAnnotationInfo & { targetPageId: string } =>
      annot.subtype === 'link' &&
      typeof annot.targetPageId === 'string' &&
      pageOrder.includes(annot.targetPageId),
  );

  if (validLinks.length === 0) {
    return null;
  }

  const scaleX = render.width / page.widthPt;
  const scaleY = render.height / page.heightPt;

  return (
    <div
      className="pdf-link-layer"
      aria-label="PDF internal links"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      {validLinks.map((link) => {
        const targetPageIndex = pageOrder.indexOf(link.targetPageId);
        const targetPageNumber = targetPageIndex >= 0 ? targetPageIndex + 1 : 1;
        const left = link.bounds.x * scaleX;
        const top = link.bounds.y * scaleY;
        const width = Math.max(link.bounds.width * scaleX, 6);
        const height = Math.max(link.bounds.height * scaleY, 6);

        return (
          <ContextMenu.Root key={link.id}>
          <ContextMenu.Trigger render={<button type="button" disabled={disabled} />}
            role="link"
            className="pdf-link-annotation"
            aria-label={`Go to page ${targetPageNumber}`}
            data-target-page-id={link.targetPageId}
            data-target-page-number={targetPageNumber}
            title={`Go to page ${targetPageNumber}`}
            style={{
              left,
              top,
              width,
              height,
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (disabled) return;
              onNavigate(link.targetPageId, link.targetTopPt);
            }}
          />
          <ContextMenu.Portal><ContextMenu.Positioner><ContextMenu.Popup className="ui-menu">
            <ContextMenu.Item className="ui-menu-item" disabled={disabled} onClick={() => onNavigate(link.targetPageId, link.targetTopPt)}>{t('Go to page {page}', { page: targetPageNumber })}</ContextMenu.Item>
          </ContextMenu.Popup></ContextMenu.Positioner></ContextMenu.Portal>
          </ContextMenu.Root>
        );
      })}
    </div>
  );
}
