import { translate as t, useI18n } from './i18n.js';
import React, { useState } from 'react';
import type { CitationRef, DocumentInfo } from '@pdf-editor/contracts';
import { resolveCitation, type EvidenceSnapshot } from '@pdf-editor/ai-client';

export type ExtractedItem = {
  name: string;
  rawValue: string;
  normalizedValue?: string | undefined;
  citations: CitationRef[];
};

export type AiPanelExtractionProps = {
  fields: ExtractedItem[];
  snapshot: EvidenceSnapshot | null;
  document: DocumentInfo | null;
  onLocate?: ((pageId: string, blockId: string) => void) | undefined;
};

export function AiPanelExtraction({
  fields,
  snapshot,
  document,
  onLocate,
}: AiPanelExtractionProps) {
  useI18n();
  const [copied, setCopied] = useState(false);

  const copyAsText = async () => {
    const text = fields
      .map(
        f =>
          `${f.name}: ${f.rawValue}${f.normalizedValue ? ` (Normalized: ${f.normalizedValue})` : ''}`,
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = window.document.createElement('textarea');
      ta.value = text;
      window.document.body.appendChild(ta);
      ta.select();
      window.document.execCommand('copy');
      window.document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const exportCsv = () => {
    const header = ['Field Name', 'Raw Value', 'Normalized Value'];
    const rows = fields.map(f => [
      escapeCsv(f.name),
      escapeCsv(f.rawValue),
      escapeCsv(f.normalizedValue ?? ''),
    ]);
    const csvContent = '﻿' + [header.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `komo-extraction-${Date.now()}.csv`);
    window.document.body.appendChild(link);
    link.click();
    window.document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="ai-extraction-container" style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{t("Extracted Structured Fields (")}{fields.length})</strong>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            onClick={() => void copyAsText()}
            style={{ fontSize: '10px', padding: '4px 8px' }}
          >
            {copied ? t("Copied") : t("Copy Text")}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            style={{ fontSize: '10px', padding: '4px 8px' }}
          >{t("Export CSV")}</button>
        </div>
      </div>

      <div
        style={{
          maxHeight: '260px',
          overflowY: 'auto',
          border: '1px solid #c2c1ba',
          borderRadius: '2px',
          background: '#fffdf6',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
          <thead>
            <tr style={{ background: '#e8e6df', borderBottom: '1px solid #c2c1ba', textAlign: 'left' }}>
              <th style={{ padding: '6px' }}>{t("Field")}</th>
              <th style={{ padding: '6px' }}>{t("Raw Value")}</th>
              <th style={{ padding: '6px' }}>{t("Normalized")}</th>
              <th style={{ padding: '6px' }}>{t("Source")}</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, idx) => (
              <tr
                key={idx}
                style={{
                  borderBottom: idx < fields.length - 1 ? '1px solid #e2e0d8' : 'none',
                }}
              >
                <td style={{ padding: '6px', fontWeight: 600 }}>{field.name}</td>
                <td style={{ padding: '6px' }}>{field.rawValue}</td>
                <td style={{ padding: '6px', color: '#666' }}>{field.normalizedValue || '-'}</td>
                <td style={{ padding: '6px' }}>
                  {field.citations.map((citation, cIdx) => {
                    if (!snapshot || !document) return null;
                    const resolved = resolveCitation(snapshot, citation, document);
                    if (resolved.status !== 'resolved') return null;
                    return (
                      <button
                        key={cIdx}
                        type="button"
                        onClick={() =>
                          onLocate?.(
                            resolved.frozenLocation.pageId,
                            resolved.frozenLocation.blockId,
                          )
                        }
                        title={citation.quote ? `Citation: ${citation.quote}` : undefined}
                        style={{
                          fontSize: '9px',
                          padding: '2px 4px',
                          marginRight: '2px',
                          cursor: 'pointer',
                        }}
                      >
                        P.{resolved.frozenLocation.pageNumber}
                      </button>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function escapeCsv(value: string): string {
  if (!value) return '""';
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `"${value}"`;
}
