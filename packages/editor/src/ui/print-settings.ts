import { conversionPages } from './document-conversion.js';

export function selectPrintPages(scope: 'all' | 'current' | 'range', range: string,
  pageIds: string[], currentPageId: string): string[] {
  if (!pageIds.length) throw new Error('Select a PDF with pages before printing');
  if (scope === 'all') return [...pageIds];
  if (scope === 'current') {
    if (!pageIds.includes(currentPageId)) throw new Error('Page range is outside the document');
    return [currentPageId];
  }
  if (!range.trim()) throw new Error('Enter the pages to print, for example 1-3,5');
  const indices = new Set(conversionPages(range, pageIds.length, pageIds.indexOf(currentPageId)));
  // Print once per selected page, in document order, consistently with the system print service.
  return pageIds.filter((_, index) => indices.has(index));
}
