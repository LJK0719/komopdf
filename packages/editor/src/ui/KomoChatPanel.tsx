import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Download, Link2, Square, Trash2 } from 'lucide-react';
import { AiWorkflow, DocumentAiAuthorization, resolveCitation } from '@pdf-editor/ai-client';
import type { KolmoJob } from '@pdf-editor/contracts';
import type { EditorAiContext } from './EditorShell.js';
import { AiMarkdown } from './AiMarkdown.js';
import { AppDialog } from './AppDialog.js';
import { KolmoConnectionForm } from './KolmoConnectionForm.js';
import { readWithKolmo } from './kolmo-reading.js';
import { useI18n, localizedPath } from './i18n.js';
import { CHAT_COPY_RESTRICTED, ChatContextError, prepareChatContext, SCAN_RECOMMENDATION, type ChatScope, type ChatVisualMode } from './komo-chat-context.js';
import { CHAT_CONTEXT_EXPIRED, attachChatHandoff, canRetryContext, createChatSession, createKomoChatStore, freezeChatRequestContext, synchronizeChatOwner, chatFailure, chatHistory, type KomoChatStore, type ChatSession, type ChatRequestContext, type ChatExchange, type ChatCitation } from './komo-chat-state.js';
import { isMaterialCurrent, materialDocument, prepareMaterials, resolveMaterialCitation } from './komo-materials.js';
import { KomoMaterials } from './KomoMaterials.js';
import type { AiMaterial } from './text-actions.js';
import './komo-chat.css';

type Props = { context: EditorAiContext; endpoint?: string; fetch?: typeof fetch; disabledReason?: string; onComplete?(): void;
  store?: KomoChatStore; sessionOwner?: string | null };
type UpdateSession = (update: (session: ChatSession) => ChatSession) => void;

export function KomoChatPanel(props: Props) {
  const localStore = useRef<KomoChatStore | null>(null);
  if (!localStore.current) localStore.current = createKomoChatStore();
  const store = props.store ?? localStore.current;
  synchronizeChatOwner(store, props.sessionOwner);
  const [, render] = useState(0);
  const documents = props.context.documents;
  const openDocuments = useRef(documents); openDocuments.current = documents;
  const id = props.context.document?.id ?? 'empty';
  const generation = store.generation;
  useEffect(() => {
    if (!documents) return;
    const ids = new Set(documents.map(document => document.id));
    if (Object.keys(store.sessions).some(key => !ids.has(key))) {
      store.sessions = Object.fromEntries(Object.entries(store.sessions).filter(([key]) => ids.has(key)));
      render(value => value + 1);
    }
  }, [documents, store]);
  const updateSession: UpdateSession = update => {
    if (store.generation !== generation || (openDocuments.current && !openDocuments.current.some(document => document.id === id))) return;
    store.sessions = { ...store.sessions, [id]: update(store.sessions[id] ?? createChatSession()) };
    render(value => value + 1);
  };
  useEffect(() => {
    const handoff = props.context.handoff;
    if (!handoff || store.consumed.has(handoff.id)) return;
    store.consumed.add(handoff.id);
    updateSession(previous => attachChatHandoff(previous, handoff));
    props.context.onHandoffConsumed?.(handoff.id);
  }, [props.context.handoff?.id, id, generation]);
  return <Chat key={`${id}:${generation}`} {...props} session={store.sessions[id] ?? createChatSession()} updateSession={updateSession} />;
}

function Chat({ context, endpoint = '/api/v1/ai/requests', fetch, disabledReason, onComplete, session, updateSession }: Props & { session: ChatSession; updateSession: UpdateSession }) {
  const { t, locale } = useI18n();
  const latest = useRef(context); latest.current = context;
  const controller = useRef<AbortController | null>(null);
  const readingController = useRef<AbortController | null>(null);
  const [authorization] = useState(() => new DocumentAiAuthorization(context.document?.id ?? 'empty'));
  const [servicesOpen, setServicesOpen] = useState(false);
  const [readingBusy, setReadingBusy] = useState(false);
  const [readingJob, setReadingJob] = useState<KolmoJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [newAnswer, setNewAnswer] = useState(false);
  const { exchanges, instruction, scope, visualMode, scanned, materials, suggestedQuestions } = session;
  const reading = session.reading?.revision === context.document?.revision ? session.reading : undefined;
  const getDocument = (id: string) => materialDocument(latest.current, id);
  const retryIsCurrent = (saved: ChatRequestContext | undefined) => canRetryContext(saved, latest.current.document, getDocument);
  const patch = (value: Partial<ChatSession>) => updateSession(previous => ({ ...previous, ...value }));
  const transcript = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const canCopy = context.document?.permissions.copy === true;
  const canSend = canCopy && !!context.document && !context.disabled && !busy && !readingBusy;
  const materialName = context.name || t('Current PDF');
  useEffect(() => { if (context.handoff) input.current?.focus(); }, [context.handoff?.id]);
  useEffect(() => () => { controller.current?.abort(); readingController.current?.abort(); authorization.revoke(); }, [authorization]);
  useEffect(() => { if (!canCopy) { authorization.revoke(); controller.current?.abort(); readingController.current?.abort(); } }, [canCopy, authorization]);
  useEffect(() => {
    const list = transcript.current;
    if (!list) return;
    if (followLatest.current) list.scrollTop = list.scrollHeight;
    else if (exchanges.at(-1)?.status === 'complete') setNewAnswer(true);
  }, [exchanges]);
  const update = (id: string, value: Partial<ChatExchange>) => updateSession(previous => ({
    ...previous, exchanges: previous.exchanges.map(item => item.id === id ? { ...item, ...value } : item),
  }));
  const readDocument = async () => {
    if (readingBusy || busy) return;
    const abort = new AbortController(); readingController.current = abort;
    setReadingBusy(true); setReadingJob(null); setNotice('');
    try {
      const result = await readWithKolmo(latest.current, abort.signal, setReadingJob);
      if (!result) { setServicesOpen(true); return; }
      patch({ reading: result }); setServicesOpen(false);
    } catch (caught) { if (!abort.signal.aborted) setNotice(caught instanceof Error ? caught.message : 'Unable to read this PDF. Please try again.'); }
    finally { readingController.current = null; setReadingBusy(false); }
  };
  const downloadReading = () => {
    if (!reading) return;
    void context.saveServiceFile?.({ kind: 'bytes', name: reading.filename, mimeType: 'text/markdown;charset=utf-8',
      bytes: new TextEncoder().encode(reading.text).buffer }, reading.jobId).catch(() => setNotice('Unable to download this file.'));
  };
  const send = async (question = instruction, nextScope = scope, nextVisualMode = visualMode, retry?: ChatRequestContext, continuation?: ChatExchange) => {
    const prompt = question.trim();
    if (!canSend || !prompt || controller.current || !context.document) return;
    if (nextScope === 'document' && /\b(this|current) page\b|当前页|本页/iu.test(prompt)) nextScope = 'page';
    const targetId = context.document.id;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setNotice('');
    let nextMaterials = materials;
    try {
      if (context.draftDirty && await context.finishDrafts?.() !== true) throw new ChatContextError('Unable to finish the current text edit.');
      abort.signal.throwIfAborted();
      if (!retry) {
        const prepared = await prepareMaterials(materials, { ...latest.current, getDocumentInfo: getDocument }, abort.signal);
        if (!prepared) { controller.current = null; setBusy(false); return; }
        nextMaterials = prepared;
        patch({ materials: prepared });
      }
    } catch (caught) {
      if (!abort.signal.aborted) setNotice(caught instanceof Error ? caught.message : 'Unable to finish the current text edit.');
      controller.current = null; setBusy(false); return;
    }
    const document = getDocument(targetId);
    if (!document || document.permissions.copy !== true) { controller.current = null; setBusy(false); setNotice(CHAT_COPY_RESTRICTED); return; }
    const history = chatHistory(exchanges, document.revision, getDocument);
    if (continuation?.answer) history.push({ role: 'user', text: continuation.prompt }, { role: 'assistant', text: continuation.answer });
    let saved = retry && retryIsCurrent(retry) ? retry : freezeChatRequestContext({
      documentId: document.id, revision: document.revision, scope: nextScope,
      pageId: context.pageId ?? context.page?.id ?? document.pageOrder[0] ?? null,
      selectedIds: [...context.selectedIds], visualMode: nextVisualMode, materials: nextMaterials, history,
    });
    const id = crypto.randomUUID();
    updateSession(previous => ({ ...previous, ...(question === instruction ? { instruction: '' } : {}),
      exchanges: [...previous.exchanges, { id, prompt, requestContext: saved, status: 'pending', progress: 'Reading document…' }] }));
    followLatest.current = true; setNewAnswer(false); input.current?.focus();
    try {
      let prepared = saved.prepared;
      if (!prepared) {
        const page = saved.scope === 'document' ? context.page : saved.pageId === context.page?.id && document.revision === context.document?.revision ? context.page
          : saved.pageId ? await context.engine.describePage(document.id, saved.pageId) : null;
        abort.signal.throwIfAborted();
        prepared = await prepareChatContext({ engine: context.engine, document, page, currentPageId: saved.pageId ?? document.pageOrder[0]!, selectedIds: saved.selectedIds,
          scope: saved.scope, visualMode: saved.visualMode, instruction: prompt, history: saved.history ?? [], signal: abort.signal,
          materials: saved.materials ?? [], materialContext: { ...context, getDocumentInfo: getDocument }, name: materialName,
          ...(reading ? { reading } : {}), ...(session.sourceContext ? { sourceContext: session.sourceContext } : {}),
          readDocument: () => readWithKolmo(latest.current, abort.signal, () => update(id, { progress: 'Reading document…' })),
          endpoint, ...(fetch ? { fetch } : {}), onProgress: () => update(id, { progress: 'Reading document…' }),
        });
        patch({ ...(prepared.sourceContext ? { sourceContext: prepared.sourceContext } : {}), ...(prepared.reading ? { reading: prepared.reading } : {}) });
        saved = freezeChatRequestContext({ ...saved, prepared: { ...prepared, sourceContext: undefined, reading: undefined } });
        update(id, { requestContext: saved });
      }
      abort.signal.throwIfAborted();
      if (latest.current.document?.permissions.copy !== true) throw new ChatContextError(CHAT_COPY_RESTRICTED);
      if (!retryIsCurrent(saved) || saved.materials?.some(material => !isMaterialCurrent(material, latest.current))) throw new ChatContextError(CHAT_CONTEXT_EXPIRED);
      authorization.enable(prepared.sourceIds); patch({ scanned: prepared.scanned });
      update(id, { progress: 'komo is preparing an answer…', pages: prepared.pageNumbers, images: prepared.imagePageNumbers });
      const workflow = new AiWorkflow({ endpoint, authorization, ...(fetch ? { fetch } : {}),
        getCurrentDocument: () => latest.current.document ?? { id: '', revision: -1 },
        nextTransactionId: () => crypto.randomUUID(), apply: async () => { throw new Error('Reading does not modify the PDF'); },
      });
      let partial = '';
      const outcome = await workflow.run({ request: prepared.request, snapshot: prepared.snapshot, sourceIds: prepared.sourceIds, signal: abort.signal,
        onDelta: text => { partial += text; update(id, { answer: partial.replace(/\[(?:e|r)\d+\]/g, '') }); } });
      abort.signal.throwIfAborted();
      const result = outcome.response.result;
      if (result.kind !== 'answer' && result.kind !== 'clarification') throw new Error('Unable to finish this answer.');
      const citations: ChatCitation[] = [];
      if (result.kind === 'answer' && latest.current.document) for (const citation of result.citations) {
        const reference = resolveMaterialCitation(prepared.request, citation, latest.current);
        if (reference) { citations.push(reference); continue; }
        const resolved = resolveCitation(prepared.snapshot, citation, latest.current.document);
        if (resolved.status !== 'resolved' || !resolved.currentLocation) continue;
        const location = resolved.currentLocation;
        citations.push({ documentId: document.id, revision: document.revision, name: materialName, kind: 'source',
          pageId: location.pageId, pageNumber: location.pageNumber, blockId: location.blockId, range: { start: location.range[0], end: location.range[1] } });
      }
      if (retryIsCurrent(saved)) for (const pageNumber of prepared.imagePageNumbers) {
        if (!citations.some(citation => citation.documentId === document.id && citation.pageNumber === pageNumber)) citations.push({ documentId: document.id,
          revision: document.revision, name: materialName, pageId: document.pageOrder[pageNumber - 1]!, pageNumber });
      }
      update(id, { status: 'complete', answer: result.kind === 'answer' ? result.text : result.question, citations });
    } catch (caught) {
      if (abort.signal.aborted) update(id, { status: 'cancelled' });
      else {
        if (caught instanceof ChatContextError) patch({ scanned: caught.scanned });
        update(id, { status: 'failed', failure: chatFailure(caught) });
      }
    } finally { controller.current = null; setBusy(false); onComplete?.(); }
  };
  const editQuestion = (prompt: string) => { patch({ instruction: prompt }); setNotice(''); input.current?.focus(); };
  const clear = () => { patch({ exchanges: [], scanned: false }); setNewAnswer(false); setNotice(''); };
  const citationCurrent = (citation: ChatCitation) => {
    const document = citation.documentId ? getDocument(citation.documentId) : context.document;
    return !!document && document.permissions.copy === true && (citation.revision === undefined || citation.revision === document.revision)
      && !!citation.pageId && document.pageOrder.includes(citation.pageId);
  };
  const locate = (citation: ChatCitation) => {
    if (!citationCurrent(citation) || !citation.pageId) return;
    if (context.locateMaterial && citation.documentId && citation.revision !== undefined) {
      const material: AiMaterial = { id: citation.materialId ?? 'citation', documentId: citation.documentId, revision: citation.revision,
        name: citation.name ?? materialName, kind: 'selection', text: '', locations: [{ pageId: citation.pageId, pageNumber: citation.pageNumber!,
          ...(citation.blockId ? { blockId: citation.blockId } : {}), ...(citation.range ? { range: [citation.range.start, citation.range.end] } : {}) }] };
      void context.locateMaterial(material).catch(() => setNotice('Unable to locate this material.'));
    } else if (!citation.documentId || citation.documentId === context.document?.id) {
      if (citation.blockId) context.locateText?.(citation.pageId, citation.blockId, citation.range);
      else void context.navigatePage?.(citation.pageId);
    }
  };

  return <section className="komo-chat" aria-label="komo">
    <header className="komo-chat-heading"><span className="komo-chat-avatar komopdf-icon" aria-hidden="true" /><h2 translate="no">komo</h2>
      {context.aiServices && <button type="button" className="icon-button" aria-label={t('Connect KolmoPDF')} title="KolmoPDF" onClick={() => setServicesOpen(true)}><Link2 size={16} aria-hidden="true" /></button>}
      <button type="button" className="icon-button" aria-label={t('Clear conversation')} title={t('Clear conversation')}
        disabled={busy || !exchanges.length} onClick={clear}><Trash2 size={16} aria-hidden="true" /></button>
    </header>
    {context.aiServices && <AppDialog open={servicesOpen} onOpenChange={setServicesOpen} title="KolmoPDF" className="ai-owned-focus kolmo-service-dialog">
      <KolmoConnectionForm services={context.aiServices} active={servicesOpen} disabled={readingBusy} {...(context.openExternal ? { openExternal: context.openExternal } : {})} />
      {context.document && <><p>{t('Read the full PDF and keep asking questions in komo.')}</p>
        <p className="task-help">{t('Estimated cost: {points} credits', { points: context.document.pageOrder.length * 2 })}</p>
        <div className="ai-run-row"><button type="button" className="button button-primary" disabled={readingBusy || busy || !canCopy} onClick={() => void readDocument()}>{t(readingBusy ? 'Reading document…' : 'Read full PDF')}</button>
          {context.translateDocument && <button type="button" className="button" onClick={() => { setServicesOpen(false); context.translateDocument?.(); }}>{t('Translate PDF')}</button>}</div></>}
    </AppDialog>}
    {!context.document ? <p role="status">{t('Open a PDF before asking komo.')}</p> : !canCopy ? <p role="status">{t(CHAT_COPY_RESTRICTED)}</p> : <>
      <div className="komo-chat-material"><strong title={materialName}>{materialName}</strong><span>{t(reading ? 'Full document ready' : scope === 'selection' ? 'Selected text' : 'Current PDF')}</span>
        {reading && <button type="button" className="text-button" aria-label={t('Download Markdown')} title={t('Download Markdown')} onClick={downloadReading}><Download size={15} aria-hidden="true" /></button>}</div>
      <div className="komo-chat-transcript" ref={transcript} role="log" aria-live="polite" aria-relevant="additions text" tabIndex={0} aria-label={t('Conversation')} onScroll={() => {
        const list = transcript.current!; followLatest.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
        if (followLatest.current) setNewAnswer(false);
      }}>
        {!exchanges.length && <div className="komo-chat-empty"><h3>{t('Ask about this PDF')}</h3><p>{t('Ask a question, explore an idea, or get a summary.')}</p>
          <div className="komo-chat-suggestions">{['Summarize this document', 'What are the key takeaways?'].map(prompt =>
            <button type="button" key={prompt} disabled={!canSend} onClick={() => void send(t(prompt))}>{t(prompt)}</button>)}</div></div>}
        {exchanges.map(exchange => <div className="komo-chat-exchange" key={exchange.id}>
          <article className="komo-chat-message komo-chat-user"><strong>{t('You')}</strong><p>{exchange.prompt}</p></article>
          <article className="komo-chat-message komo-chat-assistant" aria-busy={exchange.status === 'pending'}><strong translate="no">komo</strong>
            {exchange.answer && <AiMarkdown text={exchange.answer} />}
            {exchange.status === 'complete' && <div className="komo-chat-citations">{exchange.citations?.map((citation, index) => {
              const label = citation.kind === 'generated' || citation.kind === 'analysis' ? t('Reference') : t('Page {page}', { page: citation.pageNumber ?? '' });
              return citation.pageId ? <button type="button" key={index} disabled={!!context.navigationDisabled || !citationCurrent(citation)} title={t('Locate source')} onClick={() => locate(citation)}>
                {citation.name && citation.name !== materialName ? `${citation.name} · ` : ''}{label}</button>
                : <span key={index}>{citation.name || label}</span>;
            })}</div>}
            {exchange.status === 'pending' ? <p className="komo-chat-progress" role="status">{t(exchange.progress || 'komo is preparing an answer…')}</p>
              : exchange.status !== 'complete' && <>
                <p className={exchange.status === 'failed' ? 'komo-chat-error' : ''} role={exchange.status === 'failed' ? 'alert' : 'status'}>{t(exchange.answer ? 'Answer paused' : exchange.failure?.message ?? 'Stopped')}</p>
                <div className="komo-chat-actions">
                  {exchange.answer && <button type="button" disabled={!canSend} onClick={() => void send(t('Continue the answer'), scope, visualMode, undefined, exchange)}>{t('Continue')}</button>}
                  {exchange.failure?.retryable !== false && <button type="button" disabled={!canSend} onClick={() => void send(exchange.prompt, scope, visualMode,
                    retryIsCurrent(exchange.requestContext) ? exchange.requestContext : undefined)}>{t('Try again')}</button>}
                  {exchange.failure?.action === 'account' && <a href={localizedPath('/account/', locale)} target="_blank" rel="noreferrer">{t('Account')}</a>}
                  <button type="button" onClick={() => editQuestion(exchange.prompt)}>{t('Edit question')}</button>
                </div>
              </>}
          </article>
        </div>)}
        {scanned && !reading && context.aiServices?.parseDocument && <div className="komo-chat-scan"><p>{t(SCAN_RECOMMENDATION)}</p>
          <button type="button" className="button" disabled={busy || readingBusy} onClick={() => void readDocument()}>{t('Read full PDF')}</button></div>}
      </div>
      {readingBusy && <div className="komo-reading-progress" role="status"><span>{t('Reading document…')}</span>
        {typeof readingJob?.progress === 'number' && <progress max="100" value={readingJob.progress} />}
        <button type="button" className="text-button" onClick={() => { readingController.current?.abort(); if (readingJob) void context.aiServices?.cancelKolmoJob(readingJob.id); }}>{t('Stop')}</button></div>}
      {newAnswer && <button type="button" className="komo-new-answer" onClick={() => {
        followLatest.current = true; setNewAnswer(false); if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
      }}>{t('New answer · scroll to latest')}</button>}
      <KomoMaterials context={context} materials={materials} onAdd={material => updateSession(previous => ({ ...previous,
        materials: [...previous.materials.filter(item => item.id !== material.id), material] }))}
        onRemove={id => patch({ materials: materials.filter(material => material.id !== id) })} />
      {suggestedQuestions.length > 0 && <div className="komo-material-suggestions">{suggestedQuestions.map(question => <button type="button" key={question} disabled={!canSend} onClick={() => void send(question)}>{question}</button>)}</div>}
      {notice && <p className="komo-chat-notice" role="status">{t(notice)}</p>}
      {context.disabled && <p className="komo-chat-notice" role="status">{t(disabledReason || 'Please wait…')}</p>}
      <form className="komo-chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="komo-question">{t('Message')}</label>
        <textarea ref={input} id="komo-question" name="question" autoComplete="off" rows={2} maxLength={16000} value={instruction}
          placeholder={t('Ask komo to help with your PDF…')} onChange={event => patch({ instruction: event.target.value })} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
          }} />
        <div><small>{t('Enter to send · Shift+Enter for a new line')}</small>{busy
          ? <button type="button" className="button button-quiet" onClick={() => controller.current?.abort()}><Square size={14} aria-hidden="true" />{t('Stop')}</button>
          : <button type="submit" className="button button-primary" disabled={!canSend || !instruction.trim()}><ArrowUp size={16} aria-hidden="true" />{t('Send')}</button>}</div>
      </form>
    </>}
  </section>;
}
