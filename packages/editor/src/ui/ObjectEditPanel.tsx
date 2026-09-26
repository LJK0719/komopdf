import { translate as t, useI18n } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import { CommandRegistry, validateTransaction } from '@pdf-editor/commands';
import { WEB_LIMITS, type CommandType, type CommitResult, type DocumentInfo, type EditCommand,
  type EngineAdapter, type HostAdapter, type PageModel, type TextLayoutResult } from '@pdf-editor/contracts';
import { useFontResources } from './font-resources.js';

type Props = { mode?: 'edit' | 'pages' | 'arrange'; pageSelection?: string[] | null; section?: 'number' | 'watermark' | 'header' | null; document: DocumentInfo; page: PageModel; selectedIds: string[]; engine: EngineAdapter;
  host: HostAdapter; disabled: boolean; onBusyChange(busy: boolean): void;
  onSelectionChange(ids: string[]): void; onCommitted(result: CommitResult): Promise<void> };

export function ObjectEditPanel({ mode = 'edit', section, pageSelection, document, page, selectedIds, engine, host, disabled, onBusyChange, onSelectionChange, onCommitted }: Props) {
  useI18n();
  const [x, setX] = useState(36), [y, setY] = useState(36);
  const [width, setWidth] = useState(240), [height, setHeight] = useState(120);
  const [dx, setDx] = useState(10), [dy, setDy] = useState(0);
  const [scale, setScale] = useState(100), [angle, setAngle] = useState(90);
  const [text, setText] = useState('New text'), [fontId, setFontId] = useState('');
  const [fontSize, setFontSize] = useState(12), [resourcePage, setResourcePage] = useState(1);
  const [color, setColor] = useState('#000000');
  const [lineHeight, setLineHeight] = useState(1.2);
  const [alignment, setAlignment] = useState<'left' | 'center' | 'right'>('left');
  const [pageRange, setPageRange] = useState('current');
  const [extractRange, setExtractRange] = useState('current');
  const selectedPageNumbers = pageSelection?.map(id => document.pageOrder.indexOf(id) + 1).filter(number => number > 0).join(',');
  useEffect(() => {
    if (selectedPageNumbers === undefined) return;
    setPageRange(selectedPageNumbers); setExtractRange(selectedPageNumbers);
  }, [selectedPageNumbers]);
  const [decoration, setDecoration] = useState<'number' | 'header' | 'footer' | 'watermark'>('number');
  const [decorationText, setDecorationText] = useState('komopdf');
  const decorationSection = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (mode !== 'pages' || !section || !decorationSection.current) return;
    setDecoration(section); decorationSection.current.open = true;
    decorationSection.current.scrollIntoView({ block: 'nearest' });
  }, [section, mode]);
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

  async function execute(commands: EditCommand[], resourceIds = new Set<string>(), alreadyPreviewed = false,
    loadedPages: Map<string, PageModel> = new Map([[page.id, page]])) {
    const transaction = { id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual' as const, commands };
    const context = { document, pages: loadedPages, fontIds: new Set(fonts.map(font => font.id)), resourceIds,
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
  function alignSelection(axis: Extract<EditCommand, { type: 'objects.align' }>['axis']) {
    return execute([{ type: 'objects.align', pageId: page.id, objectIds: selectedIds, axis }]);
  }
  function distributeSelection(axis: 'horizontal' | 'vertical') {
    return execute([{ type: 'objects.distribute', pageId: page.id, objectIds: selectedIds, axis }]);
  }
  const groupable = page.objects.filter(object => selectedIds.includes(object.id));
  const groupPath = groupable[0]?.locator.containerPath ?? [];
  const groupSiblings = page.objects.filter(object => object.locator.containerPath.length === groupPath.length &&
    object.locator.containerPath.every((part, index) => part === groupPath[index]));
  const canGroup = groupable.length === selectedIds.length && groupable.length >= 2 &&
    groupable.every(object => groupSiblings.includes(object)) &&
    groupable.every((object, index) => index === 0 || groupSiblings.indexOf(object) === groupSiblings.indexOf(groupable[index - 1]!) + 1);
  const selectedGroup = selectedIds.length === 1
    ? page.objects.find(object => object.id === selectedIds[0] && object.type === 'group')
    : undefined;
  const parentGroup = groupPath.length ? page.objects.find(object => object.type === 'group' &&
    object.locator.objectIndex === groupPath.at(-1) && object.locator.containerPath.length === groupPath.length - 1 &&
    object.locator.containerPath.every((part, index) => part === groupPath[index])) : undefined;
  function selectGroupContents() {
    if (!selectedGroup) return;
    const path = [...selectedGroup.locator.containerPath, selectedGroup.locator.objectIndex];
    onSelectionChange(page.objects.filter(object => object.locator.containerPath.length === path.length &&
      object.locator.containerPath.every((part, index) => part === path[index])).map(object => object.id));
  }
  async function groupSelection() {
    const groupId = crypto.randomUUID();
    await execute([{ type: 'objects.group', pageId: page.id, objectIds: groupable.map(object => object.id), groupId }]);
    onSelectionChange([groupId]);
  }
  async function ungroupSelection() {
    if (!selectedGroup) return;
    const path = [...selectedGroup.locator.containerPath, selectedGroup.locator.objectIndex];
    const childIds = page.objects.filter(object => object.locator.containerPath.length === path.length &&
      object.locator.containerPath.every((part, index) => part === path[index])).map(object => object.id);
    await execute([{ type: 'objects.ungroup', pageId: page.id, groupId: selectedGroup.id }]);
    onSelectionChange(childIds);
  }
  async function addPageDecoration() {
    if (!chosenFont) throw new Error('Choose an embedded font first');
    if (!Number.isFinite(fontSize) || fontSize <= 0) throw new Error('Choose a positive font size');
    const targetIds = parsePageRange(pageRange, document.pageOrder, page.id);
    if (targetIds.length > 4096) throw new Error('The native transaction can contain at most 4096 page decorations; use smaller ranges');
    const loaded = new Map<string, PageModel>();
    const commands: EditCommand[] = [];
    for (const pageId of targetIds) {
      const target = pageId === page.id ? page : await engine.describePage(document.id, pageId);
      loaded.set(pageId, target);
      const number = document.pageOrder.indexOf(pageId) + 1;
      const margin = Math.min(36, target.widthPt * 0.08, target.heightPt * 0.08);
      const height = Math.min(48, target.heightPt * 0.2);
      const bounds = { x: margin, y: decoration === 'header' ? margin
        : decoration === 'watermark' ? (target.heightPt - height) / 2
          : target.heightPt - margin - height, width: target.widthPt - 2 * margin, height };
      const label = decoration === 'number' ? String(number) : decorationText.replaceAll('{page}', String(number));
      if (!label.trim()) throw new Error('Enter the page decoration text');
      commands.push({ type: 'text.insert', pageId, objectId: crypto.randomUUID(), bounds,
        text: label, style: { fontId: chosenFont, fontSize,
          color: decoration === 'watermark' ? [0.65, 0.65, 0.65] : rgb,
          alignment: decoration === 'number' ? 'right' : decoration === 'watermark' ? 'center' : 'left' },
        paragraph: true });
    }
    await execute(commands, new Set(), false, loaded);
  }

  async function extractSelectedPages() {
    if (!engine.extractPages) throw new Error('This PDF core does not support page extraction');
    const result = await engine.extractPages({ docId: document.id,
      pageIds: parsePageRange(extractRange, document.pageOrder, page.id) });
    if (result.docId !== document.id || result.sourceRevision !== document.revision) {
      throw new Error('The PDF changed during page extraction; start again from the current revision');
    }
    await host.saveDocument({ ...result, savedRevision: result.sourceRevision }, 'komopdf-extracted-pages.pdf');
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
    <label>{t(label)}<input type="number" step="any" value={value} disabled={locked} onChange={event => setter(event.target.valueAsNumber)} /></label>;

  if (!supports('pages.insert') && !supports('objects.transform')) return null;
  return <section className="text-edit-panel" aria-label="Page and object editing">
    <details open hidden={mode !== 'pages' || Boolean(pageSelection)}><summary>{t("Pages")}</summary>
      <div className="text-edit-actions">
        {supports('pages.rotate') && <button disabled={locked} onClick={() => void run(() => execute([{ type: 'pages.rotate', pageIds: [page.id], degrees: 90 }]))}>{t("Rotate page")}</button>}
        {supports('pages.insert') && <button disabled={locked} onClick={() => void run(() => execute([{ type: 'pages.insert', pageId: crypto.randomUUID(), afterPageId: page.id, widthPt: page.widthPt, heightPt: page.heightPt }]))}>{t("Add blank page")}</button>}
        {supports('pages.duplicate') && <button disabled={locked} onClick={() => void run(() => execute([
          { type: 'pages.duplicate', pageIds: [page.id], newPageIds: [crypto.randomUUID()], afterPageId: page.id },
        ]))}>{t("Duplicate page")}</button>}
        {supports('pages.import') && host.pickResource && <button disabled={locked} onClick={() => void run(() => insertResource('pdf', 'pages'))}>{t("Import PDF pages")}</button>}
        {supports('pages.delete') && <button disabled={locked || document.pageOrder.length <= 1} onClick={() => {
          if (window.confirm(t("Delete this page? You can undo this action."))) void run(() => execute([{ type: 'pages.delete', pageIds: [page.id] }]));
        }}>{t("Delete page")}</button>}
        {supports('pages.reorder') && <>
          <button disabled={locked || document.pageOrder[0] === page.id} onClick={() => void run(async () => { await reorder(-1); })}>{t("Move page earlier")}</button>
          <button disabled={locked || document.pageOrder.at(-1) === page.id} onClick={() => void run(async () => { await reorder(1); })}>{t("Move page later")}</button>
        </>}
      </div>
    </details>
    <details open={mode === 'arrange'} hidden={mode !== 'edit' && mode !== 'arrange'}><summary>{t("Arrange objects")}</summary>
      {numberField(t("Move X (pt)"), dx, setDx)}{numberField(t("Move Y (pt)"), dy, setDy)}
      {supports('objects.transform') && <>
        {numberField(t("Scale (%)"), scale, setScale)}{numberField(t("Rotation (degrees)"), angle, setAngle)}
        <button disabled={locked || !selectedIds.length} onClick={() => void run(() => transformSelection('scale'))}>{t("Scale")}</button>
        <button disabled={locked || !selectedIds.length} onClick={() => void run(() => transformSelection('rotate'))}>{t("Rotate")}</button>
      </>}
      {supports('objects.align') && <div className="text-edit-actions" aria-label={t("Align selected objects")}>
        {(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map(axis =>
          <button key={axis} disabled={locked || selectedIds.length < 2}
            onClick={() => void run(() => alignSelection(axis))}>{t("Align")} {axis}</button>)}
      </div>}
      {supports('objects.distribute') && <div className="text-edit-actions" aria-label={t("Distribute selected objects")}>
        <button disabled={locked || selectedIds.length < 3} onClick={() => void run(() => distributeSelection('horizontal'))}>{t("Distribute horizontally")}</button>
        <button disabled={locked || selectedIds.length < 3} onClick={() => void run(() => distributeSelection('vertical'))}>{t("Distribute vertically")}</button>
      </div>}
      <div className="text-edit-actions">
        {supports('objects.group') && <button disabled={locked || !canGroup} onClick={() => void run(groupSelection)}>{t("Group")}</button>}
        {supports('objects.ungroup') && <button disabled={locked || !selectedGroup} onClick={() => void run(ungroupSelection)}>{t("Ungroup")}</button>}
        {selectedGroup && <button disabled={locked} onClick={selectGroupContents}>{t("Edit group contents")}</button>}
        {parentGroup && <button disabled={locked} onClick={() => onSelectionChange([parentGroup.id])}>{t("Select parent group")}</button>}
        {supports('objects.transform') && <button disabled={locked || !selectedIds.length} onClick={() => void run(() => execute([
          { type: 'objects.transform', pageId: page.id, objectIds: selectedIds, matrix: [1, 0, 0, 1, dx, dy] },
        ]))}>{t("Move")}</button>}
        {supports('objects.copy') && <button disabled={locked || !selectedIds.length} onClick={() => void run(() => execute([
          { type: 'objects.copy', pageId: page.id, objectIds: selectedIds,
            newObjectIds: selectedIds.map(() => crypto.randomUUID()), offset: { x: dx, y: dy } },
        ]))}>{t("Duplicate")}</button>}
        {supports('objects.delete') && <button disabled={locked || !selectedIds.length} onClick={() => void run(() => execute([
          { type: 'objects.delete', pageId: page.id, objectIds: selectedIds },
        ]))}>{t("Delete selected objects")}</button>}
      </div>
    </details>
    {engine.extractPages && <details open hidden={mode !== 'pages'}><summary>{t("Extract pages to a new PDF")}</summary>
      <label>{t("Pages to extract")}<input value={extractRange} disabled={locked}
        placeholder={t("current, all, or 1-3,5")} onChange={event => setExtractRange(event.target.value)} /></label>
      <button type="button" disabled={locked || !document.permissions.copy || document.permissions.encrypted}
        onClick={() => void run(extractSelectedPages)}>{t("Extract PDF copy")}</button>

    </details>}
    {supports('text.insert') && <details ref={decorationSection} hidden={mode !== 'pages'}><summary>{t("Page numbers & watermark")}</summary>
      <label>{t("Pages")}<input value={pageRange} disabled={locked} placeholder={t("current, all, or 1-3,5")}
        onChange={event => setPageRange(event.target.value)} /></label>
      <label>{t("Decoration")}<select value={decoration} disabled={locked}
        onChange={event => setDecoration(event.target.value as typeof decoration)}>
        <option value="number">{t("Page number")}</option><option value="header">{t("Header")}</option>
        <option value="footer">{t("Footer")}</option><option value="watermark">{t("Watermark")}</option>
      </select></label>
      {decoration !== 'number' && <label>{t("Decoration text (use")} {'{page}'} {t("for page number)")}<input value={decorationText} disabled={locked} onChange={event => setDecorationText(event.target.value)} />
      </label>}
      <label>{t("Decoration font")}<select disabled={locked} value={chosenFont ?? ''}
        onChange={event => setFontId(event.target.value)}>
        {fonts.map(font => <option key={font.id} value={font.id}>{font.family} · {font.style}</option>)}
      </select></label>
      {numberField(t("Decoration font size (pt)"), fontSize, setFontSize)}
      <label>{t("Decoration color")}<input type="color" value={color} disabled={locked}
        onChange={event => setColor(event.target.value)} /></label>
      <button disabled={locked || !chosenFont} onClick={() => void run(addPageDecoration)}>{t("Apply to selected pages")}</button>

    </details>}
    <details open hidden={mode !== 'edit'}><summary>{t("Add text & images")}</summary>

      {numberField(t("X (pt)"), x, setX)}{numberField(t("Y (pt)"), y, setY)}
      {numberField(t("Width (pt)"), width, setWidth)}{numberField(t("Height (pt)"), height, setHeight)}
      {supports('pages.crop') && <>
        <button disabled={locked} onClick={() => {
          if (window.confirm(t("Crop this page?")))
            void run(() => execute([{ type: 'pages.crop', pageIds: [page.id], bounds }]));
        }}>{t("Crop page to box")}</button>

      </>}
      {host.pickResource && <>
        {supports('image.insert') && <>
          <button disabled={locked} onClick={() => void run(() => insertResource('image'))}>{t("Insert image")}</button>
          <button disabled={locked} onClick={() => void run(() => insertResource('image'))}>{t("Place visual signature image")}</button>

        </>}
        {supports('image.replace') && <button disabled={locked || selectedIds.length !== 1 || page.objects.find(object => object.id === selectedIds[0])?.type !== 'image'}
          onClick={() => void run(() => insertResource('image', 'replace'))}>{t("Replace selected image")}</button>}
        {supports('image.crop') && <>
          <button disabled={locked || selectedIds.length !== 1 || page.objects.find(object => object.id === selectedIds[0])?.type !== 'image'}
            onClick={() => void run(() => execute([{ type: 'image.crop', pageId: page.id, objectId: selectedIds[0]!, bounds }]))}>{t("Crop selected image to box")}</button>

        </>}
        {supports('content.insert') && <>
          {numberField(t("Source PDF page"), resourcePage, setResourcePage)}
          <button disabled={locked} onClick={() => void run(() => insertResource('pdf'))}>{t("Insert PDF content")}</button>
        </>}
      </>}
      <label>{t("Font")}<select disabled={locked} value={chosenFont ?? ''} onChange={event => setFontId(event.target.value)}>
        {fonts.map(font => <option key={font.id} value={font.id}>{font.family} · {font.style}</option>)}
      </select></label>
      {numberField(t("Font size (pt)"), fontSize, setFontSize)}
      <label>{t("Text color")}<input type="color" value={color} disabled={locked} onChange={event => setColor(event.target.value)} /></label>
      <label>{t("New text")}<textarea rows={4} value={text} disabled={locked} onChange={event => setText(event.target.value)} /></label>
      {numberField(t("Line height (em)"), lineHeight, setLineHeight)}
      <label>{t("Text alignment")}<select value={alignment} disabled={locked} onChange={event => setAlignment(event.target.value as typeof alignment)}>
        <option value="left">{t("Left")}</option><option value="center">{t("Center")}</option><option value="right">{t("Right")}</option>
      </select></label>
      {supports('text.insert') && <>
        {engine.previewTextInsert && <button disabled={locked || !chosenFont} onClick={() => void run(async () => {
          const layout = await engine.previewTextInsert!({ docId: document.id, baseRevision: document.revision, command: textCommand() });
          setTextPreview({ key: layoutKey, layout });
        })}>{t("Preview text box")}</button>}
        <button disabled={locked || !chosenFont || Boolean(currentTextPreview?.overflow)} onClick={() => void run(insertText)}>{t("Insert text")}</button>
        {currentTextPreview && <p role="status">{currentTextPreview.overflow ? t("Text box overflow") : t("Text fits box")} · {currentTextPreview.lines.length} {t("lines")}</p>}
      </>}
      {supports('text.style') && <button disabled={locked || !selectedIds.some(id => page.objects.find(object => object.id === id)?.textBlock)} onClick={() => void run(() => execute([
        { type: 'text.style', pageId: page.id,
          blockIds: page.objects.filter(object => selectedIds.includes(object.id) && object.textBlock).map(object => object.textBlock!.id),
          style: { fontSize, color: rgb, ...(chosenFont ? { fontId: chosenFont } : {}) } },
      ]))}>{t("Format selected text")}</button>}
    </details>
    {error && <p role="alert">{t(error)}</p>}
  </section>;
}

function parsePageRange(input: string, order: string[], currentPage: string): string[] {
  const normalized = input.trim().toLowerCase();
  if (normalized === 'current') return [currentPage];
  if (normalized === 'all') return [...order];
  const positions = new Set<number>();
  for (const part of normalized.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    if (!match) throw new Error('Use current, all, or page numbers such as 1-3,5');
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > order.length) {
      throw new Error('Page range must refer to existing pages in ascending order');
    }
    for (let index = start; index <= end; index++) positions.add(index);
  }
  return [...positions].sort((a, b) => a - b).map(index => order[index - 1]!);
}
