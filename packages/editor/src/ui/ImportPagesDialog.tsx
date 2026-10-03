import { useId, useState } from 'react';
import { AppDialog } from './AppDialog.js';
import { useI18n } from './i18n.js';
import { parsePageIndices } from './page-import-utils.js';
import './page-import.css';

export type ImportPagesSource = {
  docId: string; resourceId: string; name: string; pageCount: number; afterPageId: string | null;
};
export type ImportPagesDialogProps = {
  source: ImportPagesSource | null; pageOrder: string[]; disabled: boolean; pageLimit?: number | undefined;
  onClose(): void; onImport(range: string, afterPageId: string | null): Promise<boolean>;
};

export function ImportPagesDialog(props: ImportPagesDialogProps) {
  return props.source ? <ImportPagesForm key={props.source.resourceId} {...props} source={props.source} /> : null;
}

function ImportPagesForm({ source, pageOrder, disabled, pageLimit, onClose, onImport }: ImportPagesDialogProps & { source: ImportPagesSource }) {
  const { t } = useI18n();
  const id = useId();
  const [range, setRange] = useState('all');
  const [afterPageId, setAfterPageId] = useState(source.afterPageId ?? '');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const locked = disabled || busy;
  let count = 0, rangeError = '';
  try { count = parsePageIndices(range, source.pageCount).length; }
  catch (error) { rangeError = error instanceof Error ? error.message : String(error); }
  const limitError = pageLimit !== undefined && pageOrder.length + count > pageLimit;
  const insertionError = afterPageId !== '' && !pageOrder.includes(afterPageId);
  const valid = !rangeError && !limitError && !insertionError && count > 0;
  async function submit() {
    if (locked || !valid) return;
    setBusy(true); setSubmitError('');
    try {
      if (!await onImport(range, afterPageId || null)) setSubmitError('Pages could not be imported. Check the document and try again.');
    } catch (error) { setSubmitError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <AppDialog open onOpenChange={open => { if (!open && !locked) onClose(); }} title={t('Import PDF pages')}>
    <form className="page-import-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="page-import-source"><span>{t('Source PDF')}</span><strong>{source.name}</strong>
        <span>{t('{count} source pages', { count: source.pageCount })}</span></div>
      <label htmlFor={`${id}-range`}>{t('Source pages to import')}</label>
      <input id={`${id}-range`} autoFocus value={range} disabled={locked} placeholder={t('all, or 1-3,5')}
        aria-invalid={Boolean(rangeError || limitError)} aria-describedby={`${id}-range-help ${id}-range-error`}
        onChange={event => { setRange(event.target.value); setSubmitError(''); }} />
      <p id={`${id}-range-help`} className="page-import-help">{t('Use source PDF page numbers. Pages are imported once, in source order.')}</p>
      <p id={`${id}-range-error`} className="page-import-error" role={rangeError || limitError ? 'alert' : undefined}>
        {rangeError ? t(rangeError) : limitError ? t('This PDF would have {count} pages. The limit is {limit}.', { count: pageOrder.length + count, limit: pageLimit! }) : null}
      </p>
      <label htmlFor={`${id}-position`}>{t('Insert position')}</label>
      <select id={`${id}-position`} value={afterPageId} disabled={locked} aria-invalid={insertionError}
        onChange={event => { setAfterPageId(event.target.value); setSubmitError(''); }}>
        <option value="">{t('At the beginning')}</option>
        {pageOrder.map((pageId, index) => <option key={pageId} value={pageId}>{index === pageOrder.length - 1
          ? t('At the end (after page {page})', { page: index + 1 }) : t('After page {page}', { page: index + 1 })}</option>)}
      </select>
      {insertionError && <p className="page-import-error" role="alert">{t('Choose an existing insertion page')}</p>}
      <p className="page-import-summary" aria-live="polite">{!rangeError && t('{count} pages selected · Result: {total} pages', { count, total: pageOrder.length + count })}</p>
      {submitError && <p className="page-import-error" role="alert">{t(submitError)}</p>}
      <div className="page-import-actions"><button type="button" disabled={locked} onClick={onClose}>{t('Cancel')}</button>
        <button className="page-import-confirm" type="submit" disabled={locked || !valid}>{busy ? t('Importing pages…') : t('Import {count} pages', { count })}</button></div>
    </form>
  </AppDialog>;
}
