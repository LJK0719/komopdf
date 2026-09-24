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
          <button
            key={link.id}
            type="button"
            role="link"
            className="pdf-link-annotation"
            aria-label={`Go to page ${targetPageNumber}`}
            data-target-page-id={link.targetPageId}
            data-target-page-number={targetPageNumber}
            title={`Go to page ${targetPageNumber}`}
            disabled={disabled}
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
        );
      })}
    </div>
  );
}
