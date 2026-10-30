import { translate as t, useI18n } from './i18n.js';
import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react';
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
} from '@pdf-editor/contracts';
import { useFontResources } from './font-resources.js';
import type { PagePlacementRequest } from './PagePlacementLayer.js';
import { annotationTypeLabels, filterAnnotations, type AnnotationDrawingOptions } from './annotation-drawing.js';
import './annotations.css';
import './panel-refresh.css';

export type DocumentToolsDraftHandle = { finish(): Promise<boolean>; discard(): void };

type Props = {
  draftRef?: RefObject<DocumentToolsDraftHandle | null>;
  onDraftDirtyChange?(dirty: boolean): void;
  mode?: 'comment' | 'forms';
  active?: boolean;
  document: DocumentInfo;
  page: PageModel;
  selectedIds: string[];
  engine: EngineAdapter;
  disabled: boolean;
  drawing?: AnnotationDrawingOptions | null;
  onDrawingChange?(next: AnnotationDrawingOptions | null): void;
  onPlacement?(request: PagePlacementRequest): void;
  onNavigate?(annotation: PdfAnnotationInfo): void;
  selectedCommentId?: string | null;
  onCommentCreated?(pageId: string, annotationId: string): void;
  onBusyChange(busy: boolean): void;
  onCommitted(result: CommitResult): Promise<void>;
};

type FormValue = FormFieldInfo['value'];
type FieldPropertiesDraft = {
  readOnly: boolean;
  required: boolean;
  multiple: boolean;
  tooltip: string;
  maxLen: string;
};

const DEFAULT_FORM_FONT_ID = 'noto-sans-cjk-sc-regular';

export function DocumentToolsPanel({ mode = 'comment', active = true, document, page, selectedIds, engine, disabled, drawing = null, draftRef, onDraftDirtyChange, onDrawingChange, onPlacement, onNavigate, selectedCommentId, onCommentCreated, onBusyChange, onCommitted }: Props) {
  useI18n();
  const [annotationColor, setAnnotationColor] = useState('#fff176');
  const [opacity, setOpacity] = useState('0.7');
  const [strokeWidth, setStrokeWidth] = useState('2');
  const [fieldName, setFieldName] = useState('New field');
  const [fieldType, setFieldType] = useState<'text' | 'checkbox' | 'combo' | 'list' | 'radio'>('text');
  const [fieldOptions, setFieldOptions] = useState('Option A\nOption B');
  const [fieldFontId, setFieldFontId] = useState('');
  const [fieldFontSize, setFieldFontSize] = useState('12');
  const [fieldReadOnly, setFieldReadOnly] = useState(false);
  const [fieldRequired, setFieldRequired] = useState(false);
  const [fieldMultiple, setFieldMultiple] = useState(false);
  const [fieldPropertyDrafts, setFieldPropertyDrafts] = useState<Record<string, FieldPropertiesDraft>>({});
  const [annotations, setAnnotations] = useState<PdfAnnotationInfo[]>([]);
  const [localSelectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const selectedAnnotationId = selectedCommentId === undefined ? localSelectedAnnotationId : selectedCommentId;
  const [annotationPage, setAnnotationPage] = useState('');
  const [annotationType, setAnnotationType] = useState('');
  const [annotationSearch, setAnnotationSearch] = useState('');
  const [fields, setFields] = useState<FormFieldInfo[]>([]);
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, FormValue>>({});
  const [expandedFields, setExpandedFields] = useState<string[]>([]);
  const [dataScope, setDataScope] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const loadSequence = useRef(0);
  const fieldBaseline = useRef<{ documentId: string; fields: FormFieldInfo[] } | null>(null);
  const documentScope = `${document.id}\0${document.revision}`;
  const documentScopeRef = useRef(documentScope); documentScopeRef.current = documentScope;
  const scope = `${documentScope}\0${page.id}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    setSelectedAnnotationId(null); setAnnotationPage(''); setAnnotationType(''); setAnnotationSearch(''); setExpandedFields([]);
  }, [document.id]);
  useEffect(() => {
    if (!drawing) return;
    setAnnotationColor(drawing.color); setOpacity(String(drawing.opacity)); setStrokeWidth(String(drawing.strokeWidth));
  }, [drawing?.color, drawing?.opacity, drawing?.strokeWidth]);

  const { fonts, error: fontError } = useFontResources(engine);
  const chosenFont = fonts.find(font => font.id === fieldFontId)
    ?? fonts.find(font => font.id === DEFAULT_FORM_FONT_ID)
    ?? fonts[0];
  const locked = disabled || busy;
  const supportsAnnotations = document.capabilities.some(capability => capability.startsWith('annotation.'));
  const canAddAnnotation = document.capabilities.includes('annotation.add');
  const canDeleteAnnotation = document.capabilities.includes('annotation.delete');
  const supportsFormCreate = document.capabilities.includes('form.create');
  const supportsFormUpdate = document.capabilities.includes('form.update');
  const supportsFormFill = document.capabilities.includes('form.fill');
  const canReadAnnotations = active && mode === 'comment' && Boolean(engine.describeAnnotations);
  const canReadForms = active && mode === 'forms' && (supportsFormCreate || supportsFormUpdate || supportsFormFill) && Boolean(engine.describeForms);

  useEffect(() => {
    const sequence = ++loadSequence.current;
    const expectedScope = documentScope;
    setLoading(canReadAnnotations || canReadForms);
    setLoadError('');
    setDataScope('');

    const annotationRequest = canReadAnnotations
      ? Promise.allSettled(document.pageOrder.map(pageId => engine.describeAnnotations!(document.id, pageId))).then(pages => {
        const failed = pages.filter(result => result.status === 'rejected');
        if (failed.length && loadSequence.current === sequence) {
          console.warn('Unable to read some page comments', failed);
          setLoadError(t('Comments on {count} pages could not be loaded.', { count: failed.length }));
        }
        return pages.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      }) : Promise.resolve<PdfAnnotationInfo[]>([]);
    const formRequest = canReadForms
      ? engine.describeForms!(document.id)
      : Promise.resolve<FormFieldInfo[]>([]);

    void Promise.all([annotationRequest, formRequest]).then(([nextAnnotations, nextFields]) => {
      if (loadSequence.current !== sequence || documentScopeRef.current !== expectedScope) return;
      setAnnotations(nextAnnotations.filter(annotation => annotation.subtype !== 'link'));
      setFields(nextFields);
      if (canReadForms) {
        const previousFields = fieldBaseline.current?.documentId === document.id ? fieldBaseline.current.fields : [];
        setFieldDrafts(current => mergeFormValueDrafts(previousFields, nextFields, current));
        setFieldPropertyDrafts(current => mergeFormPropertyDrafts(previousFields, nextFields, current));
        fieldBaseline.current = { documentId: document.id, fields: nextFields };
      } else if (fieldBaseline.current?.documentId !== document.id) {
        fieldBaseline.current = null;
        setFieldDrafts({});
        setFieldPropertyDrafts({});
      }
      setDataScope(expectedScope);
    }).catch(caught => {
      if (loadSequence.current === sequence && documentScopeRef.current === expectedScope) {
        setAnnotations([]);
        setFields([]);
        console.warn('Unable to read document tools', caught);
        setLoadError(t(mode === 'forms' ? 'Form fields could not be loaded. Please try again.' : 'Comments could not be loaded. Please try again.'));
      }
    }).finally(() => {
      if (loadSequence.current === sequence && documentScopeRef.current === expectedScope) setLoading(false);
    });

    return () => { loadSequence.current += 1; };
  }, [canReadAnnotations, canReadForms, document.id, documentScope, engine, reload]);

  const currentFields = dataScope === documentScope
    ? fields.filter(field => field.widgets.some(widget => widget.pageId === page.id))
    : [];
  const currentAnnotations = dataScope === documentScope ? annotations : [];
  const filteredAnnotations = filterAnnotations(currentAnnotations, { pageId: annotationPage === 'current' ? page.id : annotationPage,
    subtype: annotationType, text: annotationSearch });

  const draftFields = fieldBaseline.current?.documentId === document.id ? fieldBaseline.current.fields : [];
  const dirty = draftFields.some(field => isFormValueDirty(field, fieldDrafts[field.id])
    || isFormPropertiesDirty(field, fieldPropertyDrafts[field.id]));
  useEffect(() => { onDraftDirtyChange?.(dirty); }, [dirty, onDraftDirtyChange]);
  useEffect(() => () => { onDraftDirtyChange?.(false); }, [onDraftDirtyChange]);
  useImperativeHandle(draftRef, () => ({ finish: finishDrafts, discard: discardDrafts }));

  function discardDrafts(): void {
    setFieldDrafts({}); setFieldPropertyDrafts({}); setError('');
    onDraftDirtyChange?.(false);
  }

  async function finishDrafts(): Promise<boolean> {
    if (!dirty) return true;
    if (locked || loading) {
      setError('Wait for the current operation, then apply the form changes.');
      return false;
    }
    const expectedScope = scope;
    setBusy(true); onBusyChange(true); setError('');
    try {
      if (!engine.describeForms) throw new Error('Form inspection is unavailable in this adapter.');
      const latestFields = await engine.describeForms(document.id);
      if (scopeRef.current !== expectedScope) throw new Error('The document changed while previewing this edit');
      const values = mergeFormValueDrafts(draftFields, latestFields, fieldDrafts);
      const properties = mergeFormPropertyDrafts(draftFields, latestFields, fieldPropertyDrafts);
      const commands = buildFormDraftCommands(latestFields, values, properties);
      if (commands.length) await execute(commands, latestFields);
      discardDrafts();
      return true;
    } catch (caught) {
      setError(formatError(caught));
      return false;
    } finally {
      setBusy(false); onBusyChange(false);
    }
  }

  async function execute(command: EditCommand | EditCommand[], formFields = dataScope === documentScope ? fields : []): Promise<void> {
    const expectedScope = scope;
    const commands = Array.isArray(command) ? command : [command];
    const transaction: EditTransaction = {
      id: crypto.randomUUID(), docId: document.id, baseRevision: document.revision, source: 'manual', commands,
    };
    const targetPageIds = new Set(commands.flatMap(item => 'pageId' in item ? [item.pageId] : []));
    const pages = new Map([[page.id, page]]);
    await Promise.all([...targetPageIds].filter(id => id !== page.id).map(async id => {
      pages.set(id, await engine.describePage(document.id, id));
    }));
    if (scopeRef.current !== expectedScope) throw new Error('The document changed while previewing this edit');
    const context = {
      document, pages, fields: buildFieldContext(formFields),
      annotations: new Map(currentAnnotations.map(annotation => [annotation.id,
        { pageId: annotation.pageId, subtype: annotation.subtype }])),
      fontIds: new Set(commands.flatMap(item => item.type === 'form.create' && item.fontId ? [item.fontId] : [])),
    };
    await engine.previewTransaction(transaction);
    if (scopeRef.current !== expectedScope) throw new Error('The document changed while previewing this edit');
    const result = await new CommandRegistry(engine).execute(transaction, context);
    // Only successfully applied categories are clean; unrelated drafts survive the reload.
    const filled = new Set(commands.flatMap(item => item.type === 'form.fill' ? [item.fieldId] : []));
    const updated = new Set(commands.flatMap(item => item.type === 'form.update' ? [item.fieldId] : []));
    setFieldDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => !filled.has(id))));
    setFieldPropertyDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => !updated.has(id))));
    await onCommitted(result);
    const added = commands.find(command => command.type === 'annotation.add' && command.subtype === 'text');
    if (added?.type === 'annotation.add') onCommentCreated?.(added.pageId, added.annotationId);
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

  function selectAnnotation(annotation: PdfAnnotationInfo): void {
    onDrawingChange?.(null);
    setSelectedAnnotationId(annotation.id);
    onNavigate?.(annotation);
  }

  async function deleteAnnotation(annotation: PdfAnnotationInfo): Promise<void> {
    await execute({ type: 'annotation.delete', pageId: annotation.pageId, annotationId: annotation.id });
    setSelectedAnnotationId(null);
  }

  async function createField(): Promise<void> {
    const name = fieldName.trim();
    if (!name) throw new Error('Field name is required');
    const choice = fieldType === 'combo' || fieldType === 'list';
    const needsFont = fieldType === 'text' || choice;
    if (needsFont && !chosenFont) throw new Error('Choose an available embedded font for the field');
    const options = fieldOptions.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if ((choice || fieldType === 'radio') && !options.length) throw new Error('Enter one option per line');
    onPlacement?.({ documentId: document.id, label: 'Form field', command: (pageId, bounds) => ({
      type: 'form.create',
      pageId,
      fieldId: crypto.randomUUID(),
      name,
      fieldType,
      bounds,
      readOnly: fieldReadOnly,
      required: fieldRequired,
      ...(fieldType === 'list' ? { multiple: fieldMultiple } : {}),
      ...(needsFont ? {
        fontId: chosenFont!.id,
        fontSize: readPositive(fieldFontSize, 'Font size'),
      } : {}),
      ...(choice || fieldType === 'radio' ? { options } : {}),
    }) });
  }

  async function fillField(field: FormFieldInfo): Promise<void> {
    const value = fieldDrafts[field.id] ?? field.value;
    await execute({ type: 'form.fill', fieldId: field.id, value });
  }

  async function updateField(field: FormFieldInfo): Promise<void> {
    const draft = fieldPropertyDrafts[field.id];
    if (draft) await execute(buildFormPropertyCommand(field, draft));
  }

  function startDrawing(tool: AnnotationDrawingOptions['tool']): void {
    if (drawing?.tool === tool) { onDrawingChange?.(null); return; }
    try {
      onDrawingChange?.({ tool, color: annotationColor, opacity: readOpacity(opacity),
        strokeWidth: readPositive(strokeWidth, 'Stroke width'), text: '' });
      setError('');
    } catch (caught) { setError(formatError(caught)); }
  }

  return <section className="text-edit-panel document-tools-panel task-panel" aria-label={t("Annotations and forms")}>
    <header className="task-panel-header"><h2>{t(mode === 'forms' ? 'Forms' : 'Document annotations')}</h2></header>
    <div className="task-panel-body">

    {mode === 'comment' && onDrawingChange ? <div className="annotation-drawing-tools" role="group" aria-label={t('Draw annotations')}>
      <div className="annotation-drawing-tool-buttons">
        {(['text', 'rectangle', 'ink'] as const).map(tool => <button key={tool} type="button"
          aria-pressed={drawing?.tool === tool} disabled={locked || !canAddAnnotation || !document.permissions.annotate}
          onClick={() => startDrawing(tool)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            {tool === 'text' ? <path d="M5 3h14v12l-6 6H5V3Zm8 18v-6h6M8 8h8M8 11h6" />
              : tool === 'rectangle' ? <rect x="4" y="5" width="16" height="14" rx="1" />
                : <path d="M3 17c3-12 4-13 5-6s4 8 5 0 1 12 8-4" />}
          </svg>
          <span>{t(annotationTypeLabels[tool])}</span>
        </button>)}
      </div>
      <p>{drawing ? t(drawing.tool === 'text' ? 'Click on the page to write a note. Esc cancels.'
        : drawing.tool === 'rectangle' ? 'Drag to draw a rectangle. Esc cancels.' : 'Draw on the page. Esc cancels.')
        : t('Choose a tool, then add annotations directly on the page.')}</p>
      {drawing ? <button type="button" onClick={() => onDrawingChange(null)}>{t('Stop drawing')}</button> : null}
    </div> : null}

    {mode === 'comment' ? <details className="annotation-properties"><summary>{t('Drawing properties')}</summary><div className="document-tools-grid">
      <label>{t("Color")}<input type="color" value={annotationColor} disabled={locked || !supportsAnnotations}
        onChange={event => { setAnnotationColor(event.target.value); if (drawing) onDrawingChange?.({ ...drawing, color: event.target.value }); }} /></label>
      <label>{t("Opacity")}<input type="number" min="0" max="1" step="0.05" value={opacity} disabled={locked || !supportsAnnotations}
        onChange={event => {
          const value = event.target.value; setOpacity(value);
          if (drawing && value !== '' && Number(value) >= 0 && Number(value) <= 1) onDrawingChange?.({ ...drawing, opacity: Number(value) });
        }} /></label>
      <label>{t("Stroke width")}<input type="number" min="0.1" step="0.1" value={strokeWidth} disabled={locked || !supportsAnnotations}
        onChange={event => {
          const value = event.target.value; setStrokeWidth(value);
          if (drawing && Number.isFinite(Number(value)) && Number(value) > 0) onDrawingChange?.({ ...drawing, strokeWidth: Number(value) });
        }} /></label>
    </div></details> : null}

    <details className="annotation-reading-list" open hidden={mode !== 'comment'}>
      <summary>{t("Document annotations")}</summary>
      {!supportsAnnotations ? <p role="status">{t("The current PDF core does not advertise annotation editing.")}</p> : null}
      <>
        {!engine.describeAnnotations ? <p role="alert">{t("Annotation inspection is unavailable in this adapter.")}</p> : null}
        <div className="annotation-list-filters">
          <label>{t('Pages')}<select value={annotationPage} onChange={event => setAnnotationPage(event.target.value)}>
            <option value="">{t('All pages')}</option><option value="current">{t('Current page')}</option>
            {document.pageOrder.map((pageId, index) => <option key={pageId} value={pageId}>{t('Page {page}', { page: index + 1 })}</option>)}
          </select></label>
          <label>{t('Annotation type')}<select value={annotationType} onChange={event => setAnnotationType(event.target.value)}>
            <option value="">{t('All types')}</option>
            {Object.entries(annotationTypeLabels).filter(([type]) => type !== 'link').map(([type, label]) => <option key={type} value={type}>{t(label)}</option>)}
          </select></label>
          <label>{t('Find annotation text')}<input type="search" value={annotationSearch} placeholder={t('Search notes…')}
            onChange={event => setAnnotationSearch(event.target.value)} /></label>
        </div>
        {loading ? <p className="annotation-list-status" role="status">{t("Loading document annotations…")}</p> : null}
        {!loading && !loadError && canReadAnnotations ? <p className="annotation-list-status" role="status">
          {currentAnnotations.length === 0 ? t('No annotations in this document yet.')
            : filteredAnnotations.length === 0 ? t('No annotations match these filters.')
              : t('{shown} of {total} annotations', { shown: filteredAnnotations.length, total: currentAnnotations.length })}
        </p> : null}
        {filteredAnnotations.length > 0 ? <ul className="document-tools-list annotation-document-list" aria-label={t('Document annotations')}>
          {filteredAnnotations.map(annotation => <li key={annotation.id} data-selected={selectedAnnotationId === annotation.id}>
            <button type="button" className="annotation-list-item" disabled={locked}
              aria-pressed={selectedAnnotationId === annotation.id} onClick={() => selectAnnotation(annotation)}
              aria-label={t('Go to {type} on page {page}', { type: t(annotationTypeLabels[annotation.subtype]), page: document.pageOrder.indexOf(annotation.pageId) + 1 })}>
              <span className="annotation-list-item-heading"><strong><i className="annotation-list-swatch" aria-hidden="true" style={{ background: rgbToHex(annotation.color) }} />{t(annotationTypeLabels[annotation.subtype])}</strong>
                <span>{t('Page {page}', { page: document.pageOrder.indexOf(annotation.pageId) + 1 })}</span></span>
              <span className="annotation-list-item-text">{annotation.text || t('No comment text')}</span>
              <span className="annotation-list-item-meta">{Math.round(annotation.opacity * 100)}%</span>
            </button>
            {annotation.subtype === 'link' || annotation.subtype === 'other' ? (
              <span className="document-tools-readonly">{t(annotation.subtype === 'link' ? 'Link (read-only)' : 'Unsupported (read-only)')}</span>
            ) : null}
            {canDeleteAnnotation && <div className="annotation-list-actions"><button type="button" disabled={locked || !document.permissions.annotate}
              aria-label={t('Delete {type} annotation', { type: t(annotationTypeLabels[annotation.subtype]) })} onClick={() => {
                if (window.confirm(t("Delete this annotation? You can undo this change.")))
                  void run(() => deleteAnnotation(annotation));
              }}>{t("Delete")}</button></div>}
          </li>)}
        </ul> : null}
        {!document.permissions.annotate ? <p role="alert">{t("This document does not permit annotations.")}</p> : null}
      </>
    </details>

    <details open hidden={mode !== 'forms'}>
      <summary>{t("Forms on this page")}</summary>
      {!supportsFormCreate && !supportsFormUpdate && !supportsFormFill ? <p role="status">{t("The current PDF core does not advertise form editing.")}</p> : <>
        {!engine.describeForms ? <p role="alert">{t("Form inspection is unavailable in this adapter.")}</p> : null}
        {loading ? <p role="status">{t("Loading fields…")}</p> : null}
        {!loading && canReadForms && currentFields.length === 0 ? <p>{t("No form fields on this page.")}</p> : null}
        {currentFields.length > 0 ? <div className="document-fields-list">
          {currentFields.map(field => {
            const draft = fieldDrafts[field.id] ?? field.value;
            const properties = fieldPropertyDrafts[field.id] ?? {
              readOnly: field.readOnly,
              required: field.required,
              multiple: field.multiple ?? false,
              tooltip: field.tooltip ?? '',
              maxLen: field.maxLen !== undefined && field.maxLen > 0 ? String(field.maxLen) : '',
            };
            const propertiesChanged = isFormPropertiesDirty(field, properties);
            return <div className="document-field" key={field.id}>
              <div className="document-field-heading">
                <strong>{field.name}</strong>
                <span>{field.choiceKind ?? field.type}{field.required ? ' · required' : ''}{field.readOnly ? ' · read-only' : ''}{field.multiple ? ' · multi-select' : ''}{field.maxLen ? ` · max: ${field.maxLen}` : ''}</span>
              </div>
              {fieldEditor(field, draft, locked || field.readOnly || !supportsFormFill, value => {
                setFieldDrafts(current => ({ ...current, [field.id]: value }));
              })}
              <button type="button" disabled={locked || field.readOnly || !supportsFormFill || !document.permissions.fillForms}
                onClick={() => void run(() => fillField(field))}>{t("Apply value")}</button>
              {supportsFormUpdate && <details open={expandedFields.includes(field.id)} onToggle={event => {
                const open = event.currentTarget.open;
                setExpandedFields(previous => previous.includes(field.id) === open ? previous : open ? [...previous, field.id] : previous.filter(id => id !== field.id));
              }}><summary>{t('Field properties')}</summary><div role="group" aria-label={t('Properties for {name}', { name: field.name })}>
                <label><input type="checkbox" checked={properties.readOnly} disabled={locked || !document.permissions.modify}
                  onChange={event => setFieldPropertyDrafts(current => ({ ...current,
                    [field.id]: { ...properties, readOnly: event.target.checked } }))} />{t("Read-only")}</label>
                <label><input type="checkbox" checked={properties.required} disabled={locked || !document.permissions.modify}
                  onChange={event => setFieldPropertyDrafts(current => ({ ...current,
                    [field.id]: { ...properties, required: event.target.checked } }))} />{t("Required")}</label>
                {field.choiceKind === 'list' && <label><input type="checkbox" checked={properties.multiple}
                  disabled={locked || !document.permissions.modify}
                  onChange={event => setFieldPropertyDrafts(current => ({ ...current,
                    [field.id]: { ...properties, multiple: event.target.checked } }))} />{t("Multiple selections")}</label>}
                <label>{t("Tooltip")}<input type="text" value={properties.tooltip} placeholder={t("No tooltip")}
                  disabled={locked || !document.permissions.modify}
                  onChange={event => setFieldPropertyDrafts(current => ({ ...current,
                    [field.id]: { ...properties, tooltip: event.target.value } }))} /></label>
                {field.type === 'text' && <label>{t("Max length")}<input type="number" min="0" step="1"
                  value={properties.maxLen} placeholder={t("No limit")}
                  disabled={locked || !document.permissions.modify}
                  onChange={event => setFieldPropertyDrafts(current => ({ ...current,
                    [field.id]: { ...properties, maxLen: event.target.value } }))} /></label>}
                <button type="button" disabled={locked || !document.permissions.modify || !propertiesChanged}
                  onClick={() => void run(() => updateField(field))}>{t("Apply field properties")}</button>
              </div></details>}
            </div>;
          })}
        </div> : null}
        {supportsFormFill && !document.permissions.fillForms ? <p role="alert">{t("This document does not permit form filling.")}</p> : null}

        {supportsFormCreate && onPlacement ? <details><summary>{t('Create a field')}</summary><fieldset disabled={locked || !document.permissions.modify}>
          <legend>{t("Create a field")}</legend>
          <label>{t("Field name")}<input value={fieldName} onChange={event => setFieldName(event.target.value)} /></label>
          <label>{t("Field type")}<select value={fieldType} onChange={event => setFieldType(event.target.value as typeof fieldType)}>
            <option value="text">{t("Text")}</option><option value="checkbox">{t("Checkbox")}</option>
            <option value="combo">{t("Dropdown choice")}</option><option value="list">{t("List choice")}</option>
            <option value="radio">{t("Radio group")}</option>
          </select></label>
          {(fieldType === 'combo' || fieldType === 'list' || fieldType === 'radio') && <label>{t("Options (one per line)")}<textarea rows={4} value={fieldOptions} onChange={event => setFieldOptions(event.target.value)} />
          </label>}
          {fieldType === 'text' || fieldType === 'combo' || fieldType === 'list' ? <>
            <label>{t("Field font")}<select value={chosenFont?.id ?? ''} onChange={event => setFieldFontId(event.target.value)}>
              {fonts.map(font => <option key={font.id} value={font.id}>{font.family} · {font.style}</option>)}
            </select></label>
            <label>{t("Font size")}<input type="number" min="0.1" max="1000" step="0.1" value={fieldFontSize}
              onChange={event => setFieldFontSize(event.target.value)} /></label>
            {fontError ? <p role="alert">{t(fontError)}</p> : null}
          </> : null}
          <label><input type="checkbox" checked={fieldReadOnly} onChange={event => setFieldReadOnly(event.target.checked)} />{t("Read-only field")}</label>
          <label><input type="checkbox" checked={fieldRequired} onChange={event => setFieldRequired(event.target.checked)} />{t("Required field")}</label>
          {fieldType === 'list' && <label><input type="checkbox" checked={fieldMultiple}
            onChange={event => setFieldMultiple(event.target.checked)} />{t("Allow multiple selections")}</label>}
          <button type="button" disabled={dirty || (fieldType !== 'checkbox' && fieldType !== 'radio' && !chosenFont)} onClick={() => void run(createField)}>{t('Draw field on page')}</button>
        </fieldset></details> : null}
        {supportsFormCreate && !document.permissions.modify ? <p role="alert">{t("This document does not permit creating fields.")}</p> : null}
      </>}
    </details>

    {loadError ? <div className="task-error" role="alert"><p>{loadError}</p><button type="button" disabled={loading} onClick={() => setReload(value => value + 1)}>{t('Try again')}</button></div> : null}
    </div>
    <footer className="task-panel-footer">
      {error ? <p role="alert">{t(error)}</p> : null}
      {mode === 'forms' || dirty ? <>
        <p role="status">{t(dirty ? 'Form changes are not applied yet.' : 'All form changes are applied.')}</p>
        <div className="text-edit-actions">
          <button type="button" className="task-panel-primary" disabled={locked || loading || !dirty}
            onClick={() => void finishDrafts()}>{t('Apply all form changes')}</button>
          <button type="button" disabled={locked || !dirty} onClick={discardDrafts}>{t('Discard draft')}</button>
        </div>
      </> : <p role="status">{t(drawing ? 'Drawing tool active. Esc cancels.' : 'Select an annotation or choose a drawing tool.')}</p>}
    </footer>
  </section>;
}

function fieldEditor(field: FormFieldInfo, value: FormValue, disabled: boolean, onChange: (value: FormValue) => void) {
  if (field.type === 'checkbox') {
    return <label className="document-checkbox"><input type="checkbox" checked={typeof value === 'boolean' ? value : false}
      disabled={disabled} onChange={event => onChange(event.target.checked)} />{t("Checked")}</label>;
  }
  if (field.type === 'radio') {
    return <label>{t("Value")}<select value={typeof value === 'string' ? value : ''} disabled={disabled}
      onChange={event => onChange(event.target.value)}>
      {!field.required ? <option value="">{t("None")}</option> : null}
      {field.options.map(option => <option key={option} value={option}>{option}</option>)}
    </select></label>;
  }
  if (field.type === 'choice') {
    const multiple = field.multiple ?? Array.isArray(value);
    return <label>{t("Value")}<select multiple={multiple} value={multiple ? Array.isArray(value) ? value : [] : typeof value === 'string' ? value : ''} disabled={disabled}
      onChange={event => onChange(multiple
        ? Array.from(event.currentTarget.selectedOptions, option => option.value)
        : event.currentTarget.value)}>
      {!multiple && !field.required ? <option value="">{t("None")}</option> : null}
      {field.options.map(option => <option key={option} value={option}>{option}</option>)}
    </select></label>;
  }
  return <label>{t("Value")}<input type="text" value={typeof value === 'string' ? value : ''} disabled={disabled}
    onChange={event => onChange(event.target.value)} /></label>;
}

function buildFieldContext(fields: FormFieldInfo[]) {
  return new Map(fields.flatMap(field => field.widgets[0]
    ? [[field.id, {
      pageId: field.widgets[0].pageId,
      type: field.type,
      options: field.options,
      readOnly: field.readOnly,
      ...(field.choiceKind ? { choiceKind: field.choiceKind } : {}),
      ...(field.multiple !== undefined ? { multiple: field.multiple } : {}),
      value: field.value,
      ...(field.maxLen !== undefined ? { maxLen: field.maxLen } : {}),
      ...(field.tooltip !== undefined ? { tooltip: field.tooltip } : {}),
    }] as const]
    : []));
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

function rgbToHex(color: [number, number, number]): string {
  return `#${color.map(component => Math.round(component * 255).toString(16).padStart(2, '0')).join('')}`;
}

function fieldProperties(field: FormFieldInfo): FieldPropertiesDraft {
  return {
    readOnly: field.readOnly,
    required: field.required,
    multiple: field.multiple ?? false,
    tooltip: field.tooltip ?? '',
    maxLen: field.maxLen !== undefined && field.maxLen > 0 ? String(field.maxLen) : '',
  };
}

export function isFormValueDirty(field: FormFieldInfo, draft: FormValue | undefined): boolean {
  if (draft === undefined) return false;
  const original = field.value;
  return Array.isArray(draft) && Array.isArray(original)
    ? draft.length !== original.length || draft.some((value, index) => value !== original[index])
    : draft !== original;
}

export function isFormPropertiesDirty(field: FormFieldInfo, draft: FieldPropertiesDraft | undefined): boolean {
  if (!draft) return false;
  return draft.readOnly !== field.readOnly || draft.required !== field.required
    || (field.choiceKind === 'list' && draft.multiple !== (field.multiple ?? false))
    || draft.tooltip.trim() !== (field.tooltip ?? '')
    || (field.type === 'text' && (draft.maxLen.trim() === '' ? 0 : Number(draft.maxLen)) !== (field.maxLen ?? 0));
}

function buildFormPropertyCommand(field: FormFieldInfo, draft: FieldPropertiesDraft): Extract<EditCommand, { type: 'form.update' }> {
  const tooltip = draft.tooltip.trim();
  const maxLen = draft.maxLen.trim() === '' ? 0 : Number(draft.maxLen);
  if (field.type === 'text' && (!Number.isSafeInteger(maxLen) || maxLen < 0)) {
    throw new Error('Maximum length must be a non-negative integer');
  }
  return {
    type: 'form.update', fieldId: field.id, readOnly: draft.readOnly, required: draft.required,
    ...(field.choiceKind === 'list' ? { multiple: draft.multiple } : {}),
    ...(tooltip !== (field.tooltip ?? '') ? { tooltip: tooltip || null } : {}),
    ...(field.type === 'text' && maxLen !== (field.maxLen ?? 0) ? { maxLen: maxLen || null } : {}),
  };
}

export function buildFormDraftCommands(fields: FormFieldInfo[], values: Record<string, FormValue>, properties: Record<string, FieldPropertiesDraft>): EditCommand[] {
  return fields.flatMap(field => {
    const fill: EditCommand[] = isFormValueDirty(field, values[field.id])
      ? [{ type: 'form.fill', fieldId: field.id, value: values[field.id]! }] : [];
    const update = isFormPropertiesDirty(field, properties[field.id]) ? buildFormPropertyCommand(field, properties[field.id]!) : null;
    // Fill before locking or shortening a field; unlock/expand first when the new value needs it.
    const value = values[field.id];
    const updateFirst = update && ((field.readOnly && update.readOnly === false)
      || (Array.isArray(value) && value.length > 1 && !field.multiple && update.multiple === true)
      || (typeof value === 'string' && field.maxLen && value.length > field.maxLen
        && update.maxLen !== undefined && (update.maxLen === null || update.maxLen >= value.length)));
    return update ? updateFirst ? [update, ...fill] : [...fill, update] : fill;
  });
}

export function mergeFormValueDrafts(previous: FormFieldInfo[], next: FormFieldInfo[], drafts: Record<string, FormValue>): Record<string, FormValue> {
  const baseline = new Map(previous.map(field => [field.id, field]));
  return Object.fromEntries(next.map(field => {
    const before = baseline.get(field.id), draft = drafts[field.id], original = before?.value;
    const unchanged = Array.isArray(draft) && Array.isArray(original)
      ? draft.length === original.length && draft.every((value, index) => value === original[index])
      : draft === original;
    return [field.id, copyFormValue(before && draft !== undefined && !unchanged ? draft : field.value)];
  }));
}

export function mergeFormPropertyDrafts(previous: FormFieldInfo[], next: FormFieldInfo[], drafts: Record<string, FieldPropertiesDraft>): Record<string, FieldPropertiesDraft> {
  const baseline = new Map(previous.map(field => [field.id, field]));
  return Object.fromEntries(next.map(field => {
    const before = baseline.get(field.id), draft = drafts[field.id], properties = fieldProperties(field);
    if (!before || !draft) return [field.id, properties];
    const original = fieldProperties(before);
    return [field.id, Object.fromEntries((Object.keys(properties) as (keyof FieldPropertiesDraft)[])
      .map(key => [key, draft[key] !== original[key] ? draft[key] : properties[key]])) as FieldPropertiesDraft];
  }));
}

function copyFormValue(value: FormValue): FormValue {
  return Array.isArray(value) ? [...value] : value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Document tool operation failed';
}
