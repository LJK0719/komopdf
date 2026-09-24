import { describe, expect, it } from 'vitest';
import { aiRequestSchema, assertTextRange, editCommandSchema, proposedCommandSchema, encodeFrameHeader, decodeFrameHeader } from '../src/index.js';

describe('共享数据契约', () => {
  it('native 帧协议与 C++ 使用相同固定字节', () => {
    const header = { type: 'binary' as const, length: 65536, sequence: 7 };
    const bytes = encodeFrameHeader(header);
    expect([...bytes]).toEqual([80, 68, 70, 69, 1, 0, 2, 0, 0, 0, 1, 0, 7, 0, 0, 0]);
    expect(decodeFrameHeader(bytes)).toEqual(header);
    const invalid = bytes.slice();
    new DataView(invalid.buffer).setUint32(8, 1024 * 1024 + 1, true);
    expect(() => decodeFrameHeader(invalid)).toThrow();
  });
  it('UTF-16 范围同时尊重完整字符和核心字形簇', () => {
    const text = 'A😀éB';
    expect(() => assertTextRange(text, [1, 3])).not.toThrow();
    expect(() => assertTextRange(text, [1, 2])).toThrow();
    expect(() => assertTextRange(text, [3, 4])).toThrow();
    expect(() => assertTextRange(text, [3, 5])).not.toThrow();
    expect(() => assertTextRange('fi', [0, 1], new Set([0, 2]))).toThrow();
  });
  it('模型文字候选不能携带字符偏移或任意执行源码', () => {
    expect(proposedCommandSchema.safeParse({ type: 'text.replace', targetEvidenceId: 'e1', text: '修改' }).success).toBe(true);
    expect(proposedCommandSchema.safeParse({ type: 'text.replace', targetEvidenceId: 'e1', text: '修改', range: [0, 1] }).success).toBe(false);
    expect(proposedCommandSchema.safeParse({ type: 'shell', command: 'anything' }).success).toBe(false);
  });
  it('表单属性更新要求显式值，多选只允许列表字段', () => {
    expect(editCommandSchema.safeParse({ type: 'form.update', fieldId: 'f1' }).success).toBe(false);
    expect(editCommandSchema.safeParse({ type: 'form.update', fieldId: 'f1', readOnly: false }).success).toBe(true);
    expect(editCommandSchema.safeParse({ type: 'form.update', fieldId: 'f1', multiple: true, required: true }).success).toBe(true);
    const create = { type: 'form.create', pageId: 'p1', fieldId: 'f2', name: 'List',
      fieldType: 'list', bounds: { x: 0, y: 0, width: 40, height: 40 }, options: ['A'], fontId: 'font' };
    expect(editCommandSchema.safeParse({ ...create, multiple: true }).success).toBe(true);
    expect(editCommandSchema.safeParse({ ...create, fieldType: 'combo', multiple: true }).success).toBe(false);
  });
  it('请求拒绝跨文档证据与任意 provider 参数', () => {
    const request = { protocolVersion: 1, requestId: 'request', feature: 'text.rewrite', document: { id: 'doc', revision: 1 },
      context: { scope: 'selection', evidence: [{ id: 'e1', docId: 'doc', revision: 1, pageId: 'p1', pageNumber: 1, blockId: 'b1', text: '😀', characterRange: [5, 7] }] }, instruction: '', options: {} };
    expect(aiRequestSchema.safeParse(request).success).toBe(true);
    expect(aiRequestSchema.safeParse({ ...request, provider: 'https://example.com' }).success).toBe(false);
    expect(aiRequestSchema.safeParse({ ...request, document: { id: 'another-doc', revision: 1 } }).success).toBe(false);
  });
});
