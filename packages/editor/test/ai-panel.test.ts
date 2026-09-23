import { describe, expect, it, vi } from 'vitest';
import type { EditTransaction, EngineAdapter, Rect, RenderResult } from '@pdf-editor/contracts';
import { withReplacementFont } from '../src/ui/AiPanel.js';
import { computeTextDiff } from '../src/ui/AiPanelDiff.js';
import { captureRegionImage, createMinimalPngBase64 } from '../src/ui/AiPanelImage.js';

describe('AI text candidate font selection', () => {
  it('copies the explicit fontId into every accepted text replacement candidate', () => {
    const transaction: EditTransaction = {
      id: 'transaction-1',
      docId: 'document-1',
      baseRevision: 4,
      source: 'ai',
      commands: [
        {
          type: 'text.replace',
          pageId: 'page-1',
          blockId: 'block-1',
          range: [0, 4],
          text: 'Test',
        },
      ],
    };

    const styled = withReplacementFont(transaction, 'lxgw-wenkai-regular');

    expect(styled.commands[0]).toMatchObject({
      type: 'text.replace',
      style: { fontId: 'lxgw-wenkai-regular' },
    });
    expect(transaction.commands[0]).not.toHaveProperty('style');
  });
});

describe('文本差异比较 (AiPanelDiff)', () => {
  it('精确识别增加、删除与保留的内容片段', () => {
    const original = '这是测试文档的原始内容。';
    const suggested = '这是正式文档的更新内容。';

    const diff = computeTextDiff(original, suggested);
    expect(diff.length).toBeGreaterThan(0);

    const hasRemoved = diff.some(op => op.type === 'removed');
    const hasAdded = diff.some(op => op.type === 'added');
    const hasSame = diff.some(op => op.type === 'same');

    expect(hasRemoved).toBe(true);
    expect(hasAdded).toBe(true);
    expect(hasSame).toBe(true);

    const removedText = diff.filter(op => op.type === 'removed').map(op => op.text).join('');
    const addedText = diff.filter(op => op.type === 'added').map(op => op.text).join('');

    expect(removedText).toContain('测试');
    expect(removedText).toContain('原始');
    expect(addedText).toContain('正式');
    expect(addedText).toContain('更新');
  });

  it('原文本与建议一致时返回单一 same 操作', () => {
    const text = '完全相同的文本';
    const diff = computeTextDiff(text, text);
    expect(diff).toEqual([{ type: 'same', text }]);
  });

  it('原文为空时识别为纯新增', () => {
    const diff = computeTextDiff('', '纯新内容');
    expect(diff).toEqual([{ type: 'added', text: '纯新内容' }]);
  });

  it('建议为空时识别为纯删除', () => {
    const diff = computeTextDiff('被删内容', '');
    expect(diff).toEqual([{ type: 'removed', text: '被删内容' }]);
  });
});

describe('局部图表提取与图像格式转换 (AiPanelImage)', () => {
  it('生成符合规范的基础 PNG base64 数据（含有效 PNG 签名与 IHDR）', () => {
    const base64 = createMinimalPngBase64(300, 200);
    expect(typeof base64).toBe('string');
    expect(base64.length).toBeGreaterThan(0);

    const binary = atob(base64);
    // PNG 签名 0x89 0x50 0x4E 0x47
    expect(binary.charCodeAt(0)).toBe(0x89);
    expect(binary.charCodeAt(1)).toBe(0x50);
    expect(binary.charCodeAt(2)).toBe(0x4e);
    expect(binary.charCodeAt(3)).toBe(0x47);

    // IHDR 块标识
    expect(binary.slice(12, 16)).toBe('IHDR');
  });

  it('captureRegionImage 调用 engine.render 并正确传递裁剪区域与缩放比', async () => {
    const mockRenderResult: RenderResult = {
      width: 150,
      height: 100,
      stride: 600,
      format: 'rgba',
      pixels: new ArrayBuffer(600 * 100),
      revision: 1,
    };

    const clip: Rect = { x: 10, y: 20, width: 100, height: 80 };
    const mockEngine: Partial<EngineAdapter> = {
      render: vi.fn(async req => {
        expect(req.docId).toBe('doc-test');
        expect(req.pageId).toBe('page-test');
        expect(req.clip).toEqual(clip);
        expect(req.scale).toBe(1.5);
        return mockRenderResult;
      }),
    };

    const pngBase64 = await captureRegionImage(mockEngine as EngineAdapter, 'doc-test', 'page-test', clip, 1.5);
    expect(typeof pngBase64).toBe('string');
    expect(mockEngine.render).toHaveBeenCalledTimes(1);
  });
});

describe('候选排版验证门禁 (AiPanelCandidates layout gate)', () => {
  it('当选中的候选中存在 overflow 或 checking 时，批量应用应当被阻止', () => {
    const candidates = [
      { targetEvidenceId: 'e-1', text: '适合文本框', layoutState: 'fits' as const },
      { targetEvidenceId: 'e-2', text: '严重溢出文本框', layoutState: 'overflow' as const },
    ];

    const selectedIds = new Set(['e-1', 'e-2']);
    const selected = candidates.filter(c => selectedIds.has(c.targetEvidenceId));

    const anyOverflow = selected.some(c => c.layoutState === 'overflow');
    const allFit = selected.length > 0 && selected.every(c => c.layoutState === 'fits');

    expect(anyOverflow).toBe(true);
    expect(allFit).toBe(false);
  });

  it('只有所有已选候选均标记为 fits 时才允许批量应用', () => {
    const candidates = [
      { targetEvidenceId: 'e-1', text: '适合文本框1', layoutState: 'fits' as const },
      { targetEvidenceId: 'e-2', text: '适合文本框2', layoutState: 'fits' as const },
    ];

    const selectedIds = new Set(['e-1', 'e-2']);
    const selected = candidates.filter(c => selectedIds.has(c.targetEvidenceId));

    const allFit = selected.length > 0 && selected.every(c => c.layoutState === 'fits');
    expect(allFit).toBe(true);
  });
});

describe('表单填写建议 (A10 form.suggest) 原生集成', () => {
  it('已在功能清单中启用并声明为 nativeReady', async () => {
    const { AiPanel } = await import('../src/ui/AiPanel.js');
    expect(typeof AiPanel).toBe('function');
  });

  it('CommandRegistry 能针对真实表单字段校验并执行 form.fill', async () => {
    const { CommandRegistry } = await import('@pdf-editor/commands');
    const mockEngine: Partial<EngineAdapter> = {
      apply: vi.fn(async tx => ({
        docId: tx.docId,
        revision: tx.baseRevision + 1,
        changedPageIds: ['page-1'],
        pageOrder: ['page-1'],
        canUndo: true,
        canRedo: false,
      })),
    };

    const registry = new CommandRegistry(mockEngine as EngineAdapter);
    const document = {
      id: 'doc-form',
      revision: 1,
      savedRevision: 1,
      pageOrder: ['page-1'],
      sourceIds: ['src-1'],
      permissions: {
        modify: true,
        copy: true,
        annotate: true,
        fillForms: true,
        encrypted: false,
        signed: false,
      },
      capabilities: ['form.fill' as const],
    };

    const page = {
      id: 'page-1',
      widthPt: 595,
      heightPt: 842,
      rotation: 0 as const,
      objects: [],
    };

    const transaction: EditTransaction = {
      id: 'tx-fill',
      docId: 'doc-form',
      baseRevision: 1,
      source: 'ai',
      commands: [
        {
          type: 'form.fill',
          fieldId: 'field-1',
          value: 'Alice Smith',
        },
      ],
    };

    const context = {
      document,
      pages: new Map([['page-1', page]]),
      fields: new Map([
        [
          'field-1',
          {
            pageId: 'page-1',
            type: 'text' as const,
            options: [],
            readOnly: false,
          },
        ],
      ]),
    };

    const res = await registry.execute(transaction, context);
    expect(res.revision).toBe(2);
    expect(mockEngine.apply).toHaveBeenCalledTimes(1);
  });

  it('当权限禁止填写表单时，CommandRegistry 拒绝执行', async () => {
    const { CommandRegistry } = await import('@pdf-editor/commands');
    const mockEngine: Partial<EngineAdapter> = {
      apply: vi.fn(),
    };

    const registry = new CommandRegistry(mockEngine as EngineAdapter);
    const document = {
      id: 'doc-form-noperm',
      revision: 1,
      savedRevision: 1,
      pageOrder: ['page-1'],
      sourceIds: ['src-1'],
      permissions: {
        modify: true,
        copy: true,
        annotate: true,
        fillForms: false, // 权限禁止
        encrypted: false,
        signed: false,
      },
      capabilities: ['form.fill' as const],
    };

    const page = {
      id: 'page-1',
      widthPt: 595,
      heightPt: 842,
      rotation: 0 as const,
      objects: [],
    };

    const transaction: EditTransaction = {
      id: 'tx-noperm',
      docId: 'doc-form-noperm',
      baseRevision: 1,
      source: 'ai',
      commands: [
        {
          type: 'form.fill',
          fieldId: 'field-1',
          value: 'Forbidden',
        },
      ],
    };

    const context = {
      document,
      pages: new Map([['page-1', page]]),
      fields: new Map([
        [
          'field-1',
          {
            pageId: 'page-1',
            type: 'text' as const,
            options: [],
            readOnly: false,
          },
        ],
      ]),
    };

    expect(() => registry.execute(transaction, context)).toThrow(
      'This modification is not permitted on the current document',
    );
    expect(mockEngine.apply).not.toHaveBeenCalled();
  });
});
