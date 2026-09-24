import React, { useEffect, useRef, useState } from 'react';
import {
  type AiFeature,
  type AiRequest,
  type CommandType,
  type CommitResult,  type DocumentInfo,
  type EditTransaction,
  type EngineAdapter,
  type FormFieldInfo,
  type PageModel,
  type Rect,
  type TextBlock,
} from '@pdf-editor/contracts';
import {
  AiWorkflow,
  DocumentAiAuthorization,
  createEvidenceSnapshot,
  createTransactionPreview,
  resolveCitation,
  type AiWorkflowResult,
  type EvidenceSnapshot,
  type LocalEvidenceSource,
  type TransactionPreview,
} from '@pdf-editor/ai-client';
import { CommandRegistry, createAiTransaction } from '@pdf-editor/commands';
import { useFontResources } from './font-resources.js';
import { AiPanelCandidates, type CandidateItem } from './AiPanelCandidates.js';
import { AiPanelExtraction } from './AiPanelExtraction.js';
import { AiPanelBatch } from './AiPanelBatch.js';
import { captureRegionImage } from './AiPanelImage.js';
import { AiPanelForm, type FormSuggestionItem } from './AiPanelForm.js';
import { analyzeFullDocument, collectDocumentPassages, isExhaustiveQuestion, selectRelevantPassages,
  type DocumentAnalysis, type DocumentPassage } from './document-ai-context.js';

type Props = {
  document: DocumentInfo | null;
  page: PageModel | null;
  selectedIds: string[];
  engine: EngineAdapter;
  onCommitted(result: CommitResult): Promise<void>;
  endpoint?: string;
  onLocate?(pageId: string, blockId: string): void;
  disabled?: boolean;
  onBusyChange?(busy: boolean): void;
};

export type FeatureConfig = {
  id: AiFeature;
  label: string;
  description: string;
  nativeReady: boolean;
};

const FEATURES: FeatureConfig[] = [
  { id: 'text.translate', label: 'Translate Selected Text (A01)', description: 'Translate selected text while preserving numbers and proper names', nativeReady: true },
  { id: 'text.proofread', label: 'Proofread & Polish (A02)', description: 'Spot typos and grammar issues with replacement suggestions and reasons', nativeReady: true },
  { id: 'text.rewrite', label: 'Rewrite & Tone (A03)', description: 'Rewrite in formal, concise, casual, professional, or academic style', nativeReady: true },
  { id: 'text.fit', label: 'Fit to Text Box (A04)', description: 'Shorten text to fit box dimensions with real font layout verification', nativeReady: true },
  { id: 'commands.plan', label: 'Natural Language Commands (A05)', description: 'Plan rotate, delete, or formatting edits via natural language', nativeReady: true },
  { id: 'document.ask', label: 'Ask with Citations (A06)', description: 'Ask questions grounded in frozen evidence with clickable page citations', nativeReady: true },
  { id: 'document.summarize', label: 'Summarize & Outline (A07)', description: 'Generate executive summary and reading outline with source citations', nativeReady: true },
  { id: 'document.translate', label: 'Batch Reading Translation (A08)', description: 'Translate multi-page document in batches with side-by-side writeback', nativeReady: true },
  { id: 'document.extract', label: 'Structured Extraction (A09)', description: 'Extract fields, dates, amounts, and tables with CSV export', nativeReady: true },
  { id: 'form.suggest', label: 'Form Filling Suggestions (A10)', description: 'Suggest form values from document context and map to AcroForm fields', nativeReady: true },
  { id: 'blocks.organize', label: 'Organize Text Blocks (A11)', description: 'Propose alignment, font consistency, and layout adjustments for text blocks', nativeReady: true },
  { id: 'image.explain', label: 'Explain Diagram or Chart (A12)', description: 'Explain cropped chart or diagram using vision understanding', nativeReady: true },
];

const TONE_OPTIONS = [
  { id: 'formal', label: 'Formal & Rigorous' },
  { id: 'concise', label: 'Concise & Direct' },
  { id: 'casual', label: 'Casual & Accessible' },
  { id: 'professional', label: 'Professional' },
  { id: 'academic', label: 'Academic' },
];

export function AiPanel(props: Props) {
  const current = useRef(props);
  current.current = props;

  const [authorization] = useState(() => (props.document ? new DocumentAiAuthorization(props.document.id) : null));
  const [enabled, setEnabled] = useState(false);
  const [feature, setFeature] = useState<AiFeature>('text.translate');
  const [instruction, setInstruction] = useState('');
  const [language, setLanguage] = useState('English');
  const [tone, setTone] = useState('concise');
  const [targetCharLength, setTargetCharLength] = useState<number | ''>('');
  const [askScope, setAskScope] = useState<'selection' | 'page' | 'document'>('page');
  const [scanAllPages, setScanAllPages] = useState(false);
  const [analysis, setAnalysis] = useState<DocumentAnalysis | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState('');
  const [retrievalNote, setRetrievalNote] = useState('');
  const [fontId, setFontId] = useState('');

  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [delta, setDelta] = useState('');

  const [outcome, setOutcome] = useState<AiWorkflowResult<CommitResult> | null>(null);
  const [snapshot, setSnapshot] = useState<EvidenceSnapshot | null>(null);
  const [workflowInstance, setWorkflowInstance] = useState<AiWorkflow<CommitResult> | null>(null);

  const [candidateItems, setCandidateItems] = useState<CandidateItem[]>([]);
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<Set<string>>(new Set());

  const [commandPlanPreview, setCommandPlanPreview] = useState<TransactionPreview<CommitResult> | null>(null);

  // A10 表单状态
  const [formItems, setFormItems] = useState<FormSuggestionItem[]>([]);
  const [selectedFormIds, setSelectedFormIds] = useState<Set<string>>(new Set());
  const [rawFormCommands, setRawFormCommands] = useState<{ fieldId: string; value: string | boolean | string[] }[]>([]);

  const controller = useRef<AbortController | null>(null);
  const { fonts, error: fontError } = useFontResources();

  useEffect(() => () => {
    authorization?.revoke();
    controller.current?.abort();
  }, [authorization]);

  const authorize = () => {
    if (!authorization || !props.document) return;
    authorization.enable(props.document.sourceIds);
    setEnabled(true);
  };

  const revoke = () => {
    controller.current?.abort();
    authorization?.revoke();
    setEnabled(false);
    resetResults();
  };

  const resetResults = () => {
    setError('');
    setDelta('');
    setOutcome(null);
    setSnapshot(null);
    setCandidateItems([]);
    setSelectedEvidenceIds(new Set());
    setCommandPlanPreview(null);
    setFormItems([]);
    setSelectedFormIds(new Set());
    setRawFormCommands([]);
    setAnalysis(null);
    setAnalysisProgress('');
    setRetrievalNote('');
  };

  const needsSourceConsent = Boolean(
    authorization &&
      props.document &&
      authorization.missingSourceIds(props.document.sourceIds).length > 0,
  );

  const activeFeatureConfig = FEATURES.find(f => f.id === feature) ?? FEATURES[0]!;

  const checkSingleLayout = async (
    docId: string,
    pageId: string,
    blockId: string,
    range: [number, number],
    text: string,
    selectedFontId?: string,
  ): Promise<'fits' | 'overflow' | 'unavailable'> => {
    try {
      const layout = await props.engine.previewText({
        docId,
        pageId,
        blockId,
        range,
        text,
        ...(selectedFontId ? { style: { fontId: selectedFontId } } : {}),
      });
      return layout.overflow ? 'overflow' : 'fits';
    } catch {
      return 'unavailable';
    }
  };

  const buildCommandContext = async (transaction: EditTransaction) => {
    const { document: info, page: pageItem } = current.current;
    if (!info || !pageItem) throw new Error('Document is closed');
    const pagesMap = new Map<string, PageModel>([[pageItem.id, pageItem]]);
    for (const cmd of transaction.commands) {
      if ('pageId' in cmd && !pagesMap.has(cmd.pageId)) {
        const loaded = await props.engine.describePage(info.id, cmd.pageId);
        pagesMap.set(cmd.pageId, loaded);
      }
      if ('pageIds' in cmd) {
        for (const pid of cmd.pageIds) {
          if (!pagesMap.has(pid)) {
            const loaded = await props.engine.describePage(info.id, pid);
            pagesMap.set(pid, loaded);
          }
        }
      }
    }
    const allFields = props.engine.describeForms ? await props.engine.describeForms(info.id) : [];
    const fieldsMap = new Map(
      allFields.map(f => [
        f.id,
        {
          pageId: f.widgets[0]?.pageId ?? pageItem.id,
          type: f.type,
          options: f.options,
          readOnly: f.readOnly,
        },
      ]),
    );
    return {
      document: info,
      pages: pagesMap,
      fields: fieldsMap,
      ...(fonts.length ? { fontIds: new Set(fonts.map(f => f.id)) } : {}),
    };
  };

  const run = async () => {
    if (!authorization || !props.document || !props.page || controller.current || props.disabled) return;
    if (!activeFeatureConfig.nativeReady) {
      setError('This feature requires native commands that are not yet available.');
      return;
    }

    setBusy(true);
    resetResults();
    const abort = new AbortController();
    controller.current = abort;

    try {
      const document = props.document;
      const currentPage = props.page;
      if (askScope === 'document' && (feature === 'document.summarize' ||
        (feature === 'document.ask' && (scanAllPages || isExhaustiveQuestion(instruction))))) {
        setAnalysis(await analyzeFullDocument({
          engine: props.engine, document, authorization,
          endpoint: props.endpoint ?? '/api/v1/ai/requests', feature,
          instruction: instruction.trim() || defaultInstructionFor(feature, tone), signal: abort.signal,
          currentDocument: () => {
            const info = current.current.document;
            if (!info) throw new Error('Document closed during analysis');
            return { id: info.id, revision: info.revision };
          },
          onProgress: setAnalysisProgress,
        }));
        setAnalysisProgress('');
        return;
      }

      // A10 Form handling
      let pageFormFields: FormFieldInfo[] = [];
      if (feature === 'form.suggest') {
        if (!document.permissions.fillForms) {
          throw new Error('This document does not permit form filling');
        }
        const allFields = props.engine.describeForms ? await props.engine.describeForms(document.id) : [];
        pageFormFields = allFields.filter(f => f.widgets.some(w => w.pageId === currentPage.id) && !f.readOnly);
        if (pageFormFields.length === 0) {
          throw new Error('No editable form fields found on current page');
        }
      }

      let evidenceBlocks: TextBlock[] = [];
      let rankedPassages: DocumentPassage[] | null = null;
      const pageScopeId = currentPage.id;
      let effectiveScope: 'selection' | 'page' | 'document' = 'page';

      if (feature === 'document.ask' || feature === 'document.summarize') {
        effectiveScope = askScope;
        if (askScope === 'selection' && props.selectedIds.length) {
          const selected = currentPage.objects.filter(obj => props.selectedIds.includes(obj.id));
          evidenceBlocks = [...new Map(selected.flatMap(obj => (obj.textBlock ? [[obj.textBlock.id, obj.textBlock] as const] : []))).values()];
        } else if (askScope === 'document') {
          setAnalysisProgress('Searching document locally…');
          const passages = await collectDocumentPassages(props.engine, document, abort.signal);
          rankedPassages = selectRelevantPassages(passages, instruction.trim());
          if (!rankedPassages.length) throw new Error('No matching text found. Try other search terms or enable Scan every page.');
          setRetrievalNote(`Searched ${document.pageOrder.length} pages; selected ${rankedPassages.length} relevant passages from ${passages.length}. This answer is not exhaustive.`);
          setAnalysisProgress('');
        } else {
          evidenceBlocks = [...new Map(currentPage.objects.flatMap(obj => (obj.textBlock ? [[obj.textBlock.id, obj.textBlock] as const] : []))).values()];
        }
      } else {
        const selected = props.selectedIds.length
          ? currentPage.objects.filter(obj => props.selectedIds.includes(obj.id))
          : currentPage.objects;
        evidenceBlocks = [...new Map(selected.flatMap(obj => (obj.textBlock ? [[obj.textBlock.id, obj.textBlock] as const] : []))).values()];
        effectiveScope = props.selectedIds.length ? 'selection' : 'page';
      }

      if (feature !== 'image.explain' && feature !== 'form.suggest' && evidenceBlocks.length === 0 && !rankedPassages?.length) {
        throw new Error('No extractable text in current scope. For scanned documents, use desktop local OCR.');
      }

      const evidence = rankedPassages ? rankedPassages.map((passage, index) => ({
        id: `e${index + 1}`, docId: document.id, revision: document.revision,
        pageId: passage.pageId, pageNumber: passage.pageNumber, blockId: passage.blockId,
        text: passage.text, characterRange: passage.range, bounds: passage.bounds,
      })) : evidenceBlocks.map((block, index) => ({
        id: `e${index + 1}`,
        docId: document.id,
        revision: document.revision,
        pageId: block.pageId || pageScopeId,
        pageNumber: document.pageOrder.indexOf(block.pageId || pageScopeId) + 1,
        blockId: block.id,
        text: block.runs.map(run => run.text).join(''),
        bounds: [block.bounds.x, block.bounds.y, block.bounds.width, block.bounds.height] as [number, number, number, number],
      }));

      const totalCharacters = evidence.reduce((sum, item) => sum + Array.from(item.text).length, 0);
      const charBudget = feature === 'document.ask' || feature === 'document.summarize' ? 36_000 : 8_000;
      if (totalCharacters > charBudget) {
        throw new Error(`Text exceeds single request budget (${totalCharacters} > ${charBudget} characters). Please narrow selection or use batch reading translation.`);
      }

      const localSources: LocalEvidenceSource[] = rankedPassages ? rankedPassages.map((passage, index) => ({
        evidenceId: evidence[index]!.id, sourceId: passage.sourceId, blockText: passage.blockText,
      })) : evidenceBlocks.map((block, index) => {
        const sourceId = block.sourceId ?? (document.sourceIds.length === 1 ? document.sourceIds[0] : undefined);
        if (!sourceId || !document.sourceIds.includes(sourceId)) {
          throw new Error('Text block missing source mapping, cannot determine AI authorization scope');
        }
        return { evidenceId: evidence[index]!.id, sourceId, blockText: evidence[index]!.text };
      });

      let requestImages: { mimeType: 'image/png'; data: string }[] | undefined;
      if (feature === 'image.explain') {
        let clipBounds: Rect | undefined;
        const selectedObjects = props.selectedIds.length
          ? currentPage.objects.filter(obj => props.selectedIds.includes(obj.id))
          : [];
        if (selectedObjects.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const obj of selectedObjects) {
            minX = Math.min(minX, obj.bounds.x);
            minY = Math.min(minY, obj.bounds.y);
            maxX = Math.max(maxX, obj.bounds.x + obj.bounds.width);
            maxY = Math.max(maxY, obj.bounds.y + obj.bounds.height);
          }
          if (minX < maxX && minY < maxY) {
            clipBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
          }
        }
        const pngBase64 = await captureRegionImage(props.engine, document.id, currentPage.id, clipBounds);
        requestImages = [{ mimeType: 'image/png', data: pngBase64 }];
      }

      const availableCommands = feature === 'commands.plan'
        ? ['pages.rotate', 'pages.crop', 'pages.delete', 'pages.reorder', 'objects.delete', 'objects.align', 'objects.distribute', 'objects.transform', 'text.style']
        : feature === 'blocks.organize'
          ? ['text.style', 'text.reflow', 'objects.align', 'objects.distribute', 'objects.transform', 'objects.delete']
          : feature === 'form.suggest'
            ? ['form.fill']
            : undefined;

      const advertisedCommands = availableCommands?.filter(command => document.capabilities.includes(command as CommandType));

      if (feature === 'blocks.organize' && !props.selectedIds.length) {
        throw new Error('Select text blocks or other objects to organize before asking AI');
      }
      const objectsMetadata = (feature === 'commands.plan' || feature === 'blocks.organize')
        ? currentPage.objects.filter(obj => feature !== 'blocks.organize' || props.selectedIds.includes(obj.id)).map(obj => ({
            id: obj.id,
            pageId: obj.pageId,
            type: obj.type,
            blockId: obj.textBlock?.id,
            style: obj.textBlock?.runs[0]?.style,
          }))
        : undefined;

      const pagesMetadata = feature === 'commands.plan'
        ? document.pageOrder.map((id, idx) => ({ id, pageNumber: idx + 1 }))
        : undefined;

      const request: AiRequest = {
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        feature,
        document: { id: document.id, revision: document.revision },
        context: {
          scope: effectiveScope,
          evidence,
          ...(requestImages ? { images: requestImages } : {}),
          ...(advertisedCommands ? { availableCommands: advertisedCommands } : {}),
          ...(objectsMetadata ? { objects: objectsMetadata } : {}),
          ...(pagesMetadata ? { pages: pagesMetadata } : {}),
          ...(pageFormFields.length > 0 ? {
            fields: pageFormFields.map(f => ({
              id: f.id,
              name: f.name,
              type: f.type,
              options: f.options,
            })),
          } : {}),
          ...(fonts.length ? { availableFontIds: fonts.map(f => f.id) } : {}),
        },
        instruction: instruction.trim() || defaultInstructionFor(feature, tone),
        options: {
          targetLanguage: language,
          preserveNumbers: true,
          ...(feature === 'text.rewrite' ? { tone } : {}),
          ...(feature === 'text.fit' && targetCharLength ? { targetCharacters: Number(targetCharLength), tone: 'concise' } : {}),
        },
      };

      const frozen = createEvidenceSnapshot(request, localSources);
      setSnapshot(frozen);

      const registry = new CommandRegistry(props.engine);
      const getCurrentDocument = () => {
        const info = current.current.document;
        if (!info) throw new Error('Document is closed');
        return { id: info.id, revision: info.revision };
      };

      const apply = async (transaction: EditTransaction) => {
        const ctx = await buildCommandContext(transaction);
        return registry.execute(transaction, ctx);
      };

      const buildCommandPlanTransaction = (
        req: AiRequest,
        resp: typeof outcome extends { response: infer R } ? R : any,
        _snap: EvidenceSnapshot,
        txId: string,
      ) => {
        const { document: info, page: pageItem } = current.current;
        if (!info || !pageItem) throw new Error('Document is closed');
        const fieldsMap = new Map(pageFormFields.map(f => [f.id, {
          pageId: f.widgets[0]?.pageId ?? pageItem.id,
          type: f.type,
          options: f.options,
          readOnly: f.readOnly,
        }]));
        const ctx = {
          document: info,
          pages: new Map([[pageItem.id, pageItem]]),
          fields: fieldsMap,
          ...(fonts.length ? { fontIds: new Set(fonts.map(f => f.id)) } : {}),
        };
        return createAiTransaction(req, resp, ctx, txId, feature === 'blocks.organize' ? fontId || undefined : undefined);
      };

      const workflow = new AiWorkflow<CommitResult>({
        endpoint: props.endpoint ?? '/api/v1/ai/requests',
        authorization,
        getCurrentDocument,
        apply,
        nextTransactionId: () => crypto.randomUUID(),
        buildCommandPlanTransaction,
      });
      setWorkflowInstance(workflow);

      const rawResult = await workflow.run({
        request,
        snapshot: frozen,
        sourceIds: document.sourceIds,
        signal: abort.signal,
        onDelta: text => setDelta(prev => prev + text),
      });

      setOutcome(rawResult);

      if (rawResult.response.result.kind === 'textProposal') {
        const replacements = rawResult.response.result.replacements;
        const initialItems: CandidateItem[] = replacements.map(r => ({
          ...r,
          layoutState: 'checking',
        }));
        setCandidateItems(initialItems);
        setSelectedEvidenceIds(new Set(replacements.map(r => r.targetEvidenceId)));

        const checkedItems = await Promise.all(
          initialItems.map(async item => {
            const ev = frozen.get(item.targetEvidenceId);
            if (!ev) return { ...item, layoutState: 'unavailable' as const };
            const state = await checkSingleLayout(
              document.id,
              ev.evidence.pageId,
              ev.evidence.blockId,
              [ev.sourceRange[0], ev.sourceRange[1]],
              item.text,
              fontId || undefined,
            );
            return { ...item, layoutState: state };
          }),
        );
        setCandidateItems(checkedItems);
      } else if (rawResult.response.result.kind === 'commandPlan') {
        if (feature === 'form.suggest') {
          const formCmds = rawResult.response.result.commands.filter(
            (c): c is Extract<typeof c, { type: 'form.fill' }> =>
              c.type === 'form.fill' && pageFormFields.some(f => f.id === c.fieldId),
          );
          setRawFormCommands(formCmds.map(c => ({ fieldId: c.fieldId, value: c.value })));
          const items: FormSuggestionItem[] = formCmds.map(c => {
            const f = pageFormFields.find(field => field.id === c.fieldId)!;
            return {
              fieldId: f.id,
              fieldName: f.name,
              fieldType: f.type,
              currentValue: f.value,
              suggestedValue: c.value,
              required: f.required,
            };
          });
          setFormItems(items);
          setSelectedFormIds(new Set(items.map(i => i.fieldId)));
        } else if (rawResult.preview) {
          await props.engine.previewTransaction(rawResult.preview.transaction);
          setCommandPlanPreview(rawResult.preview);
        }
      }
    } catch (caught) {
      setError(abort.signal.aborted ? 'Request cancelled' : caught instanceof Error ? caught.message : 'AI request failed');
    } finally {
      controller.current = null;
      setAnalysisProgress('');
      setBusy(false);
    }
  };

  const toggleEvidence = (evidenceId: string) => {
    setSelectedEvidenceIds(prev => {
      const next = new Set(prev);
      if (next.has(evidenceId)) next.delete(evidenceId);
      else next.add(evidenceId);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedEvidenceIds(new Set(candidateItems.map(c => c.targetEvidenceId)));
  };

  const deselectAll = () => {
    setSelectedEvidenceIds(new Set());
  };

  const handleApplySingle = async (evidenceId: string) => {
    if (!outcome || !snapshot || !workflowInstance || applying || props.disabled) return;
    setApplying(true);
    props.onBusyChange?.(true);
    setError('');
    try {
      const preview = workflowInstance.createSubsetPreview(snapshot, outcome.response, [evidenceId]);
      const finalPreview = fontId
        ? createTransactionPreview(
            preview.response,
            withReplacementFont(preview.transaction, fontId),
            () => ({ id: props.document!.id, revision: props.document!.revision }),
            preview.accept,
          )
        : preview;
      const res = await finalPreview.accept();
      await props.onCommitted(res);
      setSelectedEvidenceIds(prev => {
        const next = new Set(prev);
        next.delete(evidenceId);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Application of single candidate failed');
    } finally {
      props.onBusyChange?.(false);
      setApplying(false);
    }
  };

  const handleApplySelected = async () => {
    if (!outcome || !snapshot || !workflowInstance || applying || props.disabled) return;
    if (selectedEvidenceIds.size === 0) return;
    setApplying(true);
    props.onBusyChange?.(true);
    setError('');
    try {
      const preview = workflowInstance.createSubsetPreview(snapshot, outcome.response, selectedEvidenceIds);
      const finalPreview = fontId
        ? createTransactionPreview(
            preview.response,
            withReplacementFont(preview.transaction, fontId),
            () => ({ id: props.document!.id, revision: props.document!.revision }),
            preview.accept,
          )
        : preview;
      const res = await finalPreview.accept();
      await props.onCommitted(res);
      setSelectedEvidenceIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch application failed');
    } finally {
      props.onBusyChange?.(false);
      setApplying(false);
    }
  };

  const handleApplyCommandPlan = async () => {
    if (!commandPlanPreview || applying || props.disabled) return;
    setApplying(true);
    props.onBusyChange?.(true);
    setError('');
    try {
      const res = await commandPlanPreview.accept();
      await props.onCommitted(res);
      setCommandPlanPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply command plan');
    } finally {
      props.onBusyChange?.(false);
      setApplying(false);
    }
  };

  const handleApplySingleFormField = async (fieldId: string) => {
    if (!props.document || applying || props.disabled) return;
    if (!props.document.permissions.fillForms) {
      setError('This document does not permit form filling');
      return;
    }
    const cmd = rawFormCommands.find(c => c.fieldId === fieldId);
    if (!cmd) return;
    setApplying(true);
    props.onBusyChange?.(true);
    setError('');
    try {
      const transaction: EditTransaction = {
        id: crypto.randomUUID(),
        docId: props.document.id,
        baseRevision: props.document.revision,
        source: 'ai',
        commands: [{ type: 'form.fill', fieldId: cmd.fieldId, value: cmd.value }],
      };
      if (props.engine.previewTransaction) {
        await props.engine.previewTransaction(transaction);
      }
      const ctx = await buildCommandContext(transaction);
      const registry = new CommandRegistry(props.engine);
      const res = await registry.execute(transaction, ctx);
      await props.onCommitted(res);
      setSelectedFormIds(prev => {
        const next = new Set(prev);
        next.delete(fieldId);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply form value');
    } finally {
      props.onBusyChange?.(false);
      setApplying(false);
    }
  };

  const handleApplySelectedFormFields = async () => {
    if (!props.document || applying || props.disabled || selectedFormIds.size === 0) return;
    if (!props.document.permissions.fillForms) {
      setError('This document does not permit form filling');
      return;
    }
    setApplying(true);
    props.onBusyChange?.(true);
    setError('');
    try {
      const selectedCommands = rawFormCommands
        .filter(c => selectedFormIds.has(c.fieldId))
        .map(c => ({ type: 'form.fill' as const, fieldId: c.fieldId, value: c.value }));
      if (selectedCommands.length === 0) return;
      const transaction: EditTransaction = {
        id: crypto.randomUUID(),
        docId: props.document.id,
        baseRevision: props.document.revision,
        source: 'ai',
        commands: selectedCommands,
      };
      if (props.engine.previewTransaction) {
        await props.engine.previewTransaction(transaction);
      }
      const ctx = await buildCommandContext(transaction);
      const registry = new CommandRegistry(props.engine);
      const res = await registry.execute(transaction, ctx);
      await props.onCommitted(res);
      setSelectedFormIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply form values');
    } finally {
      props.onBusyChange?.(false);
      setApplying(false);
    }
  };

  const handleApplyBatchBlock = async (pageId: string, blockId: string, range: [number, number], text: string) => {
    if (!props.document || applying || props.disabled) return;
    setApplying(true);
    props.onBusyChange?.(true);
    setError('');
    try {
      const registry = new CommandRegistry(props.engine);
      const pageModel = props.page?.id === pageId ? props.page : await props.engine.describePage(props.document.id, pageId);
      const transaction: EditTransaction = {
        id: crypto.randomUUID(),
        docId: props.document.id,
        baseRevision: props.document.revision,
        source: 'ai',
        commands: [{ type: 'text.replace', pageId, blockId, range, text }],
      };
      const res = await registry.execute(transaction, {
        document: props.document,
        pages: new Map([[pageId, pageModel]]),
      });
      await props.onCommitted(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to write translation to PDF');
    } finally {
      props.onBusyChange?.(false);
      setApplying(false);
    }
  };

  const result = outcome?.response.result;
  const stale = Boolean(
    outcome &&
      props.document &&
      (outcome.response.document.id !== props.document.id ||
        outcome.response.document.baseRevision !== props.document.revision),
  );
  const answerText = analysis?.overview ?? (result?.kind === 'answer' ? result.text : delta);

  return (
    <section className="ai-composer" aria-label="komo AI">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="eyebrow">komo AI</span>
        <small style={{ color: '#888', fontSize: '9px' }}>komopdf.com</small>
      </div>

      {!enabled ? (
        <div style={{ display: 'grid', gap: '8px' }}>
          <p style={{ fontSize: '11px', lineHeight: 1.55 }}>
            To use AI features for this document, necessary text or selected chart images will be sent to the AI service. Normal viewing, editing, and saving remain local on your device; full-document summary and translation send relevant text in batches. You can revoke AI authorization for this document at any time.
          </p>
          <button
            type="button"
            className="button-primary"
            disabled={!props.document || props.disabled}
            onClick={authorize}
          >
            Enable AI for this document
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', color: '#445b0a', fontWeight: 600 }}>✓ AI enabled for this document</span>
            <button
              type="button"
              onClick={revoke}
              style={{ fontSize: '9px', padding: '2px 6px', background: 'transparent', border: '1px solid #c2c1ba' }}
            >
              Revoke authorization
            </button>
          </div>

          {needsSourceConsent && (
            <div
              style={{
                padding: '6px',
                background: '#ffe0d8',
                borderLeft: '3px solid #ff623d',
                fontSize: '10px',
                display: 'grid',
                gap: '4px',
              }}
            >
              <span>Document has new sources. Authorize new sources to include them in AI requests.</span>
              <button type="button" onClick={authorize} style={{ fontSize: '9px', padding: '2px 6px' }}>
                Authorize new sources
              </button>
            </div>
          )}

          <label>
            Capability
            <select
              value={feature}
              onChange={e => {
                setFeature(e.target.value as AiFeature);
                resetResults();
              }}
              disabled={props.disabled || busy}
            >
              {FEATURES.map(f => (
                <option key={f.id} value={f.id}>
                  {f.label} {!f.nativeReady ? '(Native unready)' : ''}
                </option>
              ))}
            </select>
          </label>

          <p style={{ fontSize: '10px', color: '#666', margin: 0 }}>
            {activeFeatureConfig.description}
          </p>

          {(feature === 'text.translate' || feature === 'document.translate') && (
            <label>
              Target language
              <input
                value={language}
                onChange={e => setLanguage(e.target.value)}
                placeholder="e.g. English, French, Spanish, Chinese"
                disabled={props.disabled || busy}
              />
            </label>
          )}

          {feature === 'text.rewrite' && (
            <label>
              Tone & Style
              <select
                value={tone}
                onChange={e => setTone(e.target.value)}
                disabled={props.disabled || busy}
              >
                {TONE_OPTIONS.map(opt => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {feature === 'text.fit' && (
            <label>
              Target maximum characters (optional, layout verified locally)
              <input
                type="number"
                value={targetCharLength}
                onChange={e => setTargetCharLength(e.target.value ? parseInt(e.target.value, 10) : '')}
                placeholder="e.g. 80"
                disabled={props.disabled || busy}
              />
            </label>
          )}

          {(feature === 'document.ask' || feature === 'document.summarize') && (
            <label>
              Context scope
              <select
                value={askScope}
                onChange={e => setAskScope(e.target.value as any)}
                disabled={props.disabled || busy}
              >
                <option value="selection">Selected text</option>
                <option value="page">Extractable text on current page</option>
                <option value="document">{feature === 'document.summarize' ? 'Entire document (batched)' : 'Search all pages for relevant passages'}</option>
              </select>
            </label>
          )}
          {askScope === 'document' && feature === 'document.ask' && <label>
            <input type="checkbox" checked={scanAllPages} disabled={props.disabled || busy}
              onChange={event => setScanAllPages(event.target.checked)} /> Scan every page for an exhaustive answer
          </label>}

          {['text.translate', 'text.proofread', 'text.rewrite', 'text.fit', 'blocks.organize'].includes(feature) && (
            <label>
              {feature === 'blocks.organize' ? 'Font for merged paragraph (optional)' : 'Replacement font'}
              <select
                value={fontId}
                onChange={e => {
                  setFontId(e.target.value);
                  if (feature === 'blocks.organize') resetResults();
                  if (candidateItems.length > 0 && props.document && snapshot) {
                    const newFont = e.target.value;
                    void (async () => {
                      const updated = await Promise.all(
                        candidateItems.map(async item => {
                          const ev = snapshot.get(item.targetEvidenceId);
                          if (!ev) return item;
                          const state = await checkSingleLayout(
                            props.document!.id,
                            ev.evidence.pageId,
                            ev.evidence.blockId,
                            [ev.sourceRange[0], ev.sourceRange[1]],
                            item.text,
                            newFont || undefined,
                          );
                          return { ...item, layoutState: state };
                        }),
                      );
                      setCandidateItems(updated);
                    })();
                  }
                }}
                disabled={props.disabled || busy || applying}
              >
                <option value="">Preserve original font</option>
                {fonts.map(font => (
                  <option key={font.id} value={font.id}>
                    {font.family} · {font.style}
                  </option>
                ))}
              </select>
            </label>
          )}
          {fontError ? <p role="alert">{fontError}; preserving original font.</p> : null}

          {feature !== 'document.translate' && (
            <label>
              Instructions / Prompts
              <textarea
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                placeholder={defaultInstructionFor(feature, tone)}
                disabled={props.disabled || busy}
              />
            </label>
          )}

          {feature === 'document.translate' && props.document && props.page && authorization && (
            <AiPanelBatch
              document={props.document}
              page={props.page}
              engine={props.engine}
              authorization={authorization}
              endpoint={props.endpoint}
              targetLanguage={language}
              onApplyBlock={handleApplyBatchBlock}
              onLocate={props.onLocate}
              disabled={Boolean(props.disabled)}
            />
          )}

          {feature !== 'document.translate' && (
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                className="button-primary"
                onClick={() => void run()}
                disabled={props.disabled || busy || applying || needsSourceConsent || !props.document || !props.page}
                style={{ flex: 1 }}
              >
                {busy ? 'Processing AI…' : 'Generate'}
              </button>
              {busy && (
                <button type="button" onClick={() => controller.current?.abort()}>
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" style={{ color: '#ff623d' }}>{error}</p>}
      {analysisProgress && <p role="status">{analysisProgress}</p>}
      {retrievalNote && <p role="status">{retrievalNote}</p>}
      {analysis && <p role="status">Scanned {analysis.pagesScanned} pages; {analysis.pagesWithText} contained extractable text ({analysis.passagesScanned} passages). Scanned pages without text require desktop OCR. Section findings and source locations follow.</p>}

      {answerText && (
        <div style={{ marginTop: '8px', padding: '10px', background: '#fffdf6', border: '1px solid #c2c1ba', borderRadius: '2px' }}>
          <strong style={{ fontSize: '11px' }}>AI Response</strong>
          <p style={{ whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: 1.6, margin: '6px 0 0' }}>{answerText}</p>
        </div>
      )}

      {analysis && <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
        {analysis.sections.map((section, index) => <details key={index}>
          <summary>Section {index + 1} · {section.citations.length} source citations</summary>
          <p style={{ whiteSpace: 'pre-wrap' }}>{section.text}</p>
          {section.citations.map((citation, citationIndex) => <button key={citationIndex} type="button"
            disabled={!props.onLocate || props.document?.id !== analysis.document.id || props.document?.revision !== analysis.document.revision}
            onClick={() => props.onLocate?.(citation.pageId, citation.blockId)}>
            Page {citation.pageNumber}{citation.quote ? ` · ${citation.quote}` : ''}
          </button>)}
          {!section.citations.length && <p>No PDF citation was verified for this section.</p>}
        </details>)}
      </div>}

      {result?.kind === 'answer' && snapshot && props.document && result.citations.length > 0 && (
        <div style={{ marginTop: '6px', display: 'grid', gap: '4px' }}>
          <strong style={{ fontSize: '10px', color: '#666' }}>Sources & Citations (click to locate)</strong>
          {result.citations.map((citation, idx) => {
            const resolved = resolveCitation(snapshot, citation, props.document!);
            if (resolved.status !== 'resolved') {
              return <p key={idx} style={{ fontSize: '10px', color: '#888' }}>Citation could not be located</p>;
            }
            return (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}>
                <button
                  type="button"
                  disabled={!resolved.currentLocation || !props.onLocate}
                  onClick={() => props.onLocate?.(resolved.frozenLocation.pageId, resolved.frozenLocation.blockId)}
                  style={{ fontSize: '9px', padding: '2px 6px' }}
                >
                  Page {resolved.frozenLocation.pageNumber}
                  {resolved.currentLocation ? '' : ' (older revision)'}
                </button>
                {citation.quote && <span style={{ color: '#555' }}>"{citation.quote}"</span>}
              </div>
            );
          })}
        </div>
      )}

      {result?.kind === 'clarification' && (
        <div style={{ padding: '8px', background: '#f5f4ef', border: '1px solid #c2c1ba', borderRadius: '2px' }}>
          <strong>Clarification required:</strong>
          <p>{result.question}</p>
          {result.choices && result.choices.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: '18px', fontSize: '10px' }}>
              {result.choices.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Candidate List (A01 - A04) */}
      {candidateItems.length > 0 && (
        <AiPanelCandidates
          replacements={candidateItems}
          snapshot={snapshot}
          selectedEvidenceIds={selectedEvidenceIds}
          onToggle={toggleEvidence}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          onApplySingle={handleApplySingle}
          onApplySelected={handleApplySelected}
          disabled={Boolean(props.disabled)}
          applying={applying}
          stale={stale}
          fontId={fontId}
          hasReplaceCapability={Boolean(props.document?.capabilities.includes('text.replace'))}
        />
      )}

      {/* Form Suggestions (A10) */}
      {feature === 'form.suggest' && formItems.length > 0 && (
        <AiPanelForm
          items={formItems}
          explanation={result?.kind === 'commandPlan' ? result.explanation : ''}
          selectedFieldIds={selectedFormIds}
          onToggle={id =>
            setSelectedFormIds(prev => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onSelectAll={() => setSelectedFormIds(new Set(formItems.map(i => i.fieldId)))}
          onDeselectAll={() => setSelectedFormIds(new Set())}
          onApplySingle={handleApplySingleFormField}
          onApplySelected={handleApplySelectedFormFields}
          disabled={Boolean(props.disabled)}
          applying={applying}
          stale={stale}
          canFillForms={Boolean(props.document?.permissions.fillForms)}
        />
      )}

      {/* Extraction (A09) */}
      {result?.kind === 'extraction' && (
        <AiPanelExtraction
          fields={result.fields}
          snapshot={snapshot}
          document={props.document}
          onLocate={props.onLocate}
        />
      )}

      {/* Command Plan (A05 / A11) */}
      {feature !== 'form.suggest' && result?.kind === 'commandPlan' && (
        <div style={{ marginTop: '8px', display: 'grid', gap: '6px', border: '1px solid #c2c1ba', padding: '10px', background: '#fffdf6' }}>
          <strong>Proposed Command Plan</strong>
          <p style={{ fontSize: '11px', margin: 0 }}>{result.explanation}</p>
          <div style={{ display: 'grid', gap: '3px', marginTop: '4px' }}>
            <strong style={{ fontSize: '10px', color: '#666' }}>Commands to execute ({result.commands.length})</strong>
            {result.commands.map((cmd, i) => (
              <div key={i} style={{ fontSize: '10px', padding: '3px 6px', background: '#f0eee7', borderRadius: '2px' }}>
                {i + 1}. <strong>{cmd.type}</strong>
                {'pageIds' in cmd && <span> · Pages: {cmd.pageIds.join(', ')}</span>}
                {'objectIds' in cmd && <span> · Objects: {cmd.objectIds.length}</span>}
                {cmd.type === 'text.reflow' && <span> · Text blocks in order: {cmd.blockIds.join(', ')}</span>}
              </div>
            ))}
          </div>
          {commandPlanPreview?.transaction.commands.filter(cmd => cmd.type === 'text.reflow').map(cmd =>
            <div key={cmd.objectId} style={{ fontSize: '10px' }}>
              <strong>Merged text and target box (pt)</strong>
              <p style={{ whiteSpace: 'pre-wrap' }}>{cmd.text}</p>
              <p>{cmd.bounds.x}, {cmd.bounds.y} · {cmd.bounds.width} × {cmd.bounds.height}</p>
            </div>)}

          <button
            type="button"
            className="button-primary"
            onClick={() => void handleApplyCommandPlan()}
            disabled={!commandPlanPreview || applying || stale || props.disabled}
            style={{ marginTop: '6px' }}
          >
            {applying ? 'Applying commands…' : 'Apply Command Plan'}
          </button>
        </div>
      )}
    </section>
  );
}

export function withReplacementFont(transaction: EditTransaction, fontId: string): EditTransaction {
  return {
    ...transaction,
    commands: transaction.commands.map(command =>
      command.type === 'text.replace' ? { ...command, style: { fontId } } : command,
    ),
  };
}

function defaultInstructionFor(feature: AiFeature, tone: string): string {
  switch (feature) {
    case 'text.translate':
      return 'Translate selected text, preserving numbers, code, and terms';
    case 'text.proofread':
      return 'Proofread text, correcting typos and grammar while preserving numbers and facts, attaching brief reasons';
    case 'text.rewrite':
      return `Rewrite text in ${toneDescription(tone)} style while preserving original meaning`;
    case 'text.fit':
      return 'Shorten text to fit within text box, cutting redundant phrasing while preserving key numbers and facts';
    case 'commands.plan':
      return 'Organize existing commands according to user instructions';
    case 'document.ask':
      return 'Answer question with precise evidence citations';
    case 'document.summarize':
      return 'Extract key takeaways and reading outline with source citations';
    case 'document.translate':
      return 'Translate text paragraph by paragraph';
    case 'document.extract':
      return 'Extract structured fields (titles, dates, amounts, items, and tables)';
    case 'form.suggest':
      return 'Suggest values to fill into the form fields based on the document context';
    case 'blocks.organize':
      return 'Optimize alignment and format consistency for selected text blocks';
    case 'image.explain':
      return 'Explain visible content and conclusions in the selected diagram or chart';
    default:
      return '';
  }
}

function toneDescription(tone: string): string {
  switch (tone) {
    case 'formal':
      return 'formal & rigorous';
    case 'concise':
      return 'concise & direct';
    case 'casual':
      return 'casual & accessible';
    case 'professional':
      return 'professional';
    case 'academic':
      return 'academic';
    default:
      return 'concise';
  }
}
