import type { EditableObject, PageModel, Rect } from '@pdf-editor/contracts';

export function containsRect(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance;
}

export function selectionScope(page: PageModel, selectedIds: string[]): EditableObject[] {
  const groups = page.objects.filter(object => object.type === 'group')
    .map(object => [...object.locator.containerPath, object.locator.objectIndex]);
  const parent = page.objects.find(object => selectedIds.includes(object.id))?.locator.containerPath;
  const editing = parent && groups.find(path => path.length === parent.length && path.every((part, i) => parent[i] === part));
  return page.objects.filter(object => editing
    ? object.locator.containerPath.length === editing.length && editing.every((part, i) => object.locator.containerPath[i] === part)
    : !groups.some(path => path.length <= object.locator.containerPath.length && path.every((part, i) => object.locator.containerPath[i] === part)));
}

// Geometry, not DOM paint order, decides which nested hitbox receives the click.
export function pickObject(objects: EditableObject[], x: number, y: number, tolerance: number): EditableObject | undefined {
  return objects.filter(object => containsRect(object.bounds, { x, y, width: 0, height: 0 }, tolerance))
    .sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height ||
      b.locator.objectIndex - a.locator.objectIndex)[0];
}

export function isContainerInterior(object: EditableObject, objects: EditableObject[], x: number, y: number, edge: number): boolean {
  const b = object.bounds;
  if (x <= b.x + edge || x >= b.x + b.width - edge || y <= b.y + edge || y >= b.y + b.height - edge) return false;
  return objects.some(child => child.id !== object.id &&
    child.bounds.width * child.bounds.height < b.width * b.height * 0.9 && containsRect(b, child.bounds));
}
