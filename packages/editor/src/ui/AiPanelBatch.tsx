import React, { useEffect, useRef, useState } from 'react';
import type { DocumentInfo, EngineAdapter, PageModel, TextBlock } from '@pdf-editor/contracts';
import {
  DocumentAiAuthorization,
  LongTaskRunner,
  assertResponseMatchesSnapshot,
  createEvidenceSnapshot,
  createLongTask,
  postAiRequest,
  type LocalEvidenceSource,
  type LongTaskBatch,
  type LongTaskRecord,
} from '@pdf-editor/ai-client';
import { IndexedDbTaskStore } from './AiPanelTaskStore.js';

export type BatchPayload = {
  pageId: string;
  pageNumber: number;
  blockId: string;
  range: [number, number];
  originalText: string;
};

export type BatchResult = {
  translatedText: string;
};

export type AiPanelBatchProps = {
  document: DocumentInfo;
  page: PageModel;
  engine: EngineAdapter;
  authorization: DocumentAiAuthorization;
  endpoint?: string | undefined;
  targetLanguage: string;
  onApplyBlock(pageId: string, blockId: string, range: [number, number], text: string): Promise<void>;
  onLocate?: ((pageId: string, blockId: string) => void) | undefined;
  disabled: boolean;
};

export function AiPanelBatch({
  document,
  page,
  engine,
  authorization,
  endpoint = '/api/v1/ai/requests',
  targetLanguage,
  onApplyBlock,
  onLocate,
  disabled,
}: AiPanelBatchProps) {
  const [scope, setScope] = useState<'page' | 'document'>('page');
  const [task, setTask] = useState<LongTaskRecord<BatchPayload, BatchResult> | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');
  const [applyingBlockId, setApplyingBlockId] = useState<string | null>(null);

  const runnerRef = useRef<LongTaskRunner<BatchPayload, BatchResult> | null>(null);
  const storeRef = useRef<IndexedDbTaskStore<BatchPayload, BatchResult> | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const currentDocRef = useRef(document);
  currentDocRef.current = document;

  useEffect(() => {
    isMountedRef.current = true;
    const store = new IndexedDbTaskStore<BatchPayload, BatchResult>();
    storeRef.current = store;
    const runner = new LongTaskRunner(store);
    runnerRef.current = runner;

    // 恢复先前保存的任务：将遗留 running 置为 paused，并展示已完成结果
    void (async () => {
      try {
        const existing = await store.getLatestTaskForDocument(document.id, 'document.translate');
        if (!isMountedRef.current || currentDocRef.current.id !== document.id) return;
        if (existing) {
          const restored = await runner.restore(existing.id);
          if (isMountedRef.current && currentDocRef.current.id === document.id) {
            setTask(restored);
            if (restored.status === 'completed') {
              setStatusText('All batches completed');
            } else {
              setStatusText('Previous task restored in paused state. Re-authorize and click Resume to continue.');
            }
          }
        }
      } catch {
        // 恢复失败仅作为全新任务处理
      }
    })();

    return () => {
      isMountedRef.current = false;
      const runningId = activeTaskIdRef.current;
      if (runningId && runnerRef.current) {
        void runnerRef.current.pauseTask(runningId);
      }
    };
  }, [document.id]);

  const startTask = async () => {
    if (disabled || busy || task?.status === 'running' || !runnerRef.current || !storeRef.current) return;
    setError('');
    setBusy(true);
    setStatusText('Collecting text blocks…');

    try {
      const pageIds = scope === 'page' ? [page.id] : document.pageOrder;
      const allBlocks: { pageId: string; pageNumber: number; block: TextBlock }[] = [];

      for (const pageId of pageIds) {
        const pageNumber = document.pageOrder.indexOf(pageId) + 1;
        const blocks = await engine.extract({ docId: document.id, pageIds: [pageId] });
        for (const block of blocks) {
          const text = block.runs.map(r => r.text).join('').trim();
          if (text.length > 0) {
            allBlocks.push({ pageId, pageNumber, block });
          }
        }
      }

      if (allBlocks.length === 0) {
        throw new Error('No extractable text blocks found in the selected scope');
      }

      const batches = allBlocks.map((item, idx) => {
        const text = item.block.runs.map(r => r.text).join('');
        return {
          id: `batch-${idx + 1}`,
          content: text,
          payload: {
            pageId: item.pageId,
            pageNumber: item.pageNumber,
            blockId: item.block.id,
            range: [0, text.length] as [number, number],
            originalText: text,
          },
        };
      });

      const newTask = await createLongTask<BatchPayload, BatchResult>({
        id: `translate-${document.id}-${Date.now()}`,
        docId: document.id,
        baseRevision: document.revision,
        sourceIds: document.sourceIds,
        taskType: 'document.translate',
        scope: { scope, pageCount: pageIds.length },
        contentFingerprint: `doc-${document.id}-rev-${document.revision}-b${batches.length}`,
        model: 'gemini-3.8-flash-high',
        templateVersion: '1',
        protocolVersion: 1,
        settings: { targetLanguage },
        batches,
      });

      await storeRef.current.saveTask(newTask);
      if (!isMountedRef.current || currentDocRef.current.id !== document.id) return;
      setTask(newTask);

      await runTaskLoop(newTask.id);
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to start batch task');
        setBusy(false);
      }
    }
  };

  const runTaskLoop = async (taskId: string) => {
    if (!runnerRef.current || !storeRef.current) return;
    activeTaskIdRef.current = taskId;
    setBusy(true);
    setStatusText('Processing batch requests…');

    try {
      const finished = await runnerRef.current.continueTask(
        taskId,
        authorization,
        async (_task, batch: Readonly<LongTaskBatch<BatchPayload, BatchResult>>, signal: AbortSignal) => {
          // 严格绑定 _task 的真实元数据与设置
          const taskSettings = (_task.settings ?? {}) as { targetLanguage?: string };
          const effectiveLang = taskSettings.targetLanguage ?? targetLanguage;

          const evidence = [
            {
              id: 'e1',
              docId: _task.docId,
              revision: _task.baseRevision,
              pageId: batch.payload.pageId,
              pageNumber: batch.payload.pageNumber,
              blockId: batch.payload.blockId,
              text: batch.content,
            },
          ];
          const localSources: LocalEvidenceSource[] = [
            {
              evidenceId: 'e1',
              sourceId: _task.sourceIds[0] ?? document.sourceIds[0] ?? 'src-1',
              blockText: batch.content,
            },
          ];
          const request = {
            protocolVersion: 1 as const,
            requestId: crypto.randomUUID(),
            feature: 'text.translate' as const,
            document: { id: _task.docId, revision: _task.baseRevision },
            context: { scope: 'selection' as const, evidence },
            instruction: `Translate to ${effectiveLang}`,
            options: { targetLanguage: effectiveLang, preserveNumbers: true },
          };

          const snapshot = createEvidenceSnapshot(request, localSources);
          const outcome = await postAiRequest({
            endpoint,
            request,
            signal,
          });

          // 必须通过 snapshot 严格复核 response
          assertResponseMatchesSnapshot(outcome.response, snapshot);

          const res = outcome.response.result;
          let translatedText: string | undefined;

          if (res.kind === 'textProposal') {
            const matched = res.replacements.find(r => r.targetEvidenceId === 'e1');
            if (matched) translatedText = matched.text;
          } else if (res.kind === 'translation') {
            const matched = res.blocks.find(b => b.evidenceId === 'e1');
            if (matched) translatedText = matched.text;
          }

          if (!translatedText) {
            throw new Error('AI response did not bind to requested evidence ID');
          }

          // 实时更新 React 状态，展示每个已完成批次
          if (isMountedRef.current && currentDocRef.current.id === _task.docId) {
            const latestTask = await storeRef.current?.loadTask(taskId);
            if (latestTask && isMountedRef.current && currentDocRef.current.id === _task.docId) {
              setTask({ ...latestTask });
            }
          }

          return { translatedText };
        },
      );

      if (isMountedRef.current && currentDocRef.current.id === finished.docId) {
        setTask({ ...finished });
        setStatusText(finished.status === 'completed' ? 'All batches completed successfully' : `Task ${finished.status}`);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Batch processing encountered an error');
      }
    } finally {
      activeTaskIdRef.current = null;
      if (isMountedRef.current) {
        setBusy(false);
      }
    }
  };

  const pauseTask = async () => {
    if (!task || !runnerRef.current) return;
    setStatusText('Pausing task…');
    await runnerRef.current.pauseTask(task.id);
    const restored = await runnerRef.current.restore(task.id);
    if (isMountedRef.current) {
      setTask({ ...restored });
      setBusy(false);
      setStatusText('Task paused');
    }
  };

  const resumeTask = async () => {
    if (!task || busy || task.status === 'running' || !runnerRef.current) return;
    setError('');
    await runTaskLoop(task.id);
  };

  const cancelTask = async () => {
    if (!task || !runnerRef.current) return;
    await runnerRef.current.cancelTask(task.id);
    if (isMountedRef.current) {
      setTask(null);
      setBusy(false);
      setStatusText('Task cancelled and cleared');
    }
  };

  // 单块写入 PDF：必须先校验文档版本与当前原文未发生变动，并进行真实排版测量
  const handleWriteBlock = async (batch: LongTaskBatch<BatchPayload, BatchResult>) => {
    if (!task || !batch.result || applyingBlockId) return;
    if (currentDocRef.current.id !== task.docId || currentDocRef.current.revision !== task.baseRevision) {
      setError('Document revision has changed since translation was generated; cannot apply stale candidate.');
      return;
    }

    setApplyingBlockId(batch.id);
    setError('');

    try {
      // 1. 验证当前文本块内容是否与生成译文时完全一致
      const currentBlocks = await engine.extract({
        docId: currentDocRef.current.id,
        pageIds: [batch.payload.pageId],
      });
      const targetBlock = currentBlocks.find(b => b.id === batch.payload.blockId);
      if (!targetBlock) {
        throw new Error('Target text block no longer exists in current page');
      }
      const currentBlockText = targetBlock.runs.map(r => r.text).join('');
      if (currentBlockText !== batch.payload.originalText) {
        throw new Error('Block text was edited after translation; range is invalid. Please re-translate.');
      }

      // 2. 真实排版测算
      const layout = await engine.previewText({
        docId: currentDocRef.current.id,
        pageId: batch.payload.pageId,
        blockId: batch.payload.blockId,
        range: batch.payload.range,
        text: batch.result.translatedText,
      });

      if (layout.overflow) {
        throw new Error('Translated text overflows the text box; cannot apply directly. Please shorten translation or enlarge the box.');
      }

      // 3. 执行应用
      await onApplyBlock(
        batch.payload.pageId,
        batch.payload.blockId,
        batch.payload.range,
        batch.result.translatedText,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to write translation to PDF');
    } finally {
      if (isMountedRef.current) {
        setApplyingBlockId(null);
      }
    }
  };

  const completedCount = task?.batches.filter(b => b.status === 'completed').length ?? 0;
  const totalCount = task?.batches.length ?? 0;
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const isRunning = busy || task?.status === 'running';

  return (
    <div className="ai-batch-panel" style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
          <input
            type="radio"
            name="batch-scope"
            checked={scope === 'page'}
            onChange={() => setScope('page')}
            disabled={disabled || isRunning}
          />
          Current Page
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
          <input
            type="radio"
            name="batch-scope"
            checked={scope === 'document'}
            onChange={() => setScope('document')}
            disabled={disabled || isRunning}
          />
          Entire Document ({document.pageOrder.length} pages)
        </label>
      </div>

      {!task && (
        <button
          type="button"
          className="button-primary"
          onClick={() => void startTask()}
          disabled={disabled || isRunning}
        >
          {busy ? 'Preparing batch task…' : `Start Translation (${scope === 'page' ? 'Current Page' : 'Full Document'})`}
        </button>
      )}

      {task && (
        <div style={{ display: 'grid', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
            <span>
              Progress: {completedCount}/{totalCount} batches ({percent}%)
            </span>
            <span style={{ fontWeight: 600 }}>Status: {task.status}</span>
          </div>

          <div
            style={{
              width: '100%',
              height: '6px',
              background: '#d8d6cf',
              borderRadius: '3px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${percent}%`,
                height: '100%',
                background: '#7e9019',
                transition: 'width 200ms ease',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            {isRunning && (
              <button type="button" onClick={() => void pauseTask()} style={{ flex: 1 }}>
                Pause
              </button>
            )}
            {!isRunning && task.status !== 'completed' && task.status !== 'cancelled' && (
              <button type="button" onClick={() => void resumeTask()} disabled={disabled} style={{ flex: 1 }}>
                Resume
              </button>
            )}
            <button
              type="button"
              onClick={() => void cancelTask()}
              disabled={disabled || isRunning}
              style={{ flex: 1 }}
            >
              Reset Task
            </button>
          </div>
        </div>
      )}

      {error && <p role="alert" style={{ color: '#ff623d' }}>{error}</p>}
      {statusText && <p style={{ fontSize: '10px', color: '#666' }}>{statusText}</p>}

      {task && task.batches.some(b => b.status === 'completed') && (
        <div style={{ display: 'grid', gap: '8px', maxHeight: '280px', overflowY: 'auto' }}>
          <strong>Translated Blocks</strong>
          {task.batches
            .filter(b => b.status === 'completed' && b.result)
            .map(batch => (
              <div
                key={batch.id}
                style={{
                  border: '1px solid #c2c1ba',
                  borderRadius: '2px',
                  padding: '8px',
                  background: '#fffdf6',
                  fontSize: '11px',
                  display: 'grid',
                  gap: '4px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#888', fontSize: '9px' }}>
                  <span>P.{batch.payload.pageNumber} · Block {batch.payload.blockId}</span>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      type="button"
                      onClick={() => onLocate?.(batch.payload.pageId, batch.payload.blockId)}
                      style={{ fontSize: '9px', padding: '1px 4px' }}
                    >
                      Locate
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleWriteBlock(batch)}
                      disabled={disabled || applyingBlockId === batch.id || isRunning}
                      style={{ fontSize: '9px', padding: '1px 6px', fontWeight: 600 }}
                    >
                      {applyingBlockId === batch.id ? 'Writing…' : 'Write to PDF'}
                    </button>
                  </div>
                </div>

                <div style={{ color: '#666', fontSize: '10px' }}>{batch.content}</div>
                <div style={{ fontWeight: 600, color: '#20231f' }}>{batch.result!.translatedText}</div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
