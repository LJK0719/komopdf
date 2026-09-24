import { describe, it, expect } from 'vitest';
import {
  EngineError,
  type DocumentInfo,
  type PageModel,
  type EditableObject,
  type AiRequest,
  type AiResponseEnvelope,
} from '@pdf-editor/contracts';
import { validateTransaction, createAiTransaction, type CommandContext } from '../src/index.js';

describe('CommandRegistry & AI Plan 契约边界验证', () => {
  // 固定极小 DocumentInfo / PageModel 测试 fixture
  const textObject: EditableObject = {
    id: 'obj-text-1',
    pageId: 'page-1',
    type: 'text',
    bounds: { x: 0, y: 0, width: 200, height: 20 },
    transform: [1, 0, 0, 1, 0, 0],
    locator: { pageId: 'page-1', containerPath: [], objectIndex: 0 },
    textBlock: {
      id: 'block-1',
      pageId: 'page-1',
      sourceObjectIds: ['obj-text-1'],
      bounds: { x: 0, y: 0, width: 200, height: 20 },
      transform: [1, 0, 0, 1, 0, 0],
      editability: 'direct',
      // "Hello " (0..5), "👋" (6..7 in UTF-16, grapheme cluster 6..8), " world" (8..13)
      runs: [{ text: 'Hello 👋 world', style: {}, sourceObjectIds: ['obj-text-1'] }],
    },
  };

  const page1: PageModel = {
    id: 'page-1',
    widthPt: 595,
    heightPt: 842,
    rotation: 0,
    objects: [textObject],
  };

  const page2: PageModel = {
    id: 'page-2',
    widthPt: 595,
    heightPt: 842,
    rotation: 0,
    objects: [],
  };

  const baseDocument: DocumentInfo = {
    id: 'doc-1',
    revision: 1,
    savedRevision: 1,
    pageOrder: ['page-1', 'page-2'],
    sourceIds: ['src-1'],
    permissions: {
      modify: true,
      copy: true,
      annotate: true,
      fillForms: true,
      encrypted: false,
      signed: false,
    },
    capabilities: [
      'text.replace',
      'text.style',
      'pages.rotate',
      'pages.delete',
      'pages.reorder',
    ],
  };

  const context: CommandContext = {
    document: baseDocument,
    pages: new Map([
      ['page-1', page1],
      ['page-2', page2],
    ]),
  };

  // 1. 旧版本拒绝
  it('旧版本拒绝: 事务 baseRevision 与当前文档版本不一致时抛出 STALE_REVISION', () => {
    const staleTx = {
      id: 'tx-stale',
      docId: 'doc-1',
      baseRevision: 0, // 当前文档版本为 1
      source: 'manual' as const,
      commands: [
        {
          type: 'text.replace' as const,
          pageId: 'page-1',
          blockId: 'block-1',
          range: [0, 5] as [number, number],
          text: 'Hi',
        },
      ],
    };

    expect(() => validateTransaction(staleTx, context)).toThrowError(
      expect.objectContaining({ code: 'STALE_REVISION' })
    );
  });

  // 2. 删除最后页 / 删除后再旋转拒绝
  it('删除最后页/删除后再旋转拒绝: 阻止删除全部页面及引用已删页面的操作', () => {
    // 2.1 删除最后页
    const singlePageContext: CommandContext = {
      document: { ...baseDocument, pageOrder: ['page-1'] },
      pages: new Map([['page-1', page1]]),
    };
    const deleteLastTx = {
      id: 'tx-del-last',
      docId: 'doc-1',
      baseRevision: 1,
      source: 'manual' as const,
      commands: [
        {
          type: 'pages.delete' as const,
          pageIds: ['page-1'],
        },
      ],
    };
    expect(() => validateTransaction(deleteLastTx, singlePageContext)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST', message: expect.stringContaining('Working document must retain at least one page') })
    );

    // 2.2 同一事务中删除页面后再次旋转该已删除页面
    const deleteAndRotateTx = {
      id: 'tx-del-rotate',
      docId: 'doc-1',
      baseRevision: 1,
      source: 'manual' as const,
      commands: [
        {
          type: 'pages.delete' as const,
          pageIds: ['page-1'],
        },
        {
          type: 'pages.rotate' as const,
          pageIds: ['page-1'],
          degrees: 90 as const,
        },
      ],
    };
    expect(() => validateTransaction(deleteAndRotateTx, context)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST', message: expect.stringContaining('Command references a nonexistent or deleted page') })
    );
  });

  // 3. text范围切emoji或组合字符拒绝
  it('text范围切emoji或组合字符拒绝: 替换范围切开 emoji 内部代理对或字形簇时拒绝', () => {
    // "Hello 👋 world" 中，"👋" (U+1F44B) UTF-16 偏移位于 [6, 8]
    // 范围 [6, 7] 切断了 UTF-16 代理对和完整字形簇
    const splitEmojiTx = {
      id: 'tx-split-emoji',
      docId: 'doc-1',
      baseRevision: 1,
      source: 'manual' as const,
      commands: [
        {
          type: 'text.replace' as const,
          pageId: 'page-1',
          blockId: 'block-1',
          range: [6, 7] as [number, number],
          text: 'X',
        },
      ],
    };
    expect(() => validateTransaction(splitEmojiTx, context)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST', message: expect.stringContaining('Text range cannot split characters or grapheme clusters') })
    );
  });

  // 4. AI越界证据拒绝
  it('AI越界证据拒绝: AI 响应候选引用了请求 context 之外的证据 ID 时抛出 INVALID_REQUEST', () => {
    const aiRequest: AiRequest = {
      protocolVersion: 1,
      requestId: 'req-ai-1',
      feature: 'text.rewrite',
      document: { id: 'doc-1', revision: 1 },
      context: {
        scope: 'selection',
        evidence: [
          {
            id: 'ev-valid-1',
            docId: 'doc-1',
            revision: 1,
            pageId: 'page-1',
            pageNumber: 1,
            blockId: 'block-1',
            text: 'Hello',
            characterRange: [0, 5],
          },
        ],
      },
      instruction: '重写为更精简文字',
      options: {},
    };

    const outOfBoundsAiResponse: AiResponseEnvelope = {
      protocolVersion: 1,
      requestId: 'req-ai-1',
      document: { id: 'doc-1', baseRevision: 1 },
      feature: 'text.rewrite',
      result: {
        kind: 'textProposal',
        replacements: [
          {
            targetEvidenceId: 'ev-foreign-unknown', // 未在请求 context.evidence 中声明
            text: 'Hi',
          },
        ],
      },
    };

    expect(() =>
      createAiTransaction(aiRequest, outOfBoundsAiResponse, context, 'tx-ai-plan-1')
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST', message: expect.stringContaining('Candidate references evidence outside the request') })
    );
  });

  // 5. 同块两个替换要求倒序
  it('同块两个替换要求倒序: 升序替换抛出异常，倒序替换顺利通过', () => {
    // 正向/升序替换：先替换 [0, 5] 再替换 [8, 14] -> 违背倒序执行规则
    const ascendingTx = {
      id: 'tx-replace-asc',
      docId: 'doc-1',
      baseRevision: 1,
      source: 'manual' as const,
      commands: [
        {
          type: 'text.replace' as const,
          pageId: 'page-1',
          blockId: 'block-1',
          range: [0, 5] as [number, number],
          text: 'Hi',
        },
        {
          type: 'text.replace' as const,
          pageId: 'page-1',
          blockId: 'block-1',
          range: [8, 14] as [number, number],
          text: 'earth',
        },
      ],
    };
    expect(() => validateTransaction(ascendingTx, context)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST', message: expect.stringContaining('Text replacements in the same block must be executed in descending order of original range') })
    );

    // 倒序替换：先替换后面的 [8, 14]，再替换前面的 [0, 5] -> 预期通过
    const descendingTx = {
      id: 'tx-replace-desc',
      docId: 'doc-1',
      baseRevision: 1,
      source: 'manual' as const,
      commands: [
        {
          type: 'text.replace' as const,
          pageId: 'page-1',
          blockId: 'block-1',
          range: [8, 14] as [number, number],
          text: 'earth',
        },
        {
          type: 'text.replace' as const,
          pageId: 'page-1',
          blockId: 'block-1',
          range: [0, 5] as [number, number],
          text: 'Hi',
        },
      ],
    };
    expect(() => validateTransaction(descendingTx, context)).not.toThrow();
  });

  it('已删除文字对象不能在同一事务中继续被替换', () => {
    const changed: CommandContext = { ...context, document: { ...baseDocument, capabilities: [...baseDocument.capabilities, 'objects.delete'] } };
    expect(() => validateTransaction({ id: 'tx-delete-text', docId: 'doc-1', baseRevision: 1, source: 'manual', commands: [
      { type: 'objects.delete', pageId: 'page-1', objectIds: ['obj-text-1'] },
      { type: 'text.replace', pageId: 'page-1', blockId: 'block-1', range: [0, 5], text: 'Hi' },
    ] }, changed)).toThrow('Object containing the text has been deleted');
  });

  // 6. 无capability拒绝
  it('无capability拒绝: 执行未在内核能力声明列表中的命令时抛出 UNSUPPORTED_CAPABILITY', () => {
    // context.document.capabilities 中未包含 'annotation.add'
    const unsupportedTx = {
      id: 'tx-unsupported',
      docId: 'doc-1',
      baseRevision: 1,
      source: 'manual' as const,
      commands: [
        {
          type: 'annotation.add' as const,
          pageId: 'page-1',
          annotationId: 'anno-1',
          subtype: 'highlight' as const,
          bounds: { x: 10, y: 10, width: 50, height: 10 },
        },
      ],
    };

    expect(() => validateTransaction(unsupportedTx, context)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('Current engine does not support') })
    );
  });

  it('form.update 和 form.fill 严格执行 MaxLen 门禁，并在现值冲突时拒绝而非截断', () => {
    const formContext: CommandContext = {
      ...context,
      document: {
        ...baseDocument,
        capabilities: [...baseDocument.capabilities, 'form.update', 'form.fill'],
      },
      fields: new Map([
        ['field-text-1', {
          pageId: 'page-1',
          type: 'text',
          readOnly: false,
          value: 'Hello World', // 11 characters
          tooltip: 'Initial tip',
        }],
      ]),
    };

    // 1. 新增 MaxLen (5) < 现值长度 (11)，必须拒绝整笔候选而非截断
    const conflictTx = {
      id: 'tx-maxlen-conflict',
      docId: 'doc-1',
      baseRevision: 1,
      source: 'manual' as const,
      commands: [
        { type: 'form.update' as const, fieldId: 'field-text-1', maxLen: 5 },
      ],
    };
    expect(() => validateTransaction(conflictTx, formContext)).toThrow('Text field current value exceeds requested maximum length');

    // 2. 新增 MaxLen (20) >= 现值长度 (11)，且更新 tooltip 为 'New tip'，应通过
    const validUpdateTx = {
      id: 'tx-update-valid',
      docId: 'doc-1',
      baseRevision: 1,
      source: 'manual' as const,
      commands: [
        { type: 'form.update' as const, fieldId: 'field-text-1', maxLen: 20, tooltip: 'New tip' },
      ],
    };
    expect(() => validateTransaction(validUpdateTx, formContext)).not.toThrow();

    // 3. 在同一事务中，若 update 将 maxLen 设为 5，后续 fill 超过 5，应被长度门禁拒绝
    const fillExceedTx = {
      id: 'tx-fill-exceed',
      docId: 'doc-1',
      baseRevision: 1,
      source: 'manual' as const,
      commands: [
        { type: 'form.update' as const, fieldId: 'field-text-1', maxLen: 15 },
        { type: 'form.fill' as const, fieldId: 'field-text-1', value: 'This text is definitely longer than fifteen' },
      ],
    };
    expect(() => validateTransaction(fillExceedTx, formContext)).toThrow('Text value exceeds field maximum length');

    // 4. 清除 MaxLen (maxLen: null 或 0) 和清除 tooltip (tooltip: null)
    const clearTx = {
      id: 'tx-clear-properties',
      docId: 'doc-1',
      baseRevision: 1,
      source: 'manual' as const,
      commands: [
        { type: 'form.update' as const, fieldId: 'field-text-1', maxLen: null, tooltip: null },
      ],
    };
    expect(() => validateTransaction(clearTx, formContext)).not.toThrow();
  });
});
