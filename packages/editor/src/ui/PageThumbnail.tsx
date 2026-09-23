import { useEffect, useRef, useState } from 'react';
import type { EngineAdapter } from '@pdf-editor/contracts';
import { drawRender } from './draw-render.js';

type Props = { engine: EngineAdapter; docId: string; pageId: string; revision: number };

export function PageThumbnail({ engine, docId, pageId, revision }: Props) {
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
      { root: element.closest('.page-list'), rootMargin: '120px' },
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
    void engine.render({ docId, pageId, scale: 0.16 }).then(render => {
      if (!disposed && render.revision === revision) drawRender(canvas.current, render);
    }).catch(() => {
      // A thumbnail is optional; the full-size page reports its own errors.
    });
    return () => { disposed = true; };
  }, [engine, docId, pageId, revision, visible]);

  return <canvas ref={canvas} className="page-thumbnail" aria-hidden="true" />;
}
