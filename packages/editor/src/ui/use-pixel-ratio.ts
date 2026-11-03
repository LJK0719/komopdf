import { useEffect, useState } from 'react';
import { devicePixelRatio } from './draw-render.js';

export function observePixelRatio(onChange: (ratio: number) => void): () => void {
  let current = devicePixelRatio();
  let query = window.matchMedia(`(resolution: ${current}dppx)`);
  const update = () => {
    const next = devicePixelRatio();
    if (next === current) return;
    query.removeEventListener('change', update);
    current = next;
    query = window.matchMedia(`(resolution: ${current}dppx)`);
    query.addEventListener('change', update);
    onChange(current);
  };
  query.addEventListener('change', update);
  window.addEventListener('resize', update);
  onChange(current);
  return () => { query.removeEventListener('change', update); window.removeEventListener('resize', update); };
}

export function usePixelRatio(): number {
  const [ratio, setRatio] = useState(devicePixelRatio);
  useEffect(() => observePixelRatio(setRatio), []);
  return ratio;
}
