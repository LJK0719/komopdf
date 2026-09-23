import { describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  type AiRequest,
  type AiResponseEnvelope,
} from '@pdf-editor/contracts';
import {
  AiPreviewError,
  buildTextProposalTransaction,
  createEvidenceSnapshot,
  createTransactionPreview,
  resolveCitation,
} from '../src/index.js';

function requestWithText(text: string, characterRange?: [number, number]): AiRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: 'request-1',
    feature: 'text.rewrite',
    document: { id: 'doc-1', revision: 4 },
    context: {
      scope: 'selection',
      evidence: [{
        id: 'e-1',
        docId: 'doc-1',
        revision: 4,
        pageId: 'page-1',
        pageNumber: 1,
        blockId: 'block-1',
        text,
        ...(characterRange ? { characterRange } : {}),
      }],
    },
    instruction: '改写',
    options: {},
  };
}

function proposalResponse(text: string): AiResponseEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: 'request-1',
    document: { id: 'doc-1', baseRevision: 4 },
    feature: 'text.rewrite',
    result: {
      kind: 'textProposal',
      replacements: [{ targetEvidenceId: 'e-1', text }],
    },
  };
}

describe('冻结证据、grapheme 和预览事务', () => {
  it('保留 A😀éB 的 UTF-16 范围并只在完整 grapheme 边界构建替换', () => {
    const blockText = 'A😀éB';
    const request = requestWithText('😀é', [1, 5]);
    const snapshot = createEvidenceSnapshot(request, [{
      evidenceId: 'e-1', sourceId: 'source-1', blockText,
    }]);

    const transaction = buildTextProposalTransaction(proposalResponse('替换'), snapshot, 'tx-1');
    expect(transaction.commands).toEqual([{
      type: 'text.replace', pageId: 'page-1', blockId: 'block-1', range: [1, 5], text: '替换',
    }]);

    const citation = resolveCitation(snapshot, { evidenceId: 'e-1', quote: 'é' }, { id: 'doc-1', revision: 4 });
    expect(citation.status).toBe('resolved');
    if (citation.status === 'resolved') {
      expect(citation.match).toBe('quote');
      expect(citation.currentLocation?.range).toEqual([3, 5]);
    }
  });

  it('拒绝切开代理对或组合字形的本地范围', () => {
    const request = requestWithText('\ud83d', [1, 2]);
    expect(() => createEvidenceSnapshot(request, [{
      evidenceId: 'e-1', sourceId: 'source-1', blockText: 'A😀éB',
    }])).toThrow('Text range cannot split characters or grapheme clusters');
  });

  it('重复引文只定位整个证据块', () => {
    const request = requestWithText('foo foo');
    const snapshot = createEvidenceSnapshot(request, [{
      evidenceId: 'e-1', sourceId: 'source-1', blockText: 'foo foo',
    }]);
    const citation = resolveCitation(snapshot, { evidenceId: 'e-1', quote: 'foo' }, { id: 'doc-1', revision: 4 });
    expect(citation.status).toBe('resolved');
    if (citation.status === 'resolved') {
      expect(citation.match).toBe('evidence');
      expect(citation.currentLocation?.range).toEqual([0, 7]);
    }
  });

  it('旧版本保留冻结位置但不提供当前坐标跳转', () => {
    const request = requestWithText('原文');
    const snapshot = createEvidenceSnapshot(request, [{
      evidenceId: 'e-1', sourceId: 'source-1', blockText: '原文',
    }]);
    const citation = resolveCitation(snapshot, { evidenceId: 'e-1' }, { id: 'doc-1', revision: 5 });
    expect(citation.status).toBe('resolved');
    if (citation.status === 'resolved') {
      expect(citation.frozenLocation.range).toEqual([0, 2]);
      expect(citation.currentLocation).toBeUndefined();
    }
  });

  it('两个并发 accept 只能有一个越过 getCurrentDocument 锁', async () => {
    const request = requestWithText('原文');
    const snapshot = createEvidenceSnapshot(request, [{
      evidenceId: 'e-1', sourceId: 'source-1', blockText: '原文',
    }]);
    const response = proposalResponse('新文');
    const transaction = buildTextProposalTransaction(response, snapshot, 'tx-concurrent');
    let releaseCurrentDocument: (() => void) | undefined;
    const currentDocumentGate = new Promise<void>(resolve => { releaseCurrentDocument = resolve; });
    const getCurrentDocument = vi.fn(async () => {
      await currentDocumentGate;
      return { id: 'doc-1', revision: 4 };
    });
    const apply = vi.fn(async () => ({ revision: 5 }));
    const preview = createTransactionPreview(response, transaction, getCurrentDocument, apply);

    const first = preview.accept();
    await expect(preview.accept()).rejects.toMatchObject<Partial<AiPreviewError>>({ code: 'APPLY_IN_PROGRESS' });
    releaseCurrentDocument?.();
    await expect(first).resolves.toEqual({ revision: 5 });
    expect(getCurrentDocument).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('版本变化后明确接受也不会调用 apply', async () => {
    const request = requestWithText('原文');
    const snapshot = createEvidenceSnapshot(request, [{
      evidenceId: 'e-1', sourceId: 'source-1', blockText: '原文',
    }]);
    const response = proposalResponse('新文');
    const transaction = buildTextProposalTransaction(response, snapshot, 'tx-1');
    const apply = vi.fn(async () => ({ revision: 5 }));
    const preview = createTransactionPreview(
      response,
      transaction,
      () => ({ id: 'doc-1', revision: 5 }),
      apply,
    );

    await expect(preview.accept()).rejects.toMatchObject<Partial<AiPreviewError>>({ code: 'STALE_REVISION' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('支持传入 selectedEvidenceIds 逐项挑选接受候选', () => {
    const request: AiRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'request-multi',
      feature: 'text.rewrite',
      document: { id: 'doc-1', revision: 4 },
      context: {
        scope: 'selection',
        evidence: [
          { id: 'e-1', docId: 'doc-1', revision: 4, pageId: 'page-1', pageNumber: 1, blockId: 'b-1', text: '段落一' },
          { id: 'e-2', docId: 'doc-1', revision: 4, pageId: 'page-1', pageNumber: 1, blockId: 'b-2', text: '段落二' },
        ],
      },
      instruction: '改写',
      options: {},
    };
    const snapshot = createEvidenceSnapshot(request, [
      { evidenceId: 'e-1', sourceId: 'source-1', blockText: '段落一' },
      { evidenceId: 'e-2', sourceId: 'source-1', blockText: '段落二' },
    ]);
    const response: AiResponseEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'request-multi',
      document: { id: 'doc-1', baseRevision: 4 },
      feature: 'text.rewrite',
      result: {
        kind: 'textProposal',
        replacements: [
          { targetEvidenceId: 'e-1', text: '新段落一' },
          { targetEvidenceId: 'e-2', text: '新段落二' },
        ],
      },
    };

    // 只挑选 e-2
    const single = buildTextProposalTransaction(response, snapshot, 'tx-single', new Set(['e-2']));
    expect(single.commands).toHaveLength(1);
    expect(single.commands[0]).toMatchObject({ blockId: 'b-2', text: '新段落二' });

    // 未选择任何有效证据时报错
    expect(() => buildTextProposalTransaction(response, snapshot, 'tx-none', new Set(['unknown'])))
      .toThrow('No candidates selected for transaction');
  });
});
