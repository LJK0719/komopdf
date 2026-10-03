import type { EditCommand } from '@pdf-editor/contracts';

/** Human page ranges are one-based; commands always receive zero-based indices in source order. */
export function parsePageIndices(input: string, pageCount: number): number[] {
  const normalized = input.trim().toLowerCase();
  if (normalized === 'all') return Array.from({ length: pageCount }, (_, index) => index);
  const positions = new Set<number>();
  for (const part of normalized.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    if (!match) throw new Error('Use all or page numbers such as 1-3,5');
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > pageCount) {
      throw new Error('Page range must refer to existing pages in ascending order');
    }
    for (let index = start; index <= end; index++) positions.add(index - 1);
  }
  return [...positions].sort((a, b) => a - b);
}

export function createPageImportCommand(resourceId: string, pageCount: number, range: string,
  afterPageId: string | null, pageOrder: string[], pageLimit?: number): Extract<EditCommand, { type: 'pages.import' }> {
  const pageIndices = parsePageIndices(range, pageCount);
  if (!pageIndices.length) throw new Error('Imported PDF has no pages');
  if (afterPageId !== null && !pageOrder.includes(afterPageId)) throw new Error('Choose an existing insertion page');
  if (pageLimit !== undefined && pageOrder.length + pageIndices.length > pageLimit) {
    throw new Error('The selected pages exceed the document page limit');
  }
  return { type: 'pages.import', resourceId, pageIndices, afterPageId,
    newPageIds: pageIndices.map(() => crypto.randomUUID()) };
}
