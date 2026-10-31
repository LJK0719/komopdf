import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Trash2 } from 'lucide-react';
import { AiWorkflow, DocumentAiAuthorization, resolveCitation } from '@pdf-editor/ai-client';
import type { EditorAiContext } from './EditorShell.js';
import { AiMarkdown } from './AiMarkdown.js';
import { useI18n } from './i18n.js';
import { CHAT_COPY_RESTRICTED, ChatContextError, prepareChatContext, SCAN_RECOMMENDATION, type ChatScope, type ChatVisualMode } from './komo-chat-context.js';
import { CHAT_CONTEXT_EXPIRED, attachChatHandoff, canRetryContext, createChatSession, createKomoChatStore, freezeChatRequestContext, synchronizeChatOwner, chatFailure, chatHistory, type KomoChatStore, type ChatSession, type ChatRequestContext, type ChatExchange, type ChatCitation } from './komo-chat-state.js';
import { isMaterialCurrent, materialDocument, prepareMaterials, resolveMaterialCitation } from './komo-materials.js';
import { KomoMaterials } from './KomoMaterials.js';
import type { AiMaterial } from './text-actions.js';
import './komo-chat.css';

type Props = { context: EditorAiContext; endpoint?: string; fetch?: typeof fetch; disabledReason?: string; onComplete?(): void;
  store?: KomoChatStore; sessionOwner?: string | null };
const scopeLabels = { document: 'Whole document', page: 'Current page', selection: 'Selected text objects' };
const visualLabels = { auto: 'Automatic images', always: 'Include page images', text: 'Text only' };
type UpdateSession = (update: (session: ChatSession) => ChatSession) => void;

/** The caller may retain this local store across account-provider loading remounts. */
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
  const { t } = useI18n();
  const latest = useRef(context); latest.current = context;
  const controller = useRef<AbortController | null>(null);
  const [authorization] = useState(() => new DocumentAiAuthorization(context.document?.id ?? 'empty'));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [newAnswer, setNewAnswer] = useState(false);
  const { exchanges, instruction, scope, visualMode, consent, scanned, materials, suggestedQuestions } = session;
  const getDocument = (id: string) => materialDocument(latest.current, id);
  const retryIsCurrent = (saved: ChatRequestContext | undefined) => canRetryContext(saved, latest.current.document, getDocument);
  useEffect(() => { if (context.handoff) input.current?.focus(); }, [context.handoff?.id]);
  const patch = (value: Partial<ChatSession>) => updateSession(previous => ({ ...previous, ...value }));
  const transcript = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const consentInput = useRef<HTMLInputElement>(null);
  const canCopy = context.document?.permissions.copy === true;
  const canSend = canCopy && !!context.document && !context.disabled && !busy;
  const materialName = context.name || t('Current PDF');

  useEffect(() => () => { controller.current?.abort(); authorization.revoke(); }, [authorization]);
  useEffect(() => {
    if (!canCopy) { authorization.revoke(); controller.current?.abort(); }
  }, [canCopy, authorization]);
  useEffect(() => {
    const list = transcript.current;
    if (!list) return;
    if (followLatest.current) {
      const answer = list.querySelector<HTMLElement>('.komo-chat-exchange:last-child .komo-chat-assistant');
      if (exchanges.at(-1)?.status === 'complete' && answer) {
        list.scrollTop += answer.getBoundingClientRect().top - list.getBoundingClientRect().top - 4;
      } else list.scrollTop = list.scrollHeight;
    } else if (exchanges.at(-1)?.status === 'complete') setNewAnswer(true);
  }, [exchanges]);
  useEffect(() => {
    if (settingsOpen && notice === 'Review and allow sharing before sending your question.') consentInput.current?.focus();
  }, [settingsOpen, notice]);

  const update = (id: string, value: Partial<ChatExchange>) => {
    updateSession(previous => ({ ...previous, exchanges: previous.exchanges.map(item => item.id === id ? { ...item, ...value } : item) }));
  };
  const send = async (question = instruction, nextScope = scope, nextVisualMode = visualMode, retry?: ChatRequestContext, refresh?: ChatRequestContext) => {
    const prompt = question.trim();
    if (!canSend || !prompt || controller.current || !context.document) return;
    if (!consent) { setSettingsOpen(true); setNotice('Review and allow sharing before sending your question.'); return; }
    if (retry && !retryIsCurrent(retry)) { setNotice(CHAT_CONTEXT_EXPIRED); return; }
    const targetId = context.document.id;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setNotice('');
    let nextMaterials = refresh ? [...materials, ...(refresh.materials ?? []).filter(material => !materials.some(item => item.id === material.id))] : materials;
    try {
      if (context.draftDirty && await context.finishDrafts?.() !== true) throw new ChatContextError('Finish or discard pending paragraph changes before sending.');
      abort.signal.throwIfAborted();
      if (!retry) {
        const prepared = await prepareMaterials(nextMaterials, { ...latest.current, getDocumentInfo: getDocument }, abort.signal);
        if (!prepared) { controller.current = null; setBusy(false); return; }
        nextMaterials = prepared;
        updateSession(previous => ({ ...previous, materials: [
          ...previous.materials.map(material => prepared.find(item => item.id === material.id) ?? material),
          ...prepared.filter(material => !previous.materials.some(item => item.id === material.id)),
        ] }));
      }
      if (latest.current.document?.id !== targetId) throw new ChatContextError(CHAT_CONTEXT_EXPIRED);
    } catch (caught) {
      if (!abort.signal.aborted) setNotice(caught instanceof Error ? caught.message : 'Unable to finish pending PDF changes.');
      controller.current = null; setBusy(false); return;
    }
    const document = getDocument(targetId)!;
    if (!document || document.permissions.copy !== true) { controller.current = null; setBusy(false); setNotice(CHAT_COPY_RESTRICTED); return; }
    let saved = retry ?? freezeChatRequestContext({
      documentId: document.id, revision: document.revision, scope: nextScope,
      pageId: refresh?.pageId ?? context.page?.id ?? null, selectedIds: [...(refresh?.selectedIds ?? context.selectedIds)], visualMode: nextVisualMode, materials: nextMaterials,
      history: chatHistory(exchanges, document.revision, getDocument),
    });
    if (!retryIsCurrent(saved) || saved.materials?.some(material => !isMaterialCurrent(material, latest.current))) {
      setNotice(CHAT_CONTEXT_EXPIRED); controller.current = null; setBusy(false); return;
    }
    const id = crypto.randomUUID();
    setSettingsOpen(false);
    updateSession(previous => ({ ...previous, ...(question === instruction ? { instruction: '' } : {}),
      materials: retry ? previous.materials : previous.materials.filter(material => !saved.materials?.some(item => item.id === material.id)),
      exchanges: [...previous.exchanges, { id, prompt, requestContext: saved, status: 'pending', progress: 'Reading the selected context…' }] }));
    followLatest.current = true; setNewAnswer(false); input.current?.focus();
    try {
      let prepared = saved.prepared;
      if (!prepared) {
        const page = saved.scope === 'document' ? null : saved.pageId === context.page?.id && document.revision === context.document?.revision ? context.page
          : saved.pageId ? await context.engine.describePage(document.id, saved.pageId) : null;
        abort.signal.throwIfAborted();
        if (saved.scope === 'selection' && !saved.selectedIds.every(id => page?.objects.some(object => object.id === id))) throw new ChatContextError(CHAT_CONTEXT_EXPIRED);
        prepared = await prepareChatContext({ engine: context.engine, document, page, selectedIds: saved.selectedIds,
          scope: saved.scope, visualMode: saved.visualMode, instruction: prompt,
          history: saved.history ?? [], signal: abort.signal,
          materials: saved.materials ?? [], materialContext: { ...context, getDocumentInfo: getDocument }, name: materialName,
          endpoint, ...(fetch ? { fetch } : {}), onProgress: progress => update(id, { progress }),
        });
        saved = freezeChatRequestContext({ ...saved, prepared });
        update(id, { requestContext: saved });
      }
      abort.signal.throwIfAborted();
      if (latest.current.document?.permissions.copy !== true) throw new ChatContextError(CHAT_COPY_RESTRICTED);
      if (!retryIsCurrent(saved) || saved.materials?.some(material => !isMaterialCurrent(material, latest.current))) throw new ChatContextError(CHAT_CONTEXT_EXPIRED);
      const sources = prepared.sourceIds;
      authorization.enable(sources);
      patch({ scanned: prepared.scanned });
      update(id, { progress: 'komo is preparing an answer…', pages: prepared.pageNumbers, images: prepared.imagePageNumbers });
      const workflow = new AiWorkflow({ endpoint, authorization, ...(fetch ? { fetch } : {}),
        getCurrentDocument: () => latest.current.document ?? { id: '', revision: -1 },
        nextTransactionId: () => crypto.randomUUID(), apply: async () => { throw new Error('Web komo is read-only'); },
      });
      const outcome = await workflow.run({ request: prepared.request, snapshot: prepared.snapshot, sourceIds: sources, signal: abort.signal });
      abort.signal.throwIfAborted();
      const currentDocument = latest.current.document;
      const result = outcome.response.result;
      if (result.kind !== 'answer' && result.kind !== 'clarification') throw new Error('Unexpected answer type');
      const citations: ChatCitation[] = [];
      if (result.kind === 'answer' && currentDocument) for (const citation of result.citations) {
        const reference = resolveMaterialCitation(prepared.request, citation, latest.current);
        if (reference) { citations.push(reference); continue; }
        const resolved = resolveCitation(prepared.snapshot, citation, currentDocument);
        if (resolved.status !== 'resolved' || !resolved.currentLocation) continue;
        const location = resolved.currentLocation;
        citations.push({ documentId: document.id, revision: document.revision, name: materialName, kind: 'source',
          pageId: location.pageId, pageNumber: location.pageNumber, blockId: location.blockId,
          range: { start: location.range[0], end: location.range[1] } });
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
        update(id, { status: 'failed', failure: !retryIsCurrent(saved) ? { message: CHAT_CONTEXT_EXPIRED, retryable: false } : chatFailure(caught) });
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
    <header className="komo-chat-heading"><span className="komo-chat-avatar" aria-hidden="true">k</span>
      <h2 translate="no">komo</h2><span className="komo-chat-tag">{t('PDF Q&A')}</span>
      <button type="button" className="icon-button" aria-label={t('Clear conversation')} title={t('Clear conversation')}
        disabled={busy || !exchanges.length} onClick={clear}><Trash2 size={16} aria-hidden="true" /></button>
    </header>
    {!context.document ? <p role="status">{t('Open a PDF before asking komo.')}</p> : !canCopy ? <p role="status">{t(CHAT_COPY_RESTRICTED)}</p> : <>
      <div className="komo-chat-material"><span>{t('Current material')}</span><strong title={materialName}>{materialName}</strong>
        <span>{t(scopeLabels[scope])}{scope !== 'document' && context.page ? ` · ${t('Page {page}', { page: context.document.pageOrder.indexOf(context.page.id) + 1 })}` : ''}</span></div>
      <div className="komo-chat-transcript" ref={transcript} role="log" aria-live="polite" aria-relevant="additions text" tabIndex={0} aria-label={t('Conversation')} onScroll={() => {
        const list = transcript.current!;
        followLatest.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
        if (followLatest.current) setNewAnswer(false);
      }}>
        {!exchanges.length && <div className="komo-chat-empty"><h3>{t('Ask about this PDF')}</h3>
          <p>{t('Summarize, clarify a passage, or ask a follow-up. Web komo answers questions; it does not edit your PDF.')}</p>
          <div className="komo-chat-suggestions">{['Summarize this document', 'What are the key takeaways?'].map(prompt =>
            <button type="button" key={prompt} disabled={busy} onClick={() => editQuestion(t(prompt))}>{t(prompt)}</button>)}</div>
        </div>}
        {exchanges.map(exchange => {
          const stale = !!exchange.requestContext && !retryIsCurrent(exchange.requestContext);
          const retryable = retryIsCurrent(exchange.requestContext);
          return <div className="komo-chat-exchange" key={exchange.id}>
            <article className="komo-chat-message komo-chat-user"><strong>{t('You')}</strong><p>{exchange.prompt}</p></article>
            <article className="komo-chat-message komo-chat-assistant" aria-busy={exchange.status === 'pending'}>
              <strong translate="no">komo</strong>
              {stale ? <p className="komo-chat-stale">{t('Earlier document version · source links are no longer available.')}</p> : null}
              {exchange.status === 'complete' ? <>
                <AiMarkdown text={exchange.answer!} />
                <div className="komo-chat-citations">{exchange.citations?.map((citation, index) => {
                  const derived = citation.kind === 'generated' || citation.kind === 'analysis';
                  const label = derived ? t(citation.kind === 'analysis' ? 'Full-document analysis' : citation.role === 'attached' ? 'Attached text' : 'Generated text')
                    : t(citation.blockId ? 'Source · page {page}' : 'Image · page {page}', { page: citation.pageNumber ?? '' });
                  return citation.pageId ? <button type="button" key={index} disabled={!!context.navigationDisabled || !citationCurrent(citation)}
                    title={t('Locate source')} onClick={() => locate(citation)}>{citation.name ? `${citation.name} · ` : ''}{label}{derived ? ` · ${citation.pageNumber}` : ''}</button>
                    : <span key={index}>{citation.name ? `${citation.name} · ` : ''}{label}</span>;
                })}</div>
                <details className="komo-chat-coverage"><summary>{t('Context used')}</summary>
                  <p>{t(exchange.requestContext ? scopeLabels[exchange.requestContext.scope] : 'Context pages')} · {exchange.pages?.join(', ')}{exchange.images?.length ? ` · ${t('Visual pages')}: ${exchange.images.join(', ')}` : ''}</p>
                  {exchange.requestContext?.prepared?.coverage.map((source, index) => <p className="komo-material-coverage" key={`${source.documentId}:${index}`}>
                    {source.name} · {t(source.kind === 'analysis' ? 'Text analysis · {count} pages scanned' : source.kind === 'full' ? 'Full text' : 'Relevant excerpts', { count: source.pagesScanned })}
                    {source.pages.length ? ` · ${t('Pages')}: ${source.pages.join(', ')}` : ''}</p>)}
                  {exchange.requestContext?.materials?.map(material => <details key={material.id} className="komo-material-card"><summary>{material.name} · {t('References are read-only')}</summary>
                    <div className="komo-material-card-body"><h4>{t(material.kind === 'text' ? 'Attached text' : 'PDF original')}</h4><pre>{material.text}</pre>
                      {material.generatedText ? <><h4>{t('Generated text')}</h4><pre>{material.generatedText}</pre></> : null}</div></details>)}
                </details>
              </> : exchange.status === 'pending' ? <p className="komo-chat-progress" role="status">{t(exchange.progress!)}</p>
                : <><p className={exchange.status === 'failed' ? 'komo-chat-error' : ''} role={exchange.status === 'failed' ? 'alert' : 'status'}>
                  {t(exchange.failure?.message ?? 'Stopped. You can edit your question and send it again.')}</p>
                  {!retryable ? <p className="komo-chat-stale">{t(CHAT_CONTEXT_EXPIRED)}</p> : null}
                  <div className="komo-chat-actions">
                    {exchange.failure?.retryable !== false && retryable ? <button type="button" disabled={!canSend} onClick={() => void send(exchange.prompt, scope, visualMode, exchange.requestContext)}>{t('Retry question')}</button> : null}
                    {!retryable ? <button type="button" disabled={!canSend} onClick={() => void send(exchange.prompt, exchange.requestContext?.scope ?? scope, exchange.requestContext?.visualMode ?? visualMode, undefined, exchange.requestContext)}>{t('Retry with current version')}</button> : null}
                    {exchange.failure?.action === 'account' ? <a href="/account/" target="_blank" rel="noreferrer">{t('Account')}</a> : null}
                    <button type="button" onClick={() => editQuestion(exchange.prompt)}>{t('Edit question')}</button>
                    {exchange.failure?.action === 'page' ? <button type="button" disabled={!canSend} onClick={() => void send(exchange.prompt, 'page')}>{t('Ask about current page')}</button> : null}
                    {exchange.failure?.action === 'image' ? <button type="button" disabled={!canSend} onClick={() => void send(exchange.prompt, 'page', 'always')}>{t('Ask with page image')}</button> : null}
                    {exchange.failure?.action === 'clear' ? <button type="button" disabled={busy} onClick={() => { clear(); editQuestion(exchange.prompt); }}>{t('Clear conversation')}</button> : null}
                  </div>
                </>}
            </article>
          </div>;
        })}
        {scanned ? <details className="komo-chat-scan"><summary><span translate="no">KOLMOPDF → Markdown</span> · {t('Why convert?')}</summary><p>{t(SCAN_RECOMMENDATION)}</p></details> : null}
      </div>
      {newAnswer ? <button type="button" className="komo-new-answer" onClick={() => {
        followLatest.current = true; setNewAnswer(false); if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
      }}>{t('New answer · scroll to latest')}</button> : null}
      <KomoMaterials context={context} materials={materials} onAdd={material => updateSession(previous => ({ ...previous,
        materials: [...previous.materials.filter(item => item.id !== material.id), material] }))}
        onRemove={id => updateSession(previous => ({ ...previous, materials: previous.materials.filter(material => material.id !== id) }))} />
      {suggestedQuestions.length ? <div className="komo-material-suggestions">{suggestedQuestions.map(question => <button type="button" key={question}
        onClick={() => editQuestion(question)}>{question}</button>)}</div> : null}
      <details className="komo-chat-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
        <summary>{t('Context & sharing')}{!consent ? ` · ${t('Permission needed')}` : ''}</summary>
        <div>
          <label>{t('Context')}<select value={scope} disabled={busy} onChange={event => patch({ scope: event.target.value as ChatScope })}>
            <option value="document">{t('Whole document')}</option><option value="page">{t('Current page')}</option>
            <option value="selection" disabled={!context.selectedIds.length}>{t('Selected text objects')}</option>
          </select></label>
          <label>{t('Page images')}<select value={visualMode} disabled={busy || scope === 'selection'} onChange={event => patch({ visualMode: event.target.value as ChatVisualMode })}>
            {Object.entries(visualLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select></label>
          <p>{t('Include page images for charts, diagrams and scans, even when the page also has text. Up to two pages per question.')}</p>
          <label className="komo-chat-consent"><input ref={consentInput} type="checkbox" checked={consent} disabled={busy} onChange={event => {
            patch({ consent: event.target.checked }); setNotice(''); if (!event.target.checked) authorization.revoke();
          }} /><span>{t('Allow sending the chosen PDF text, page images and recent conversation to komo when I press Send. The original PDF stays on this device.')}</span></label>
          <p>{t('Conversations stay with each open PDF in this tab. Only recent answers from its current version are shared.')}</p>
        </div>
      </details>
      {notice ? <p className="komo-chat-notice" role="status">{t(notice)}</p> : null}
      {context.disabled ? <p className="komo-chat-notice" role="status">{t(disabledReason || 'komo is unavailable right now. Check your account above or wait for the current action to finish.')}</p> : null}
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
