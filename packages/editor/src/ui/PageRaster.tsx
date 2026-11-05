import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { EngineAdapter, PageMetrics } from '@pdf-editor/contracts';
import { drawRender, mountVisiblePageTiles, type PageRender } from './draw-render.js';

type Props = {
  engine: EngineAdapter; docId: string; page: PageMetrics; render: PageRender; zoom: number; pixelRatio: number;
  root: RefObject<HTMLElement | null>; paused: boolean; active: boolean; label: string;
  onError(error: unknown): void;
  onPaint?(): void;
};

/** Keep at most one painted fallback until the replacement covers the visible page. */
export function PageRaster(props: Props) {
  const ready = useRef<PageRender | null>(null);
  const notified = useRef<PageRender | null>(null);
  const [layers, setLayers] = useState<{ front: PageRender; back: PageRender | null }>({ front: props.render, back: null });
  if (layers.front !== props.render) {
    setLayers({ front: props.render, back: props.render.mode === 'tiles' ? ready.current : null });
  }
  const painted = (render: PageRender) => {
    ready.current = render;
    if (render === props.render && notified.current !== render) {
      notified.current = render;
      props.onPaint?.();
    }
    setLayers(current => current.front === render && current.back ? { ...current, back: null } : current);
  };
  return <>{[layers.back, layers.front].filter((render): render is PageRender => render !== null).map(render =>
    <RasterLayer key={render.mode === 'full' ? 'full' : `tiles:${render.zoom}:${render.pixelRatio}:${render.revision}`}
      {...props} render={render} paused={props.paused || render !== layers.front || render.zoom !== props.zoom || render.pixelRatio !== props.pixelRatio} fallback={render !== layers.front}
      onReady={() => painted(render)} />)}</>;
}

function RasterLayer({ engine, docId, page, render, zoom, root, paused, active, label, fallback, onError, onReady }: Props & {
  fallback: boolean; onReady(): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const mount = useRef<ReturnType<typeof mountVisiblePageTiles> | null>(null);
  const latest = useRef({ paused, active, onError, onReady });
  latest.current = { paused, active, onError, onReady };
  useLayoutEffect(() => {
    if (render.mode === 'full') {
      if (render.bitmap) { drawRender(canvas.current, render.bitmap); latest.current.onReady(); }
      return;
    }
    if (!layer.current || !root.current) return;
    const work = mountVisiblePageTiles(layer.current, root.current, engine, docId, page, render,
      error => latest.current.onError(error), {
        paused: latest.current.paused,
        priority: () => latest.current.active ? 'active' : 'page',
        onReady: () => latest.current.onReady(),
      });
    mount.current = work;
    return () => { mount.current = null; work(); };
  }, [engine, docId, page, render, root]);
  useLayoutEffect(() => { mount.current?.setPaused(paused); }, [paused]);
  useLayoutEffect(() => {
    const element = canvas.current;
    return () => { if (element) { element.width = 0; element.height = 0; } };
  }, []);
  if (render.mode === 'full') return <canvas ref={canvas} width={0} height={0}
    className={`pdf-canvas${fallback ? ' pdf-raster-fallback' : ''}`} aria-label={label} aria-hidden={fallback || undefined}
    style={{ position: 'absolute', left: 0, top: 0, width: page.widthPt * zoom, height: page.heightPt * zoom, pointerEvents: 'none' }} />;
  return <div ref={layer} className={`pdf-tile-layer${fallback ? ' pdf-raster-fallback' : ''}`} role="img" aria-label={label} aria-hidden={fallback || undefined}
    style={{ width: page.widthPt * render.zoom, height: page.heightPt * render.zoom, transformOrigin: '0 0', transform: `scale(${zoom / render.zoom})` }} />;
}
