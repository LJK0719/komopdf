import { describe, expect, it } from 'vitest';
import type { FormFieldInfo } from '@pdf-editor/contracts';
import { mergeFormPropertyDrafts, mergeFormValueDrafts } from '../src/ui/DocumentToolsPanel.js';

const field: FormFieldInfo = {
  id: 'field-1', name: 'Account', type: 'text', value: 'Original', readOnly: false, required: false,
  options: [], widgets: [{ pageId: 'page-1', bounds: { x: 36, y: 36, width: 180, height: 32 } }],
};
const properties = { readOnly: false, required: false, multiple: false, tooltip: '', maxLen: '' };

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
