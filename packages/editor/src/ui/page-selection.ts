export type SelectionModifiers = { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };

export function selectPages(order: string[], selected: string[], anchor: string, target: string, modifiers: SelectionModifiers): string[] {
  if (modifiers.shiftKey) {
    const start = Math.max(0, order.indexOf(anchor));
    const end = order.indexOf(target);
    const range = order.slice(Math.min(start, end), Math.max(start, end) + 1);
    return modifiers.ctrlKey || modifiers.metaKey ? order.filter(id => selected.includes(id) || range.includes(id)) : range;
  }
  if (modifiers.ctrlKey || modifiers.metaKey) return order.filter(id => id === target ? !selected.includes(id) : selected.includes(id));
  return [target];
}

export function movePages(order: string[], selected: string[], target: string, after: boolean): string[] {
  if (selected.includes(target)) return order;
  const moving = order.filter(id => selected.includes(id));
  const rest = order.filter(id => !selected.includes(id));
  const index = rest.indexOf(target);
  if (index < 0) return order;
  rest.splice(index + (after ? 1 : 0), 0, ...moving);
  return rest;
}
