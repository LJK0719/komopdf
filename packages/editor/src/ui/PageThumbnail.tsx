import { useI18n } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { EngineAdapter } from '@pdf-editor/contracts';
import { drawRender } from './draw-render.js';

type Props = { engine: EngineAdapter; docId: string; pageId: string; revision: number; scale?: number };

export function PageThumbnail({ engine, docId, pageId, revision, scale = 0.16 }: Props) {
  useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = canvas.current;
    if (!element || !('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => setVisible(Boolean(entries[0]?.isIntersecting)),
      { root: element.closest('.page-list, .canvas-stage'), rootMargin: '120px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) {
      if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; }
      return;
    }
    let disposed = false;
    void engine.render({ docId, pageId, scale }).then(render => {
      if (!disposed && render.revision === revision) drawRender(canvas.current, render);
    }).catch(() => {
      // A thumbnail is optional; the full-size page reports its own errors.
    });
    return () => { disposed = true; };
  }, [engine, docId, pageId, revision, visible, scale]);

  return <canvas ref={canvas} className="page-thumbnail" aria-hidden="true" />;
}
