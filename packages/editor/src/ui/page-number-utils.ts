import type { EditCommand, PageModel, TextStyle } from '@pdf-editor/contracts';
import { parsePageIndices } from './page-import-utils.js';

export type PageNumberTotal = 'selected' | 'document';
export type PageNumberLabel = { pageId: string; physicalPage: number; text: string };

export function parsePageRange(input: string, order: string[], currentPage: string): string[] {
  if (input.trim().toLowerCase() === 'current') return [currentPage];
  return parsePageIndices(input, order.length).map(index => order[index]!);
}

export function pageNumberLabels({ order, targetIds, start, template, total, skipCover }: {
  order: string[]; targetIds: string[]; start: number; template: string; total: PageNumberTotal; skipCover: boolean;
}): PageNumberLabel[] {
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('Starting number must be a non-negative whole number');
  if (!template.includes('{page}')) throw new Error('Include {page} in the page number template');
  if (/\{[^{}]*\}/.test(template.replaceAll('{page}', '').replaceAll('{total}', ''))) {
    throw new Error('Only {page} and {total} placeholders are supported');
  }
  const selected = new Set(targetIds);
  const targets = order.filter((id, index) => selected.has(id) && !(skipCover && index === 0));
  if (!targets.length) throw new Error('Choose at least one page to number');
  if (!Number.isSafeInteger(start + targets.length - 1)) throw new Error('The ending page number is too large');
  const count = total === 'document' ? order.length : targets.length;
  return targets.map((pageId, index) => ({ pageId, physicalPage: order.indexOf(pageId) + 1,
    text: template.replaceAll('{page}', String(start + index)).replaceAll('{total}', String(count)) }));
}

export function createPageNumberCommand(page: PageModel, text: string, style: TextStyle,
  alignment: 'left' | 'center' | 'right'): Extract<EditCommand, { type: 'text.insert' }> {
  const margin = Math.min(36, page.widthPt * 0.08, page.heightPt * 0.08);
  const height = Math.min(48, page.heightPt * 0.2);
  return { type: 'text.insert', pageId: page.id, objectId: crypto.randomUUID(), text,
    bounds: { x: margin, y: page.heightPt - margin - height, width: page.widthPt - 2 * margin, height },
    style: { ...style, alignment }, paragraph: true };
}
