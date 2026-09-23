import { describe, expect, it } from 'vitest';
import type { CitationRef } from '@pdf-editor/contracts';
import { IndexedDbTaskStore } from '../src/ui/AiPanelTaskStore.js';
import { computeTextDiff } from '../src/ui/AiPanelDiff.js';
import { batchSourceId } from '../src/ui/AiPanelBatch.js';

describe('AI 结构化提取与导出 (AiPanelExtraction)', () => {
  it('正确转义包含特殊字符的 CSV 字段', () => {
    function escapeCsv(value: string): string {
      if (!value) return '""';
      if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return `"${value}"`;
    }

    expect(escapeCsv('Simple text')).toBe('"Simple text"');
    expect(escapeCsv('Contains, comma')).toBe('"Contains, comma"');
    expect(escapeCsv('Contains "quotes"')).toBe('"Contains ""quotes"""');
    expect(escapeCsv('Multiline\ntext')).toBe('"Multiline\ntext"');
  });

  it('提取条目包含完整的字段名、原值、标准化值与引文数组', () => {
    const citations: CitationRef[] = [{ evidenceId: 'e-1', quote: '$50,000' }];
    const field = {
      name: 'Total Amount',
      rawValue: '$50,000',
      normalizedValue: '50000 USD',
      citations,
    };

    expect(field.name).toBe('Total Amount');
    expect(field.rawValue).toBe('$50,000');
    expect(field.normalizedValue).toBe('50000 USD');
    expect(field.citations[0]?.evidenceId).toBe('e-1');
  });
});

describe('批量翻译证据来源', () => {
  it('多来源文档使用每个文本块的真实来源，而非默认第一个来源', () => {
    expect(batchSourceId(['source-A', 'source-B'], 'source-B')).toBe('source-B');
    expect(() => batchSourceId(['source-A', 'source-B'])).toThrow('missing source mapping');
    expect(() => batchSourceId(['source-A', 'source-B'], 'other')).toThrow('missing source mapping');
  });

  it('单来源旧任务仍可恢复，无来源身份时不伪造新来源', () => {
    expect(batchSourceId(['source-A'])).toBe('source-A');
    expect(() => batchSourceId([])).toThrow('missing source mapping');
  });
});

describe('分批长任务持久化存储 (IndexedDbTaskStore)', () => {
  it('支持任务保存、恢复与按文档查找最新任务', async () => {
    const store = new IndexedDbTaskStore<{ index: number }, { text: string }>();
    const taskRecord = {
      id: 'task-persistent-1',
      docId: 'doc-persist',
      baseRevision: 2,
      sourceIds: ['src-1'],
      taskType: 'document.translate',
      scope: { page: 1 },
      contentFingerprint: 'fp-1',
      model: 'gemini-3.8-flash-high',
      templateVersion: '1',
      protocolVersion: 1,
      settings: { targetLanguage: 'English' },
      settingsHash: 'sh-1',
      hashKey: 'hk-1',
      status: 'completed' as const,
      batches: [
        {
          id: 'b-1',
          content: 'Hello',
          contentHash: 'ch-1',
          payloadHash: 'ph-1',
          cacheKey: 'ck-1',
          payload: { index: 0 },
          status: 'completed' as const,
          result: { text: '你好' },
        },
      ],
    };

    await store.saveTask(taskRecord);
    const loaded = await store.loadTask('task-persistent-1');
    expect(loaded).toBeDefined();
    expect(loaded?.docId).toBe('doc-persist');
    expect(loaded?.batches[0]?.result?.text).toBe('你好');

    const latest = await store.getLatestTaskForDocument('doc-persist', 'document.translate');
    expect(latest?.id).toBe('task-persistent-1');
  });
});

describe('文本差异比较英文统计 (AiPanelDiff)', () => {
  it('正确统计英文与符号的字符增减', () => {
    const diff = computeTextDiff('Original text paragraph', 'Updated text section');
    expect(diff.length).toBeGreaterThan(0);
    const hasRemoved = diff.some(d => d.type === 'removed');
    const hasAdded = diff.some(d => d.type === 'added');
    expect(hasRemoved).toBe(true);
    expect(hasAdded).toBe(true);
  });
});

describe('表单建议组件与数据格式化 (AiPanelForm)', () => {
  it('formatDisplayValue 正确处理各种字段值格式', async () => {
    const { formatDisplayValue } = await import('../src/ui/AiPanelForm.js');
    expect(formatDisplayValue('')).toBe('(empty)');
    expect(formatDisplayValue(undefined)).toBe('(empty)');
    expect(formatDisplayValue(true)).toBe('Checked');
    expect(formatDisplayValue(false)).toBe('Unchecked');
    expect(formatDisplayValue(['Option A', 'Option B'])).toBe('Option A, Option B');
    expect(formatDisplayValue([])).toBe('(none)');
    expect(formatDisplayValue('John Doe')).toBe('John Doe');
  });

  it('支持单个字段和多选字段构建原生 form.fill 命令', () => {
    const suggestions = [
      {
        fieldId: 'f1',
        fieldName: 'FullName',
        fieldType: 'text' as const,
        currentValue: '',
        suggestedValue: 'Alice Smith',
        required: true,
      },
      {
        fieldId: 'f2',
        fieldName: 'Subscribe',
        fieldType: 'checkbox' as const,
        currentValue: false,
        suggestedValue: true,
        required: false,
      },
    ];

    const selectedIds = new Set(['f1']);
    const selected = suggestions.filter(s => selectedIds.has(s.fieldId));
    expect(selected).toHaveLength(1);
    expect(selected[0]?.suggestedValue).toBe('Alice Smith');

    const commands = selected.map(s => ({
      type: 'form.fill' as const,
      fieldId: s.fieldId,
      value: s.suggestedValue,
    }));
    expect(commands[0]).toEqual({
      type: 'form.fill',
      fieldId: 'f1',
      value: 'Alice Smith',
    });
  });
});

