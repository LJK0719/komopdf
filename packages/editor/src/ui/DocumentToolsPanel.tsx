import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandRegistry } from '@pdf-editor/commands';
import {
  type CommitResult,
  type DocumentInfo,
  type EditCommand,
  type EditTransaction,
  type EngineAdapter,
  type FormFieldInfo,
  type PageModel,
  type PdfAnnotationInfo,
  type Rect,
} from '@pdf-editor/contracts';
import { useFontResources } from './font-resources.js';

type Props = {
  document: DocumentInfo;
  page: PageModel;
  selectedIds: string[];
  engine: EngineAdapter;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
  onCommitted(result: CommitResult): Promise<void>;
};

type BoundsDraft = { x: string; y: string; width: string; height: string };
type FormValue = FormFieldInfo['value'];

const DEFAULT_FORM_FONT_ID = 'noto-sans-cjk-sc-regular';

export function DocumentToolsPanel({ document, page, selectedIds, engine, disabled, onBusyChange, onCommitted }: Props) {
  const [boundsDraft, setBoundsDraft] = useState<BoundsDraft>({ x: '36', y: '36', width: '180', height: '48' });
  const [annotationText, setAnnotationText] = useState('');
  const [annotationColor, setAnnotationColor] = useState('#fff176');
  const [opacity, setOpacity] = useState('0.7');
  const [strokeWidth, setStrokeWidth] = useState('2');
  const [inkPoints, setInkPoints] = useState('36,36; 96,64');
  const [fieldName, setFieldName] = useState('New field');
  const [fieldType, setFieldType] = useState<'text' | 'checkbox' | 'combo' | 'list'>('text');
  const [fieldOptions, setFieldOptions] = useState('Option A\nOption B');
  const [fieldFontId, setFieldFontId] = useState('');
  const [fieldFontSize, setFieldFontSize] = useState('12');
  const [annotations, setAnnotations] = useState<PdfAnnotationInfo[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [fields, setFields] = useState<FormFieldInfo[]>([]);
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, FormValue>>({});
  const [dataScope, setDataScope] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const loadSequence = useRef(0);
  const scope = `${document.id}\0${document.revision}\0${page.id}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const { fonts, error: fontError } = useFontResources(engine);
  const chosenFont = fonts.find(font => font.id === fieldFontId)
    ?? fonts.find(font => font.id === DEFAULT_FORM_FONT_ID)
    ?? fonts[0];
  const locked = disabled || busy;
  const supportsAnnotations = document.capabilities.some(capability => capability.startsWith('annotation.'));
  const canAddAnnotation = document.capabilities.includes('annotation.add');
  const canUpdateAnnotation = document.capabilities.includes('annotation.update');
  const canDeleteAnnotation = document.capabilities.includes('annotation.delete');
  const supportsFormCreate = document.capabilities.includes('form.create');
  const supportsFormFill = document.capabilities.includes('form.fill');
  const canReadAnnotations = supportsAnnotations && Boolean(engine.describeAnnotations);
  const canReadForms = (supportsFormCreate || supportsFormFill) && Boolean(engine.describeForms);

  const selectedBounds = useMemo(() => {
    const objects = page.objects.filter(object => selectedIds.includes(object.id));
    if (objects.length === 0) return null;
    const left = Math.min(...objects.map(object => object.bounds.x));
    const top = Math.min(...objects.map(object => object.bounds.y));
    const right = Math.max(...objects.map(object => object.bounds.x + object.bounds.width));
    const bottom = Math.max(...objects.map(object => object.bounds.y + object.bounds.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, [page, selectedIds]);

  useEffect(() => {
    const sequence = ++loadSequence.current;
    const expectedScope = scope;
    setLoading(canReadAnnotations || canReadForms);
    setLoadError('');
    setDataScope('');

    const annotationRequest = canReadAnnotations
      ? engine.describeAnnotations!(document.id, page.id)
      : Promise.resolve<PdfAnnotationInfo[]>([]);
    const formRequest = canReadForms
      ? engine.describeForms!(document.id)
      : Promise.resolve<FormFieldInfo[]>([]);

    void Promise.all([annotationRequest, formRequest]).then(([nextAnnotations, nextFields]) => {
      if (loadSequence.current !== sequence || scopeRef.current !== expectedScope) return;
      setAnnotations(nextAnnotations);
      setFields(nextFields);
      setFieldDrafts(Object.fromEntries(nextFields.map(field => [field.id, copyFormValue(field.value)])));
      setDataScope(expectedScope);
    }).catch(caught => {
      if (loadSequence.current === sequence && scopeRef.current === expectedScope) {
        setAnnotations([]);
        setFields([]);
        setLoadError(formatError(caught));
      }
    }).finally(() => {
      if (loadSequence.current === sequence && scopeRef.current === expectedScope) setLoading(false);
    });

    return () => { loadSequence.current += 1; };
  }, [canReadAnnotations, canReadForms, document.id, document.revision, engine, page.id, scope]);

  const currentFields = dataScope === scope
    ? fields.filter(field => field.widgets.some(widget => widget.pageId === page.id))
    : [];
  const currentAnnotations = dataScope === scope ? annotations : [];
  const selectedAnnotation = currentAnnotations.find(annotation => annotation.id === selectedAnnotationId);

  async function execute(command: EditCommand): Promise<void> {
    const expectedScope = scope;
    const transaction: EditTransaction = {
      id: crypto.randomUUID(),
      docId: document.id,
      baseRevision: document.revision,
      source: 'manual',
      commands: [command],
    };
    const context = {
      document,
      pages: new Map([[page.id, page]]),
      fields: buildFieldContext(dataScope === scope ? fields : [], page.id),
      annotations: new Map(currentAnnotations.map(annotation => [annotation.id,
        { pageId: annotation.pageId, subtype: annotation.subtype }])),
      ...(command.type === 'form.create' && command.fontId
        ? { fontIds: new Set([command.fontId]) }
        : {}),
    };
    await engine.previewTransaction(transaction);
    if (scopeRef.current !== expectedScope) throw new Error('The document changed while previewing this edit');
    const result = await new CommandRegistry(engine).execute(transaction, context);
    await onCommitted(result);
  }

  async function run(operation: () => Promise<void>): Promise<void> {
    if (locked) return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      await operation();
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  async function addAnnotation(subtype: 'highlight' | 'text' | 'rectangle'): Promise<void> {
    const bounds = readBounds(boundsDraft);
    const command: EditCommand = {
      type: 'annotation.add',
      pageId: page.id,
      annotationId: crypto.randomUUID(),
      subtype,
      bounds,
      color: hexToRgb(annotationColor),
      opacity: readOpacity(opacity),
      ...(annotationText ? { text: annotationText } : {}),
      ...(subtype === 'rectangle' ? { strokeWidth: readPositive(strokeWidth, 'Stroke width') } : {}),
    };
    await execute(command);
  }

  async function addInk(): Promise<void> {
    await execute({
      type: 'annotation.add',
      pageId: page.id,
      annotationId: crypto.randomUUID(),
      subtype: 'ink',
      bounds: readBounds(boundsDraft),
      color: hexToRgb(annotationColor),
      opacity: readOpacity(opacity),
      strokeWidth: readPositive(strokeWidth, 'Stroke width'),
      points: parseInkPoints(inkPoints),
      ...(annotationText ? { text: annotationText } : {}),
    });
  }

  function selectAnnotation(annotation: PdfAnnotationInfo): void {
    setSelectedAnnotationId(annotation.id);
    setBoundsDraft({
      x: formatNumber(annotation.bounds.x), y: formatNumber(annotation.bounds.y),
      width: formatNumber(annotation.bounds.width), height: formatNumber(annotation.bounds.height),
    });
    setAnnotationText(annotation.text);
    setAnnotationColor(rgbToHex(annotation.color));
    setOpacity(formatNumber(annotation.opacity));
  }

  async function updateAnnotation(annotation: PdfAnnotationInfo): Promise<void> {
    if (annotation.subtype === 'other') throw new Error('This annotation subtype cannot be rebuilt');
    await execute({
      type: 'annotation.update', pageId: page.id, annotationId: annotation.id,
      subtype: annotation.subtype, bounds: readBounds(boundsDraft), text: annotationText,
      color: hexToRgb(annotationColor), opacity: readOpacity(opacity),
      ...(annotation.subtype === 'rectangle' || annotation.subtype === 'ink'
        ? { strokeWidth: readPositive(strokeWidth, 'Stroke width') } : {}),
      ...(annotation.subtype === 'ink' ? { points: parseInkPoints(inkPoints) } : {}),
    });
  }

  async function deleteAnnotation(annotation: PdfAnnotationInfo): Promise<void> {
    await execute({ type: 'annotation.delete', pageId: page.id, annotationId: annotation.id });
    setSelectedAnnotationId(null);
  }

  async function createField(): Promise<void> {
    const name = fieldName.trim();
    if (!name) throw new Error('Field name is required');
    if (fieldType !== 'checkbox' && !chosenFont) throw new Error('Choose an available embedded font for the field');
    const choice = fieldType === 'combo' || fieldType === 'list';
    const options = fieldOptions.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (choice && !options.length) throw new Error('Enter one choice per line');
    await execute({
      type: 'form.create',
      pageId: page.id,
      fieldId: crypto.randomUUID(),
      name,
      fieldType,
      bounds: readBounds(boundsDraft),
      ...(fieldType !== 'checkbox' ? {
        fontId: chosenFont!.id,
        fontSize: readPositive(fieldFontSize, 'Font size'),
      } : {}),
      ...(choice ? { options } : {}),
    });
  }

  async function fillField(field: FormFieldInfo): Promise<void> {
    const value = fieldDrafts[field.id] ?? field.value;
    await execute({ type: 'form.fill', fieldId: field.id, value });
  }

  function useSelectionBounds(): void {
    if (!selectedBounds) return;
    setBoundsDraft({
      x: formatNumber(selectedBounds.x),
      y: formatNumber(selectedBounds.y),
      width: formatNumber(selectedBounds.width),
      height: formatNumber(selectedBounds.height),
    });
  }

  return <section className="text-edit-panel document-tools-panel" aria-label="Annotations and forms">
    <span className="eyebrow">Document Tools</span>
    <p>Coordinates and dimensions use PDF points on the current page.</p>
    <div className="document-tools-grid">
      {boundsInput('X', 'x', boundsDraft, setBoundsDraft, locked)}
      {boundsInput('Y', 'y', boundsDraft, setBoundsDraft, locked)}
      {boundsInput('Width', 'width', boundsDraft, setBoundsDraft, locked)}
      {boundsInput('Height', 'height', boundsDraft, setBoundsDraft, locked)}
    </div>
    <button type="button" disabled={locked || !selectedBounds} onClick={useSelectionBounds}>Use selection bounds</button>

    <details open>
      <summary>Annotations on this page</summary>
      {!supportsAnnotations ? <p role="status">The current PDF core does not advertise annotation editing.</p> : <>
        {!engine.describeAnnotations ? <p role="alert">Annotation inspection is unavailable in this adapter.</p> : null}
        {loading ? <p role="status">Loading annotations…</p> : null}
        {!loading && canReadAnnotations && currentAnnotations.length === 0 ? <p>No annotations on this page.</p> : null}
        {currentAnnotations.length > 0 ? <ul className="document-tools-list">
          {currentAnnotations.map(annotation => <li key={annotation.id}>
            <strong>{annotation.subtype}</strong>
            <span>{formatRect(annotation.bounds)} · {Math.round(annotation.opacity * 100)}%</span>
            {annotation.text ? <span>{annotation.text}</span> : null}
            <button type="button" disabled={locked} onClick={() => selectAnnotation(annotation)}
              aria-label={`Edit ${annotation.subtype} annotation`}>Select for editing</button>
            {canDeleteAnnotation && <button type="button" disabled={locked || !document.permissions.annotate}
              aria-label={`Delete ${annotation.subtype} annotation`} onClick={() => {
                if (window.confirm('Delete this annotation? You can undo this change.'))
                  void run(() => deleteAnnotation(annotation));
              }}>Delete</button>}
          </li>)}
        </ul> : null}
        <label>Annotation text<textarea rows={2} value={annotationText} disabled={locked || !supportsAnnotations}
          onChange={event => setAnnotationText(event.target.value)} /></label>
        <div className="document-tools-grid">
          <label>Color<input type="color" value={annotationColor} disabled={locked || !supportsAnnotations}
            onChange={event => setAnnotationColor(event.target.value)} /></label>
          <label>Opacity<input type="number" min="0" max="1" step="0.05" value={opacity} disabled={locked || !supportsAnnotations}
            onChange={event => setOpacity(event.target.value)} /></label>
          <label>Stroke width<input type="number" min="0.1" step="0.1" value={strokeWidth} disabled={locked || !supportsAnnotations}
            onChange={event => setStrokeWidth(event.target.value)} /></label>
        </div>
        {canUpdateAnnotation && selectedAnnotation && selectedAnnotation.subtype !== 'other' && <button type="button"
          disabled={locked || !document.permissions.annotate} onClick={() => void run(() => updateAnnotation(selectedAnnotation))}>
          Update selected annotation
        </button>}
        <div className="text-edit-actions">
          <button type="button" disabled={locked || !canAddAnnotation || !document.permissions.annotate} onClick={() => void run(() => addAnnotation('text'))}>Add note</button>
          <button type="button" disabled={locked || !canAddAnnotation || !document.permissions.annotate} onClick={() => void run(() => addAnnotation('highlight'))}>Add highlight</button>
          <button type="button" disabled={locked || !canAddAnnotation || !document.permissions.annotate} onClick={() => void run(() => addAnnotation('rectangle'))}>Add rectangle</button>
        </div>
        <label>Ink points (x,y; x,y; …)<textarea rows={2} value={inkPoints}
          disabled={locked || (!canAddAnnotation && !(canUpdateAnnotation && selectedAnnotation?.subtype === 'ink'))}
          onChange={event => setInkPoints(event.target.value)} /></label>
        {selectedAnnotation?.subtype === 'ink' && <p>Updating ink replaces its stroke with these points.</p>}
        <button type="button" disabled={locked || !canAddAnnotation || !document.permissions.annotate} onClick={() => void run(addInk)}>Add ink</button>
        {!document.permissions.annotate ? <p role="alert">This document does not permit annotations.</p> : null}
      </>}
    </details>

    <details open>
      <summary>Forms on this page</summary>
      {!supportsFormCreate && !supportsFormFill ? <p role="status">The current PDF core does not advertise form editing.</p> : <>
        {!engine.describeForms ? <p role="alert">Form inspection is unavailable in this adapter.</p> : null}
        {loading ? <p role="status">Loading fields…</p> : null}
        {!loading && canReadForms && currentFields.length === 0 ? <p>No form fields on this page.</p> : null}
        {currentFields.length > 0 ? <div className="document-fields-list">
          {currentFields.map(field => {
            const draft = fieldDrafts[field.id] ?? field.value;
            return <div className="document-field" key={field.id}>
              <div className="document-field-heading">
                <strong>{field.name}</strong>
                <span>{field.type}{field.required ? ' · required' : ''}{field.readOnly ? ' · read-only' : ''}</span>
              </div>
              {fieldEditor(field, draft, locked || field.readOnly || !supportsFormFill, value => {
                setFieldDrafts(current => ({ ...current, [field.id]: value }));
              })}
              <button type="button" disabled={locked || field.readOnly || !supportsFormFill || !document.permissions.fillForms}
                onClick={() => void run(() => fillField(field))}>Apply value</button>
            </div>;
          })}
        </div> : null}
        {supportsFormFill && !document.permissions.fillForms ? <p role="alert">This document does not permit form filling.</p> : null}

        {supportsFormCreate ? <fieldset disabled={locked || !document.permissions.modify}>
          <legend>Create a field</legend>
          <label>Field name<input value={fieldName} onChange={event => setFieldName(event.target.value)} /></label>
          <label>Field type<select value={fieldType} onChange={event => setFieldType(event.target.value as typeof fieldType)}>
            <option value="text">Text</option><option value="checkbox">Checkbox</option>
            <option value="combo">Dropdown choice</option><option value="list">List choice</option>
          </select></label>
          {(fieldType === 'combo' || fieldType === 'list') && <label>Options (one per line)
            <textarea rows={4} value={fieldOptions} onChange={event => setFieldOptions(event.target.value)} />
          </label>}
          {fieldType !== 'checkbox' ? <>
            <label>Field font<select value={chosenFont?.id ?? ''} onChange={event => setFieldFontId(event.target.value)}>
              {fonts.map(font => <option key={font.id} value={font.id}>{font.family} · {font.style}</option>)}
            </select></label>
            <label>Font size<input type="number" min="0.1" max="1000" step="0.1" value={fieldFontSize}
              onChange={event => setFieldFontSize(event.target.value)} /></label>
            {fontError ? <p role="alert">{fontError}</p> : null}
          </> : null}
          <button type="button" disabled={fieldType !== 'checkbox' && !chosenFont} onClick={() => void run(createField)}>Create field</button>
        </fieldset> : null}
        {supportsFormCreate && !document.permissions.modify ? <p role="alert">This document does not permit creating fields.</p> : null}
      </>}
    </details>

    {loadError ? <p role="alert">Unable to read document tools: {loadError}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

function boundsInput(
  label: string,
  key: keyof BoundsDraft,
  draft: BoundsDraft,
  setDraft: (value: BoundsDraft) => void,
  disabled: boolean,
) {
  return <label>{label}<input type="number" step="any" value={draft[key]} disabled={disabled}
    onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>;
}

function fieldEditor(field: FormFieldInfo, value: FormValue, disabled: boolean, onChange: (value: FormValue) => void) {
  if (field.type === 'checkbox') {
    return <label className="document-checkbox"><input type="checkbox" checked={typeof value === 'boolean' ? value : false}
      disabled={disabled} onChange={event => onChange(event.target.checked)} />Checked</label>;
  }
  if (field.type === 'radio') {
    return <label>Value<select value={typeof value === 'string' ? value : ''} disabled={disabled}
      onChange={event => onChange(event.target.value)}>
      {!field.required ? <option value="">None</option> : null}
      {field.options.map(option => <option key={option} value={option}>{option}</option>)}
    </select></label>;
  }
  if (field.type === 'choice') {
    const multiple = Array.isArray(value);
    return <label>Value<select multiple={multiple} value={multiple ? value : typeof value === 'string' ? value : ''} disabled={disabled}
      onChange={event => onChange(multiple
        ? Array.from(event.currentTarget.selectedOptions, option => option.value)
        : event.currentTarget.value)}>
      {!multiple && !field.required ? <option value="">None</option> : null}
      {field.options.map(option => <option key={option} value={option}>{option}</option>)}
    </select></label>;
  }
  return <label>Value<input type="text" value={typeof value === 'string' ? value : ''} disabled={disabled}
    onChange={event => onChange(event.target.value)} /></label>;
}

function buildFieldContext(fields: FormFieldInfo[], currentPageId: string) {
  return new Map(fields.flatMap(field => field.widgets.some(widget => widget.pageId === currentPageId)
    ? [[field.id, {
      pageId: currentPageId,
      type: field.type,
      options: field.options,
      readOnly: field.readOnly,
    }] as const]
    : []));
}

function readBounds(draft: BoundsDraft): Rect {
  const bounds = {
    x: Number(draft.x),
    y: Number(draft.y),
    width: Number(draft.width),
    height: Number(draft.height),
  };
  if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('Enter finite coordinates and positive width and height');
  }
  return bounds;
}

function readOpacity(value: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 1) throw new Error('Opacity must be between 0 and 1');
  return result;
}

function readPositive(value: string, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${label} must be positive`);
  return result;
}

function parseInkPoints(value: string): [number, number][] {
  const points = value.split(/[;\n]+/).map(item => item.trim()).filter(Boolean).map(item => {
    const coordinates = item.split(/[,\s]+/).map(Number);
    if (coordinates.length !== 2 || !coordinates.every(Number.isFinite)) throw new Error('Ink points must use x,y pairs separated by semicolons');
    return [coordinates[0]!, coordinates[1]!] as [number, number];
  });
  if (points.length < 2) throw new Error('Ink requires at least two coordinate points');
  return points;
}

function rgbToHex(color: [number, number, number]): string {
  return `#${color.map(component => Math.round(component * 255).toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(value: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Color must use #RRGGBB');
  return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function copyFormValue(value: FormValue): FormValue {
  return Array.isArray(value) ? [...value] : value;
}

function formatRect(bounds: Rect): string {
  return `${formatNumber(bounds.x)}, ${formatNumber(bounds.y)} · ${formatNumber(bounds.width)} × ${formatNumber(bounds.height)}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Document tool operation failed';
}
