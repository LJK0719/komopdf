import { describe, expect, it } from 'vitest';
import type { FormFieldInfo } from '@pdf-editor/contracts';
import { buildFormDraftCommands, isFormPropertiesDirty, isFormValueDirty, mergeFormPropertyDrafts, mergeFormValueDrafts } from '../src/ui/DocumentToolsPanel.js';
import { validateTransaction } from '@pdf-editor/commands';
import type { DocumentInfo, PageModel } from '@pdf-editor/contracts';

const field: FormFieldInfo = {
  id: 'field-1', name: 'Account', type: 'text', value: 'Original', readOnly: false, required: false,
  options: [], widgets: [{ pageId: 'page-1', bounds: { x: 36, y: 36, width: 180, height: 32 } }],
};
const properties = { readOnly: false, required: false, multiple: false, tooltip: '', maxLen: '' };

describe('form draft completion', () => {
  it('ignores clean defaults and compares checkbox and multi-select values by value', () => {
    expect(isFormValueDirty(field, undefined)).toBe(false);
    expect(isFormValueDirty({ ...field, value: ['A', 'B'] }, ['A', 'B'])).toBe(false);
    expect(isFormValueDirty({ ...field, value: false }, true)).toBe(true);
    expect(isFormPropertiesDirty(field, properties)).toBe(false);
    expect(isFormPropertiesDirty(field, { ...properties, maxLen: '0' })).toBe(false);
    expect(isFormPropertiesDirty(field, { ...properties, maxLen: 'invalid' })).toBe(true);
    expect(buildFormDraftCommands([field], { [field.id]: field.value }, { [field.id]: properties })).toEqual([]);
  });

  it('collects dirty values and properties across pages, filling before locking a field', () => {
    const second = { ...field, id: 'field-2', value: false, type: 'checkbox' as const,
      widgets: [{ ...field.widgets[0]!, pageId: 'page-2' }] };
    expect(buildFormDraftCommands([field, second], { [field.id]: 'Changed', [second.id]: true },
      { [field.id]: { ...properties, readOnly: true, tooltip: ' Account code ' } })).toEqual([
      { type: 'form.fill', fieldId: field.id, value: 'Changed' },
      { type: 'form.update', fieldId: field.id, readOnly: true, required: false, tooltip: 'Account code' },
      { type: 'form.fill', fieldId: second.id, value: true },
    ]);
  });

  it('unlocks or expands fields before applying values that need the new properties', () => {
    expect(buildFormDraftCommands([{ ...field, readOnly: true }], { [field.id]: 'Changed' },
      { [field.id]: properties }).map(command => command.type)).toEqual(['form.update', 'form.fill']);
    expect(buildFormDraftCommands([{ ...field, maxLen: 2 }], { [field.id]: 'Changed' },
      { [field.id]: { ...properties, maxLen: '20' } }).map(command => command.type)).toEqual(['form.update', 'form.fill']);
  });

  it('rejects invalid property drafts without mutating values or the baseline', () => {
    const values = { [field.id]: 'Changed' }, invalid = { ...properties, maxLen: '-1' };
    expect(() => buildFormDraftCommands([field], values, { [field.id]: invalid })).toThrow('non-negative integer');
    expect(field.value).toBe('Original');
    expect(values[field.id]).toBe('Changed');
    expect(invalid.maxLen).toBe('-1');
  });

  it('validates the whole form batch before any value can be committed', () => {
    const commands = buildFormDraftCommands([field], { [field.id]: 'Too long' }, { [field.id]: { ...properties, maxLen: '2' } });
    const document: DocumentInfo = { id: 'doc-1', revision: 1, savedRevision: 1, pageOrder: ['page-1'], sourceIds: [],
      permissions: { modify: true, fillForms: true, copy: true, annotate: true, encrypted: false, signed: false },
      capabilities: ['form.fill', 'form.update'] };
    const page: PageModel = { id: 'page-1', widthPt: 612, heightPt: 792, rotation: 0, objects: [] };
    expect(() => validateTransaction({ id: 'tx-1', docId: document.id, baseRevision: 1, source: 'manual', commands }, {
      document, pages: new Map([[page.id, page]]),
      fields: new Map([[field.id, { pageId: page.id, type: field.type, value: field.value, readOnly: false }]]),
    })).toThrow('maximum length');
    expect(field.value).toBe('Original');
  });
});

describe('form draft reloads', () => {
  it('preserves an edited value when applying field properties', () => {
    const next = { ...field, tooltip: 'Account code' };
    expect(mergeFormValueDrafts([field], [next], { [field.id]: 'Pending value' }))
      .toEqual({ [field.id]: 'Pending value' });
  });

  it('preserves edited properties when applying a value, while updating untouched properties', () => {
    const next = { ...field, value: 'Applied', required: true, maxLen: 8 };
    expect(mergeFormPropertyDrafts([field], [next], { [field.id]: { ...properties, tooltip: 'Pending tooltip' } }))
      .toEqual({ [field.id]: { ...properties, tooltip: 'Pending tooltip', required: true, maxLen: '8' } });
  });

  it('reloads clean values and properties after undo or an external edit', () => {
    const next = { ...field, value: 'Undone', tooltip: 'Previous tooltip', readOnly: true };
    expect(mergeFormValueDrafts([field], [next], { [field.id]: 'Original' })).toEqual({ [field.id]: 'Undone' });
    expect(mergeFormPropertyDrafts([field], [next], { [field.id]: properties }))
      .toEqual({ [field.id]: { ...properties, tooltip: 'Previous tooltip', readOnly: true } });
  });

  it('compares choice arrays by value and preserves dirty checkbox and multi-select drafts', () => {
    const choices = { ...field, type: 'choice' as const, value: ['A'] };
    const changed = { ...choices, value: ['B'] };
    const clean = mergeFormValueDrafts([choices], [changed], { [field.id]: ['A'] });
    expect(clean).toEqual({ [field.id]: ['B'] });
    expect(clean[field.id]).not.toBe(changed.value);
    expect(mergeFormValueDrafts([choices], [changed], { [field.id]: ['C', 'A'] }))
      .toEqual({ [field.id]: ['C', 'A'] });
    expect(mergeFormValueDrafts([{ ...field, value: false }], [{ ...field, value: false }], { [field.id]: true }))
      .toEqual({ [field.id]: true });
  });

  it('drops deleted fields and initializes new fields without reusing unrelated drafts', () => {
    const next = { ...field, id: 'new-field', value: 'New value', tooltip: 'New tooltip' };
    expect(mergeFormValueDrafts([field], [next], { [field.id]: 'Deleted draft', [next.id]: 'Stale value' }))
      .toEqual({ [next.id]: 'New value' });
    expect(mergeFormPropertyDrafts([field], [next], { [field.id]: properties, [next.id]: properties }))
      .toEqual({ [next.id]: { ...properties, tooltip: 'New tooltip' } });
  });

  it('takes engine-normalized values for the applied category without clearing the other category', () => {
    const next = { ...field, value: 'Applied', tooltip: 'Trimmed tooltip', maxLen: 6 };
    // A successful apply removes only its own category before this reload.
    expect(mergeFormValueDrafts([field], [next], {})).toEqual({ [field.id]: 'Applied' });
    expect(mergeFormPropertyDrafts([field], [next], {}))
      .toEqual({ [field.id]: { ...properties, tooltip: 'Trimmed tooltip', maxLen: '6' } });
    expect(mergeFormPropertyDrafts([field], [next], { [field.id]: { ...properties, tooltip: 'Still pending' } }))
      .toEqual({ [field.id]: { ...properties, tooltip: 'Still pending', maxLen: '6' } });
  });

  it('uses the refreshed baseline so a later undo does not resurrect a committed draft', () => {
    const committed = { ...field, value: 'Applied', tooltip: 'Applied tooltip' };
    const values = mergeFormValueDrafts([field], [committed], {});
    const propertyDrafts = mergeFormPropertyDrafts([field], [committed], {});
    expect(mergeFormValueDrafts([committed], [field], values)).toEqual({ [field.id]: 'Original' });
    expect(mergeFormPropertyDrafts([committed], [field], propertyDrafts)).toEqual({ [field.id]: properties });
  });
});
