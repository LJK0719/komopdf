import React from 'react';
import type { TextReplacement } from '@pdf-editor/contracts';
import type { EvidenceSnapshot } from '@pdf-editor/ai-client';
import { AiPanelDiff } from './AiPanelDiff.js';

export type CandidateItem = TextReplacement & {
  layoutState?: 'none' | 'checking' | 'fits' | 'overflow' | 'unavailable';
};

export type AiPanelCandidatesProps = {
  replacements: CandidateItem[];
  snapshot: EvidenceSnapshot | null;
  selectedEvidenceIds: Set<string>;
  onToggle(evidenceId: string): void;
  onSelectAll(): void;
  onDeselectAll(): void;
  onApplySingle(evidenceId: string): Promise<void>;
  onApplySelected(): Promise<void>;
  disabled: boolean;
  applying: boolean;
  stale: boolean;
  fontId?: string;
  hasReplaceCapability: boolean;
};

export function AiPanelCandidates({
  replacements,
  snapshot,
  selectedEvidenceIds,
  onToggle,
  onSelectAll,
  onDeselectAll,
  onApplySingle,
  onApplySelected,
  disabled,
  applying,
  stale,
  fontId,
  hasReplaceCapability,
}: AiPanelCandidatesProps) {
  const count = replacements.length;
  const selectedCandidates = replacements.filter(r => selectedEvidenceIds.has(r.targetEvidenceId));
  const selectedCount = selectedCandidates.length;

  // 严格要求所有已选候选必须通过真实排版测量且无溢出
  const anyChecking = selectedCandidates.some(r => r.layoutState === 'checking');
  const anyOverflow = selectedCandidates.some(r => r.layoutState === 'overflow');
  const anyUnavailable = selectedCandidates.some(r => r.layoutState === 'unavailable' || r.layoutState === 'none');
  const allSelectedFit = selectedCount > 0 && selectedCandidates.every(r => r.layoutState === 'fits');
  const canApplyAny = allSelectedFit && !disabled && !stale && !applying && hasReplaceCapability;

  let applyButtonLabel = `Apply Selected (${selectedCount} items)`;
  if (applying) {
    applyButtonLabel = 'Applying to PDF…';
  } else if (anyChecking) {
    applyButtonLabel = 'Verifying layout for selected items…';
  } else if (anyOverflow) {
    applyButtonLabel = 'Cannot apply: selected text overflows text box';
  } else if (anyUnavailable) {
    applyButtonLabel = 'Layout unverified for some items';
  }

  return (
    <div className="ai-candidates-list" style={{ display: 'grid', gap: '10px', marginTop: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px' }}>
        <strong>
          Proposed Candidates ({selectedCount}/{count} selected)
        </strong>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            onClick={onSelectAll}
            disabled={disabled || applying || count === 0}
            style={{ fontSize: '10px', padding: '3px 7px' }}
          >
            Select All
          </button>
          <button
            type="button"
            onClick={onDeselectAll}
            disabled={disabled || applying || selectedCount === 0}
            style={{ fontSize: '10px', padding: '3px 7px' }}
          >
            Clear
          </button>
        </div>
      </div>

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
        >
          Document has changed since candidates were generated. Older candidates are read-only; please regenerate based on current revision.
        </div>
      )}

      <div style={{ display: 'grid', gap: '8px', maxHeight: '340px', overflowY: 'auto' }}>
        {replacements.map((item, index) => {
          const evidence = snapshot?.get(item.targetEvidenceId);
          const originalText = evidence?.evidence.text ?? '';
          const pageNumber = evidence?.evidence.pageNumber ?? '?';
          const isSelected = selectedEvidenceIds.has(item.targetEvidenceId);
          const layout = item.layoutState ?? 'none';
          const isSingleFits = layout === 'fits';

          return (
            <div
              key={item.targetEvidenceId || index}
              style={{
                border: isSelected ? '1px solid #7e9019' : '1px solid #c2c1ba',
                borderRadius: '2px',
                padding: '10px',
                background: isSelected ? '#fffdf6' : '#f5f4ef',
                display: 'grid',
                gap: '6px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontWeight: 600,
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggle(item.targetEvidenceId)}
                    disabled={disabled || applying || stale}
                  />
                  <span>Page {pageNumber} · Block {item.targetEvidenceId}</span>
                </label>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {layout === 'fits' && (
                    <span style={{ fontSize: '9px', color: '#445b0a', fontWeight: 600 }}>
                      ✓ Fits
                    </span>
                  )}
                  {layout === 'overflow' && (
                    <span style={{ fontSize: '9px', color: '#b3260a', fontWeight: 600 }}>
                      ⚠ Overflows
                    </span>
                  )}
                  {layout === 'checking' && (
                    <span style={{ fontSize: '9px', color: '#666' }}>Measuring…</span>
                  )}

                  <button
                    type="button"
                    onClick={() => void onApplySingle(item.targetEvidenceId)}
                    disabled={disabled || stale || applying || !hasReplaceCapability || !isSingleFits}
                    style={{ fontSize: '10px', padding: '3px 8px' }}
                    title={!isSingleFits ? 'Candidate must fit in text box before applying' : undefined}
                  >
                    Apply Item
                  </button>
                </div>
              </div>

              {item.reason && (
                <div style={{ fontSize: '10px', color: '#666', fontStyle: 'italic' }}>
                  Reason: {item.reason}
                </div>
              )}

              <AiPanelDiff original={originalText} suggested={item.text} />

              {fontId ? (
                <div style={{ fontSize: '9px', color: '#777' }}>
                  Replacement font: {fontId}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gap: '6px', marginTop: '4px' }}>
        <button
          type="button"
          className="button-primary"
          onClick={() => void onApplySelected()}
          disabled={!canApplyAny}
          style={{ width: '100%', minHeight: '34px' }}
          title={!allSelectedFit ? 'All selected candidates must pass layout verification before applying' : undefined}
        >
          {applyButtonLabel}
        </button>
      </div>
    </div>
  );
}
