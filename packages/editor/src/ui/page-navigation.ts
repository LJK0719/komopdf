export function adjacentPageId(order: string[], currentIndex: number, step: -1 | 1, view: 'single' | 'double'): string | undefined {
  if (currentIndex < 0 || currentIndex >= order.length) return undefined;
  const target = view === 'double' ? currentIndex - currentIndex % 2 + step * 2 : currentIndex + step;
  return order[target];
}
