import { translate as t, useI18n } from './i18n.js';
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
  sourceId: string;
  range: [number, number];
  originalText: string;
};

export function batchSourceId(sourceIds: readonly string[], blockSourceId?: string): string {
  const sourceId = blockSourceId ?? (sourceIds.length === 1 ? sourceIds[0] : undefined);
  if (!sourceId || !sourceIds.includes(sourceId)) {
    throw new Error('Text block missing source mapping; cannot authorize batch translation');
  }
  return sourceId;
}

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
  onApplyBlocks(blocks: { pageId: string; blockId: string; range: [number, number]; text: string }[]): Promise<void>;
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
  onApplyBlocks,
  onLocate,
  disabled,
}: AiPanelBatchProps) {
  useI18n();
  const [scope, setScope] = useState<'page' | 'document'>('page');
  const [task, setTask] = useState<LongTaskRecord<BatchPayload, BatchResult> | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');
  const [applyingBlockId, setApplyingBlockId] = useState<string | null>(null);
  const [appliedBatchIds, setAppliedBatchIds] = useState<Set<string>>(() => new Set());

  useEffect(() => setAppliedBatchIds(new Set()), [task?.id]);

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
            const restoredScope = (restored.scope as { scope?: string } | null)?.scope;
            if (restoredScope === 'page' || restoredScope === 'document') setScope(restoredScope);
            if (restored.baseRevision !== currentDocRef.current.revision) {
              setStatusText('Document changed. Refresh before requesting more translations; existing results may still be written to unchanged source blocks.');
            } else if (restored.sourceIds.length !== 1 && restored.batches.some(batch => !batch.payload.sourceId)) {
              setStatusText('Previous task has no per-block source mapping. Reset to start a new task.');
            } else if (restored.status === 'completed') {
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
    if (disabled || busy || task?.status === 'running' || (task && !staleTask) || !runnerRef.current || !storeRef.current) return;
    setError('');
    setBusy(true);
    setStatusText('Collecting text blocks…');

    try {
      const taskScope = task && staleTask ? (task.scope as { scope?: 'page' | 'document' })?.scope ?? scope : scope;
      const pageIds = taskScope === 'document' ? document.pageOrder
        : [task && staleTask ? task.batches[0]?.payload.pageId ?? page.id : page.id];
      if (pageIds.some(pageId => !document.pageOrder.includes(pageId))) {
        throw new Error('Original page no longer exists; reset to start a new translation');
      }
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
            sourceId: batchSourceId(document.sourceIds, item.block.sourceId),
            range: [0, text.length] as [number, number],
            originalText: text,
          },
        };
      });

      if (currentDocRef.current.id !== document.id || currentDocRef.current.revision !== document.revision) {
        throw new Error('Document changed while collecting text; start translation again from the current revision');
      }

      const newTask = await createLongTask<BatchPayload, BatchResult>({
        id: `translate-${document.id}-${Date.now()}`,
        docId: document.id,
        baseRevision: document.revision,
        sourceIds: document.sourceIds,
        taskType: 'document.translate',
        scope: { scope: taskScope, pageCount: pageIds.length },
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
      const savedTask = await storeRef.current.loadTask(taskId);
      if (!savedTask) throw new Error('Saved translation task not found');
      if (currentDocRef.current.id !== savedTask.docId || currentDocRef.current.revision !== savedTask.baseRevision) {
        throw new Error('Document revision has changed; previous translation is read-only. Start a new task.');
      }
      for (const batch of savedTask.batches) {
        if (batch.status === 'pending' || batch.status === 'paused') {
          batchSourceId(savedTask.sourceIds, batch.payload.sourceId);
        }
      }
      const finished = await runnerRef.current.continueTask(
        taskId,
        authorization,
        async (_task, batch: Readonly<LongTaskBatch<BatchPayload, BatchResult>>, signal: AbortSignal) => {
          if (currentDocRef.current.id !== _task.docId || currentDocRef.current.revision !== _task.baseRevision) {
            await runnerRef.current?.pauseTask(taskId);
            throw new Error('Document changed during translation');
          }
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
              sourceId: batchSourceId(_task.sourceIds, batch.payload.sourceId),
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
          if (currentDocRef.current.id !== _task.docId || currentDocRef.current.revision !== _task.baseRevision) {
            await runnerRef.current?.pauseTask(taskId);
            throw new Error('Document changed during translation');
          }

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

          return { translatedText };
        },
        updated => {
          if (isMountedRef.current && currentDocRef.current.id === updated.docId) {
            setTask({ ...updated });
          }
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

  const writeBlocks = async (batches: LongTaskBatch<BatchPayload, BatchResult>[]) => {
    if (!task || disabled || applyingBlockId || busy || !batches.length) return;
    const currentDocument = currentDocRef.current;
    setApplyingBlockId(batches.length === 1 ? batches[0]!.id : 'all');
    setError('');

    try {
      if (currentDocument.id !== task.docId) throw new Error('Translation belongs to another document');
      const revision = currentDocument.revision;
      const pageBlocks = new Map<string, TextBlock[]>();
      const commands: { pageId: string; blockId: string; range: [number, number]; text: string }[] = [];
      for (const batch of batches) {
        if (!batch.result || !currentDocument.pageOrder.includes(batch.payload.pageId)) {
          throw new Error('The translated block no longer belongs to this document');
        }
        const sourceId = batchSourceId(task.sourceIds, batch.payload.sourceId);
        if (!currentDocument.sourceIds.includes(sourceId)) throw new Error('Translated block source is no longer available');
        let blocks = pageBlocks.get(batch.payload.pageId);
        if (!blocks) {
          blocks = await engine.extract({ docId: currentDocument.id, pageIds: [batch.payload.pageId] });
          pageBlocks.set(batch.payload.pageId, blocks);
        }
        const target = blocks.find(block => block.id === batch.payload.blockId);
        if (!target || batchSourceId(currentDocument.sourceIds, target.sourceId) !== sourceId ||
            target.runs.map(run => run.text).join('') !== batch.payload.originalText) {
          throw new Error('A translated block changed; refresh its translation before writing');
        }
        const layout = await engine.previewText({
          docId: currentDocument.id, pageId: batch.payload.pageId, blockId: batch.payload.blockId,
          range: batch.payload.range, text: batch.result.translatedText,
        });
        if (layout.overflow) throw new Error('A translated block overflows its text box; shorten it before writing');
        commands.push({ pageId: batch.payload.pageId, blockId: batch.payload.blockId,
          range: batch.payload.range, text: batch.result.translatedText });
      }
      if (currentDocRef.current.id !== task.docId || currentDocRef.current.revision !== revision) {
        throw new Error('Document changed while measuring translation; check the blocks again before writing');
      }
      await onApplyBlocks(commands);
      setAppliedBatchIds(previous => new Set([...previous, ...batches.map(batch => batch.id)]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to write translation to PDF');
    } finally {
      if (isMountedRef.current) setApplyingBlockId(null);
    }
  };

  const completedCount = task?.batches.filter(b => b.status === 'completed').length ?? 0;
  const totalCount = task?.batches.length ?? 0;
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const isRunning = busy || task?.status === 'running';
  const staleTask = Boolean(task && (task.docId !== document.id || task.baseRevision !== document.revision));
  const missingBatchSource = Boolean(task && task.sourceIds.length !== 1 && task.batches.some(batch => !batch.payload.sourceId));

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
          />{t("Current Page")}</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
          <input
            type="radio"
            name="batch-scope"
            checked={scope === 'document'}
            onChange={() => setScope('document')}
            disabled={disabled || isRunning}
          />{t("Entire Document (")}{document.pageOrder.length} {t("pages)")}</label>
      </div>

      {(!task || staleTask) && (
        <button
          type="button"
          className="button-primary"
          onClick={() => void startTask()}
          disabled={disabled || isRunning}
        >
          {busy ? t("Preparing batch task…") : staleTask ? t("Refresh changed blocks") : `Start Translation (${scope === 'page' ? t("Current Page") : t("Full Document")})`}
        </button>
      )}

      {task && (
        <div style={{ display: 'grid', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
            <span>{t("Progress:")} {completedCount}/{totalCount} {t("batches (")}{percent}%)
            </span>
            <span style={{ fontWeight: 600 }}>{t("Status:")} {task.status}</span>
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
              <button type="button" onClick={() => void pauseTask()} style={{ flex: 1 }}>{t("Pause")}</button>
            )}
            {!isRunning && task.status !== 'completed' && task.status !== 'cancelled' && (
              <button type="button" onClick={() => void resumeTask()} disabled={disabled || staleTask || missingBatchSource} style={{ flex: 1 }}>{t("Resume")}</button>
            )}
            <button
              type="button"
              onClick={() => void cancelTask()}
              disabled={disabled || isRunning}
              style={{ flex: 1 }}
            >{t("Reset Task")}</button>
          </div>
        </div>
      )}

      {error && <p role="alert" style={{ color: '#ff623d' }}>{t(error)}</p>}
      {staleTask && <p role="status">{t("Document revision changed. Refresh before requesting more translations; completed blocks can still be written if their source and original text are unchanged.")}</p>}
      {missingBatchSource && <p role="alert">{t("Per-block source mapping is missing; reset to start a new task.")}</p>}
      {statusText && <p style={{ fontSize: '10px', color: '#666' }}>{t(statusText)}</p>}

      {task && task.batches.some(b => b.status === 'completed') && (
        <div style={{ display: 'grid', gap: '8px', maxHeight: '280px', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>{t("Translated Blocks")}</strong>
            <button type="button" onClick={() => void writeBlocks(task.batches.filter(batch => batch.status === 'completed' && batch.result && !appliedBatchIds.has(batch.id)))}
              disabled={disabled || isRunning || applyingBlockId !== null || task.docId !== document.id ||
                !task.batches.some(batch => batch.status === 'completed' && batch.result && !appliedBatchIds.has(batch.id))}>{t("Write remaining (one undo)")}</button>
          </div>
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
                  <span>P.{batch.payload.pageNumber} {t("· Block")} {batch.payload.blockId}</span>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      type="button"
                      onClick={() => onLocate?.(batch.payload.pageId, batch.payload.blockId)}
                      style={{ fontSize: '9px', padding: '1px 4px' }}
                    >{t("Locate")}</button>
                    <button
                      type="button"
                      onClick={() => void writeBlocks([batch])}
                      disabled={disabled || task.docId !== document.id || applyingBlockId !== null || isRunning || appliedBatchIds.has(batch.id)}
                      style={{ fontSize: '9px', padding: '1px 6px', fontWeight: 600 }}
                    >
                      {applyingBlockId === batch.id ? t("Writing…") : appliedBatchIds.has(batch.id) ? t("Applied") : t("Write to PDF")}
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
