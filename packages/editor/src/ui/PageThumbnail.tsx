import { useI18n } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { EngineAdapter } from '@pdf-editor/contracts';
import { devicePixelRatio, drawRender } from './draw-render.js';
import { renderWork } from './render-work.js';

type Props = { engine: EngineAdapter; docId: string; pageId: string; revision: number; pixelRatio?: number };

export function PageThumbnail({ engine, docId, pageId, revision, pixelRatio = devicePixelRatio() }: Props) {
  useI18n();
  const version = engine.getPageVersion?.(docId, pageId) ?? revision;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const width = Math.ceil(size.width * pixelRatio), height = Math.ceil(size.height * pixelRatio);

  useEffect(() => {
    const element = canvas.current;
    if (!element || !('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(Boolean(entries[0]?.isIntersecting)),
      { root: element.closest('.page-list, .canvas-stage'), rootMargin: '120px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (bounds) setSize(previous => previous.width === bounds.width && previous.height === bounds.height
        ? previous : { width: bounds.width, height: bounds.height });
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = canvas.current;
    return () => { if (element) { element.width = 0; element.height = 0; } };
  }, [docId, pageId]);

  useEffect(() => {
    const element = canvas.current;
    if (!visible || !width || !height) {
      if (element) { element.width = 0; element.height = 0; }
      return;
    }
    const controller = new AbortController();
    const options = { signal: controller.signal, priority: 'thumbnail' as const };
    const timer = setTimeout(() => {
      void (async () => {
        const page = await renderWork(engine, () => engine.describePage(docId, pageId), options);
        const scale = Math.min(width / page.widthPt, height / page.heightPt);
        const render = await renderWork(engine, () => engine.render({ docId, pageId, scale }), options);
        if (!controller.signal.aborted && version === (engine.getPageVersion?.(docId, pageId) ?? render.revision)) drawRender(element, render);
      })().catch(() => {
        // A thumbnail is optional; the full-size page reports its own errors.
      });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [engine, docId, pageId, version, visible, width, height]);

  return <canvas ref={canvas} width={0} height={0} className="page-thumbnail" aria-hidden="true" />;
}
