import { translate as t, useI18n } from './i18n.js';
import React, { useState } from 'react';
import type { EditTransaction } from '@pdf-editor/contracts';

export type FormSuggestionItem = {
  fieldId: string;
  fieldName: string;
  fieldType: 'text' | 'checkbox' | 'radio' | 'choice';
  currentValue: string | boolean | string[];
  suggestedValue: string | boolean | string[];
  required: boolean;
};

export type AiPanelFormProps = {
  items: FormSuggestionItem[];
  explanation: string;
  selectedFieldIds: Set<string>;
  onToggle(fieldId: string): void;
  onSelectAll(): void;
  onDeselectAll(): void;
  onApplySingle(fieldId: string): Promise<void>;
  onApplySelected(): Promise<void>;
  disabled: boolean;
  applying: boolean;
  stale: boolean;
  canFillForms: boolean;
};

export function AiPanelForm({
  items,
  explanation,
  selectedFieldIds,
  onToggle,
  onSelectAll,
  onDeselectAll,
  onApplySingle,
  onApplySelected,
  disabled,
  applying,
  stale,
  canFillForms,
}: AiPanelFormProps) {
  useI18n();
  const count = items.length;
  const selectedItems = items.filter(i => selectedFieldIds.has(i.fieldId));
  const selectedCount = selectedItems.length;
  const canApplyAny = selectedCount > 0 && !disabled && !stale && !applying && canFillForms;

  return (
    <div className="ai-form-suggestions" style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px' }}>
        <strong>{t("Suggested Form Values (")}{selectedCount}/{count} {t("selected)")}</strong>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            onClick={onSelectAll}
            disabled={disabled || applying || count === 0}
            style={{ fontSize: '10px', padding: '3px 7px' }}
          >{t("Select All")}</button>
          <button
            type="button"
            onClick={onDeselectAll}
            disabled={disabled || applying || selectedCount === 0}
            style={{ fontSize: '10px', padding: '3px 7px' }}
          >{t("Clear")}</button>
        </div>
      </div>

      {explanation && (
        <div style={{ fontSize: '10px', color: '#555', background: '#f5f4ef', padding: '6px', borderRadius: '2px' }}>
          {explanation}
        </div>
      )}

      {stale && (
        <div
          role="alert"
          style={{
            padding: '8px',
            background: '#ffe0d8',
            borderLeft: '3px solid #ff623d',
            fontSize: '11px',
            color: '#701905',
          }}
        >{t("Document has changed since suggestions were generated. Please regenerate based on current revision.")}</div>
      )}

      {!canFillForms && (
        <div
          role="alert"
          style={{
            padding: '8px',
            background: '#ffe0d8',
            borderLeft: '3px solid #ff623d',
            fontSize: '11px',
            color: '#701905',
          }}
        >{t("This document does not permit form filling.")}</div>
      )}

      <div style={{ display: 'grid', gap: '8px', maxHeight: '320px', overflowY: 'auto' }}>
        {items.map(item => {
          const isSelected = selectedFieldIds.has(item.fieldId);
          return (
            <div
              key={item.fieldId}
              style={{
                border: isSelected ? '1px solid #7e9019' : '1px solid #c2c1ba',
                borderRadius: '2px',
                padding: '8px',
                background: isSelected ? '#fffdf6' : '#f5f4ef',
                display: 'grid',
                gap: '4px',
                fontSize: '11px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggle(item.fieldId)}
                    disabled={disabled || applying || stale}
                  />
                  <span>{item.fieldName || item.fieldId}</span>
                  <span style={{ fontSize: '9px', color: '#666', fontWeight: 400 }}>({item.fieldType})</span>
                  {item.required && <span style={{ fontSize: '9px', color: '#b3260a' }}>{t("*required")}</span>}
                </label>

                <button
                  type="button"
                  onClick={() => void onApplySingle(item.fieldId)}
                  disabled={disabled || stale || applying || !canFillForms}
                  style={{ fontSize: '9px', padding: '2px 6px' }}
                >{t("Apply Field")}</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '2px' }}>
                <div style={{ background: '#ebe8e1', padding: '4px 6px', borderRadius: '2px' }}>
                  <div style={{ fontSize: '9px', color: '#777' }}>{t("Before:")}</div>
                  <div style={{ wordBreak: 'break-word', color: '#555' }}>
                    {formatDisplayValue(item.currentValue)}
                  </div>
                </div>

                <div style={{ background: '#e3efaa', padding: '4px 6px', borderRadius: '2px' }}>
                  <div style={{ fontSize: '9px', color: '#445b0a', fontWeight: 600 }}>{t("Suggested:")}</div>
                  <div style={{ wordBreak: 'break-word', fontWeight: 600, color: '#20231f' }}>
                    {formatDisplayValue(item.suggestedValue)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="button-primary"
        onClick={() => void onApplySelected()}
        disabled={!canApplyAny}
        style={{ width: '100%', minHeight: '34px', marginTop: '4px' }}
      >
        {applying ? t("Applying form values to PDF…") : `Apply Selected (${selectedCount} fields)`}
      </button>
    </div>
  );
}

export function formatDisplayValue(val: string | boolean | string[] | undefined): string {
  if (val === undefined || val === null || val === '') return '(empty)';
  if (typeof val === 'boolean') return val ? 'Checked' : 'Unchecked';
  if (Array.isArray(val)) return val.length === 0 ? '(none)' : val.join(', ');
  return String(val);
}
