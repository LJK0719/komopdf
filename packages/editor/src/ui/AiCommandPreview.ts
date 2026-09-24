import type {
  DocumentInfo, EditTransaction, FormFieldInfo, Matrix, PageModel, Rect, TransactionPreviewResult,
} from '@pdf-editor/contracts';

type Change = { subject: string; before: string; after: string; manual?: boolean };
export type CommandImpact = { type: string; changes: Change[] };
export type CommandImpactPreview = {
  affectedPages: string[];
  beforeOrder: string[];
  afterOrder: string[];
  commands: CommandImpact[];
  requiresManualConfirmation: boolean;
};

const format = (value: number) => String(value);
const rect = (value: Rect) => `(${format(value.x)}, ${format(value.y)}) · ${format(value.width)} × ${format(value.height)} pt`;
const matrix = (value: Matrix) => `[${value.map(format).join(', ')}]`;
const value = (input: string | boolean | string[]) => Array.isArray(input) ? JSON.stringify(input) : JSON.stringify(input);
const textOf = (page: PageModel | undefined, blockId: string) =>
  page?.objects.find(object => object.textBlock?.id === blockId)?.textBlock?.runs.map(run => run.text).join('');

// PageModel transforms are in page coordinates. The native transform pre-multiplies the requested affine matrix.
function transform(before: Matrix, requested: Matrix): Matrix {
  const [a, b, c, d, e, f] = before;
  const [A, B, C, D, E, F] = requested;
  return [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d,
    A * e + C * f + E, B * e + D * f + F];
}

/** A structural comparison of the frozen candidate and the current page models; not a rendered PDF preview. */
export function buildCommandImpactPreview(
  transaction: EditTransaction,
  document: DocumentInfo,
  pages: ReadonlyMap<string, PageModel>,
  enginePreview: TransactionPreviewResult,
  forms: readonly FormFieldInfo[] = [],
): CommandImpactPreview {
  const currentText = new Map<string, string>();
  const currentStyles = new Map<string, Record<string, unknown>>();
  const unknownStyles = new Set<string>();
  const currentMatrices = new Map<string, Matrix>();
  const currentRotations = new Map<string, number>();
  const changedGeometry = new Set<string>();
  const currentValues = new Map(forms.map(field => [field.id, field.value]));
  let currentOrder = [...document.pageOrder];
  const commands: CommandImpact[] = transaction.commands.map(command => {
    const changes: Change[] = [];
    const add = (subject: string, before: string, after: string, manual = false) =>
      changes.push({ subject, before, after, ...(manual ? { manual: true } : {}) });
    const page = 'pageId' in command ? pages.get(command.pageId) : undefined;
    switch (command.type) {
      case 'text.replace': {
        const key = `${command.pageId}:${command.blockId}`;
        const before = currentText.get(key) ?? textOf(page, command.blockId);
        if (before === undefined || command.range[1] > before.length) {
          add(`Text block ${command.blockId}`, 'Text not available', 'Replacement requires manual confirmation', true);
        } else {
          const after = before.slice(0, command.range[0]) + command.text + before.slice(command.range[1]);
          add(`Text block ${command.blockId} · UTF-16 [${command.range.join(', ')}]`, before, after);
          currentText.set(key, after);
        }
        break;
      }
      case 'text.style':
        for (const id of command.blockIds) {
          const block = page?.objects.find(object => object.textBlock?.id === id)?.textBlock;
          const key = `${command.pageId}:${id}`;
          const previous = currentStyles.get(key) ?? block?.runs[0]?.style;
          const simple = Boolean(block && !command.range && block.runs.length === 1 && previous && !unknownStyles.has(key));
          const after = simple ? { ...previous, ...command.style } : undefined;
          add(`Text block ${id}${command.range ? ` · UTF-16 [${command.range.join(', ')}]` : ''}`,
            simple ? JSON.stringify(previous) : block ? JSON.stringify(block.runs.map(run => run.style)) : 'Current style unavailable',
            after ? JSON.stringify(after) : `Apply ${JSON.stringify(command.style)} to ${command.range ? 'selected range' : 'whole block'}; final run styles not exposed`,
            !simple);
          if (after) currentStyles.set(key, after);
          else unknownStyles.add(key);
        }
        break;
      case 'text.reflow': {
        const originals = command.blockIds.map(id => textOf(page, id));
        add(`Page ${command.pageId} · merge ${command.blockIds.join(', ')} → ${command.objectId}`,
          originals.some(item => item === undefined) ? 'Source text unavailable' : originals.join('\n'),
          `${command.text}\nTarget box: ${rect(command.bounds)}`, true);
        changedGeometry.add(command.pageId);
        break;
      }
      case 'pages.rotate':
        for (const id of command.pageIds) {
          const before = currentRotations.get(id) ?? pages.get(id)?.rotation;
          if (before === undefined) add(`Page ${id} · rotation`, 'Current rotation unavailable', `Rotate +${command.degrees}°`, true);
          else {
            const after = (before + command.degrees) % 360;
            add(`Page ${id} · rotation`, `${before}°`, `${after}°`);
            currentRotations.set(id, after);
          }
          changedGeometry.add(id);
        }
        break;
      case 'pages.crop':
        for (const id of command.pageIds) {
          const model = pages.get(id);
          add(`Page ${id} · crop`, model ? `Page size ${format(model.widthPt)} × ${format(model.heightPt)} pt; current crop not exposed` : 'Current crop not exposed',
            `Requested crop ${rect(command.bounds)}`, true);
          changedGeometry.add(id);
        }
        break;
      case 'pages.reorder':
        add('Page order', currentOrder.join(' → '), command.pageIds.join(' → '));
        currentOrder = [...command.pageIds];
        break;
      case 'pages.delete':
        for (const id of command.pageIds) add(`Page ${id}`, 'Present', 'Removed');
        currentOrder = currentOrder.filter(id => !command.pageIds.includes(id));
        break;
      case 'pages.insert': {
        add(`Page ${command.pageId}`, 'Absent', `Blank ${format(command.widthPt)} × ${format(command.heightPt)} pt · after ${command.afterPageId ?? 'document start'}`);
        currentOrder.splice(command.afterPageId === null ? 0 : currentOrder.indexOf(command.afterPageId) + 1, 0, command.pageId);
        break;
      }
      case 'pages.duplicate':
        command.pageIds.forEach((id, index) => add(`Page ${id} → ${command.newPageIds[index]}`, 'Source page present',
          `Duplicate after ${command.afterPageId ?? 'document start'}; appearance not available`, true));
        currentOrder.splice(command.afterPageId === null ? 0 : currentOrder.indexOf(command.afterPageId) + 1, 0, ...command.newPageIds);
        break;
      case 'objects.transform':
        for (const id of command.objectIds) {
          const key = `${command.pageId}:${id}`;
          const before = currentMatrices.get(key) ?? page?.objects.find(object => object.id === id)?.transform;
          const unknown = changedGeometry.has(command.pageId);
          if (!before || unknown) add(`Object ${id} · matrix`, before ? matrix(before) : 'Current matrix unavailable',
            `Apply ${matrix(command.matrix)}; resulting matrix not verified after earlier structural edits`, true);
          else {
            const after = transform(before, command.matrix);
            add(`Object ${id} · matrix`, matrix(before), matrix(after));
            currentMatrices.set(key, after);
          }
        }
        break;
      case 'objects.delete':
        for (const id of command.objectIds) {
          const obj = page?.objects.find(item => item.id === id);
          add(`Object ${id}`, obj ? `${obj.type} · bounds ${rect(obj.bounds)}` : 'Object details unavailable', 'Removed', !obj);
        }
        changedGeometry.add(command.pageId);
        break;
      case 'objects.copy':
        command.objectIds.forEach((id, index) => {
          const obj = page?.objects.find(item => item.id === id);
          add(`Object ${id} → ${command.newObjectIds[index]}`, obj ? `${obj.type} · bounds ${rect(obj.bounds)}` : 'Source object unavailable',
            `Copy with offset (${format(command.offset.x)}, ${format(command.offset.y)}) pt; appearance not available`, true);
        });
        changedGeometry.add(command.pageId);
        break;
      case 'objects.align':
      case 'objects.distribute':
        for (const id of command.objectIds) {
          const obj = page?.objects.find(item => item.id === id);
          add(`Object ${id}`, obj ? `Matrix ${matrix(obj.transform)} · bounds ${rect(obj.bounds)}` : 'Geometry unavailable',
            `${command.type === 'objects.align' ? 'Align' : 'Distribute'} ${command.axis}; resulting geometry not exposed`, true);
        }
        changedGeometry.add(command.pageId);
        break;
      case 'objects.group':
        add(`Objects ${command.objectIds.join(', ')}`, 'Separate objects', `Group ${command.groupId}; child geometry not exposed`, true);
        changedGeometry.add(command.pageId);
        break;
      case 'objects.ungroup':
        add(`Group ${command.groupId}`, 'Grouped object', 'Separate children; child IDs/geometry not exposed', true);
        changedGeometry.add(command.pageId);
        break;
      case 'form.fill': {
        const field = forms.find(item => item.id === command.fieldId);
        const before = currentValues.get(command.fieldId);
        add(`Field ${field?.name ?? command.fieldId} (${command.fieldId})${field ? ` · pages ${field.widgets.map(w => w.pageId).join(', ')}` : ''}`,
          before === undefined ? 'Current value unavailable' : value(before), value(command.value), before === undefined);
        currentValues.set(command.fieldId, command.value);
        break;
      }
      default: {
        const pageId = 'pageId' in command ? command.pageId : 'pageIds' in command && Array.isArray(command.pageIds) ? command.pageIds.join(', ') : 'document';
        add(`Page ${pageId} · ${command.type}`, 'Structure before edit', 'Structural change; resulting objects not available', true);
      }
    }
    return { type: command.type, changes };
  });
  return {
    affectedPages: enginePreview.changedPageIds,
    beforeOrder: document.pageOrder,
    afterOrder: enginePreview.pageOrder,
    commands,
    requiresManualConfirmation: commands.some(command => command.changes.some(change => change.manual)),
  };
}
