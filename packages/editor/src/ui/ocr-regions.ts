import type { PageModel, Rect } from '@pdf-editor/contracts';

export function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

/** Large image regions without a usable text layer. A page number is not a text layer. */
export function unrecognizedImageRegions(page: PageModel): Rect[] {
  const texts = page.objects.filter(object => object.textBlock?.runs.some(run => run.text.trim()));
  const images = page.objects.filter(object => object.type === 'image'
    && object.bounds.width * object.bounds.height >= page.widthPt * page.heightPt * 0.15);
  return images.filter(image => {
    const overlaid = texts.filter(text => overlapArea(text.bounds, image.bounds) > text.bounds.width * text.bounds.height * 0.5);
    if (overlaid.some(text => text.textBlock!.isOcr)) return false;
    const count = overlaid.reduce((sum, text) => sum + text.textBlock!.runs.reduce((n, run) => n + run.text.trim().length, 0), 0);
    const covered = overlaid.reduce((sum, text) => sum + overlapArea(text.bounds, image.bounds), 0);
    return count < 80 || covered < image.bounds.width * image.bounds.height * 0.02;
  }).map(image => image.bounds).filter((bounds, index, all) => !all.slice(0, index).some(other =>
    overlapArea(bounds, other) >= bounds.width * bounds.height * 0.9));
}

export function overlapsExistingText(page: PageModel, line: Rect): boolean {
  return page.objects.some(object => object.textBlock?.runs.some(run => run.text.trim())
    && overlapArea(object.bounds, line) > Math.min(object.bounds.width * object.bounds.height, line.width * line.height) * 0.5);
}
