import { useState } from 'react';
import { CommandRegistry, validateTransaction } from '@pdf-editor/commands';
import { WEB_LIMITS, type CommandType, type CommitResult, type DocumentInfo, type EditCommand,
  type EngineAdapter, type HostAdapter, type PageModel, type TextLayoutResult } from '@pdf-editor/contracts';
import { useFontResources } from './font-resources.js';

type Props = { document: DocumentInfo; page: PageModel; selectedIds: string[]; engine: EngineAdapter;
  host: HostAdapter; disabled: boolean; onBusyChange(busy: boolean): void; onCommitted(result: CommitResult): Promise<void> };

export function ObjectEditPanel({ document, page, selectedIds, engine, host, disabled, onBusyChange, onCommitted }: Props) {
  const [x, setX] = useState(36), [y, setY] = useState(36);
  const [width, setWidth] = useState(240), [height, setHeight] = useState(120);
  const [dx, setDx] = useState(10), [dy, setDy] = useState(0);
  const [scale, setScale] = useState(100), [angle, setAngle] = useState(90);
  const [text, setText] = useState('New text'), [fontId, setFontId] = useState('');
  const [fontSize, setFontSize] = useState(12), [resourcePage, setResourcePage] = useState(1);
  const [color, setColor] = useState('#000000');
  const [lineHeight, setLineHeight] = useState(1.2);
  const [alignment, setAlignment] = useState<'left' | 'center' | 'right'>('left');
  const [textPreview, setTextPreview] = useState<{ key: string; layout: TextLayoutResult } | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const { fonts } = useFontResources(engine);
  const supports = (type: CommandType) => document.capabilities.includes(type);
  const locked = disabled || busy;
  const bounds = { x, y, width, height };
  const chosenFont = fontId || fonts[0]?.id;
  const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255) as [number, number, number];

  const layoutKey = JSON.stringify([document.id, document.revision, page.id, text, chosenFont, fontSize, color, bounds, lineHeight, alignment]);
  const currentTextPreview = textPreview?.key === layoutKey ? textPreview.layout : null;
  function textCommand(): Extract<EditCommand, { type: 'text.insert' }> {
    return { type: 'text.insert', pageId: page.id, objectId: crypto.randomUUID(), bounds, text,
      style: { fontId: chosenFont!, fontSize, color: rgb, lineHeight, alignment } };
  }
  async function insertText() {
    const command = textCommand();
    if (engine.previewTextInsert) {
      const layout = await engine.previewTextInsert({ docId: document.id, baseRevision: document.revision, command });
      setTextPreview({ key: layoutKey, layout });
      if (layout.overflow) throw new Error('Text does not fit the box. Increase its size or reduce the font size.');
    }
    await execute([command], new Set(), Boolean(engine.previewTextInsert));
  }

  async function execute(commands: EditCommand[], resourceIds = new Set<string>(), alreadyPreviewed = false) {
    const transaction = { id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual' as const, commands };
    const context = { document, pages: new Map([[page.id, page]]), fontIds: new Set(fonts.map(font => font.id)), resourceIds,
      ...(host.capabilities.platform === 'web' ? { pageLimit: WEB_LIMITS.pagesPerDocument } : {}) };
    validateTransaction(transaction, context);
    if (!alreadyPreviewed) await engine.previewTransaction(transaction);
    const result = await new CommandRegistry(engine).execute(transaction, context);
    await onCommitted(result);
  }
  async function run(operation: () => Promise<void>) {
    if (locked) return;
    setBusy(true); onBusyChange(true); setError('');
    try { await operation(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Edit failed'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  function reorder(direction: number) {
    const order = [...document.pageOrder], index = order.indexOf(page.id), target = index + direction;
    if (target < 0 || target >= order.length) return;
    order.splice(index, 1); order.splice(target, 0, page.id);
    return execute([{ type: 'pages.reorder', pageIds: order }]);
  }
  function transformSelection(mode: 'rotate' | 'scale') {
    const objects = page.objects.filter(object => selectedIds.includes(object.id));
    if (!objects.length) return Promise.resolve();
    const left = Math.min(...objects.map(object => object.bounds.x)), top = Math.min(...objects.map(object => object.bounds.y));
    const right = Math.max(...objects.map(object => object.bounds.x + object.bounds.width)), bottom = Math.max(...objects.map(object => object.bounds.y + object.bounds.height));
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    if (mode === 'scale' && scale <= 0) throw new Error('Scale must be positive');
    const radians = angle * Math.PI / 180;
    const a = mode === 'rotate' ? Math.cos(radians) : scale / 100;
    const b = mode === 'rotate' ? Math.sin(radians) : 0, c = -b, d = a;
    return execute([{ type: 'objects.transform', pageId: page.id, objectIds: selectedIds,
      matrix: [a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy] }]);
  }
  function alignSelection(axis: 'left' | 'top') {
    const objects = page.objects.filter(object => selectedIds.includes(object.id));
    const edge = Math.min(...objects.map(object => axis === 'left' ? object.bounds.x : object.bounds.y));
    return execute(objects.map(object => ({ type: 'objects.transform', pageId: page.id, objectIds: [object.id],
      matrix: [1, 0, 0, 1, axis === 'left' ? edge - object.bounds.x : 0, axis === 'top' ? edge - object.bounds.y : 0] })));
  }
  async function insertResource(kind: 'image' | 'pdf', mode: 'insert' | 'replace' | 'pages' = 'insert') {
    if (mode === 'insert' && (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)) throw new Error('Enter valid positive insertion dimensions');
    const source = await host.pickResource?.(kind);
    if (!source) return;
    const resource = await engine.registerResource({ docId: document.id, resourceId: crypto.randomUUID(), source });
    if (resource.kind !== (kind === 'pdf' ? 'pdf' : 'image')) throw new Error('Selected resource has a different type');
    const target = { pageId: page.id, objectId: crypto.randomUUID(), resourceId: resource.id, bounds };
    let command: EditCommand;
    if (mode === 'pages') {
      if (!resource.pageCount) throw new Error('Imported PDF has no pages');
      const pageIndices = Array.from({ length: resource.pageCount }, (_, index) => index);
      command = { type: 'pages.import', resourceId: resource.id, pageIndices,
        newPageIds: pageIndices.map(() => crypto.randomUUID()), afterPageId: page.id };
    } else if (mode === 'replace') {
      if (selectedIds.length !== 1 || page.objects.find(object => object.id === selectedIds[0])?.type !== 'image') throw new Error('Select one image to replace');
      command = { type: 'image.replace', pageId: page.id, objectId: selectedIds[0]!, resourceId: resource.id };
    } else {
      command = kind === 'pdf' ? { type: 'content.insert', ...target, resourcePageIndex: resourcePage - 1 }
        : { type: 'image.insert', ...target };
    }
    await execute([command], new Set([resource.id]));
  }
  const numberField = (label: string, value: number, setter: (value: number) => void) =>
    <label>{label}<input type="number" step="any" value={value} disabled={locked} onChange={event => setter(event.target.valueAsNumber)} /></label>;

  if (!supports('pages.insert') && !supports('objects.transform')) return null;
  return <section className="text-edit-panel" aria-label="Page and object editing">
    <details open><summary>Page & objects</summary>
      <div className="text-edit-actions">
        {supports('pages.rotate') && <button disabled={locked} onClick={() => void run(() => execute([{ type: 'pages.rotate', pageIds: [page.id], degrees: 90 }]))}>Rotate page</button>}
        {supports('pages.insert') && <button disabled={locked} onClick={() => void run(() => execute([{ type: 'pages.insert', pageId: crypto.randomUUID(), afterPageId: page.id, widthPt: page.widthPt, heightPt: page.heightPt }]))}>Add blank page</button>}
        {supports('pages.duplicate') && <button disabled={locked} onClick={() => void run(() => execute([
          { type: 'pages.duplicate', pageIds: [page.id], newPageIds: [crypto.randomUUID()], afterPageId: page.id },
        ]))}>Duplicate page</button>}
        {supports('pages.import') && host.pickResource && <button disabled={locked} onClick={() => void run(() => insertResource('pdf', 'pages'))}>Import PDF pages</button>}
        {supports('pages.delete') && <button disabled={locked || document.pageOrder.length <= 1} onClick={() => {
          if (window.confirm('Delete the current page? This can be undone.')) void run(() => execute([{ type: 'pages.delete', pageIds: [page.id] }]));
        }}>Delete page</button>}
        {supports('pages.reorder') && <>
          <button disabled={locked || document.pageOrder[0] === page.id} onClick={() => void run(async () => { await reorder(-1); })}>Move page earlier</button>
          <button disabled={locked || document.pageOrder.at(-1) === page.id} onClick={() => void run(async () => { await reorder(1); })}>Move page later</button>
        </>}
      </div>
      {numberField('Move X (pt)', dx, setDx)}{numberField('Move Y (pt)', dy, setDy)}
      {supports('objects.transform') && <>
        {numberField('Scale (%)', scale, setScale)}{numberField('Rotation (degrees)', angle, setAngle)}
        <button disabled={locked || !selectedIds.length} onClick={() => void run(() => transformSelection('scale'))}>Scale selected objects</button>
        <button disabled={locked || !selectedIds.length} onClick={() => void run(() => transformSelection('rotate'))}>Rotate selected objects</button>
        <button disabled={locked || selectedIds.length < 2} onClick={() => void run(() => alignSelection('left'))}>Align left</button>
        <button disabled={locked || selectedIds.length < 2} onClick={() => void run(() => alignSelection('top'))}>Align top</button>
      </>}
      <div className="text-edit-actions">
        {supports('objects.transform') && <button disabled={locked || !selectedIds.length} onClick={() => void run(() => execute([
          { type: 'objects.transform', pageId: page.id, objectIds: selectedIds, matrix: [1, 0, 0, 1, dx, dy] },
        ]))}>Move selected objects</button>}
        {supports('objects.copy') && <button disabled={locked || !selectedIds.length} onClick={() => void run(() => execute([
          { type: 'objects.copy', pageId: page.id, objectIds: selectedIds,
            newObjectIds: selectedIds.map(() => crypto.randomUUID()), offset: { x: dx, y: dy } },
        ]))}>Duplicate selected objects</button>}
        {supports('objects.delete') && <button disabled={locked || !selectedIds.length} onClick={() => void run(() => execute([
          { type: 'objects.delete', pageId: page.id, objectIds: selectedIds },
        ]))}>Delete selected objects</button>}
      </div>
    </details>
    <details><summary>Insert & format</summary>
      <p>Top-left coordinates and dimensions in PDF points.</p>
      {numberField('X (pt)', x, setX)}{numberField('Y (pt)', y, setY)}
      {numberField('Width (pt)', width, setWidth)}{numberField('Height (pt)', height, setHeight)}
      {host.pickResource && <>
        {supports('image.insert') && <button disabled={locked} onClick={() => void run(() => insertResource('image'))}>Insert image</button>}
        {supports('image.replace') && <button disabled={locked || selectedIds.length !== 1 || page.objects.find(object => object.id === selectedIds[0])?.type !== 'image'}
          onClick={() => void run(() => insertResource('image', 'replace'))}>Replace selected image</button>}
        {supports('image.crop') && <>
          <button disabled={locked || selectedIds.length !== 1 || page.objects.find(object => object.id === selectedIds[0])?.type !== 'image'}
            onClick={() => void run(() => execute([{ type: 'image.crop', pageId: page.id, objectId: selectedIds[0]!, bounds }]))}>Crop selected image to box</button>
          <p>Cropping hides pixels and can be undone. It is not secure redaction.</p>
        </>}
        {supports('content.insert') && <>
          {numberField('Source PDF page', resourcePage, setResourcePage)}
          <button disabled={locked} onClick={() => void run(() => insertResource('pdf'))}>Insert PDF content</button>
        </>}
      </>}
      <label>Font<select disabled={locked} value={chosenFont ?? ''} onChange={event => setFontId(event.target.value)}>
        {fonts.map(font => <option key={font.id} value={font.id}>{font.family} · {font.style}</option>)}
      </select></label>
      {numberField('Font size (pt)', fontSize, setFontSize)}
      <label>Text color<input type="color" value={color} disabled={locked} onChange={event => setColor(event.target.value)} /></label>
      <label>New text<textarea rows={4} value={text} disabled={locked} onChange={event => setText(event.target.value)} /></label>
      {numberField('Line height (em)', lineHeight, setLineHeight)}
      <label>Text alignment<select value={alignment} disabled={locked} onChange={event => setAlignment(event.target.value as typeof alignment)}>
        <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
      </select></label>
      {supports('text.insert') && <>
        {engine.previewTextInsert && <button disabled={locked || !chosenFont} onClick={() => void run(async () => {
          const layout = await engine.previewTextInsert!({ docId: document.id, baseRevision: document.revision, command: textCommand() });
          setTextPreview({ key: layoutKey, layout });
        })}>Preview text box</button>}
        <button disabled={locked || !chosenFont || Boolean(currentTextPreview?.overflow)} onClick={() => void run(insertText)}>Insert text</button>
        {currentTextPreview && <p role="status">{currentTextPreview.overflow ? 'Text box overflow' : 'Text fits box'} · {currentTextPreview.lines.length} lines</p>}
      </>}
      {supports('text.style') && <button disabled={locked || !selectedIds.some(id => page.objects.find(object => object.id === id)?.textBlock)} onClick={() => void run(() => execute([
        { type: 'text.style', pageId: page.id,
          blockIds: page.objects.filter(object => selectedIds.includes(object.id) && object.textBlock).map(object => object.textBlock!.id),
          style: { fontSize, color: rgb, ...(chosenFont ? { fontId: chosenFont } : {}) } },
      ]))}>Format selected text</button>}
    </details>
    {error && <p role="alert">{error}</p>}
  </section>;
}
