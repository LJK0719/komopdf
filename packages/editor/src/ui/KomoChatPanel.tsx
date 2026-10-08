import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Trash2 } from 'lucide-react';
import { AiWorkflow, DocumentAiAuthorization, resolveCitation } from '@pdf-editor/ai-client';
import type { EditorAiContext } from './EditorShell.js';
import { AiMarkdown } from './AiMarkdown.js';
import { useI18n } from './i18n.js';
import { CHAT_COPY_RESTRICTED, ChatContextError, prepareChatContext, SCAN_RECOMMENDATION, type ChatScope, type ChatVisualMode } from './komo-chat-context.js';
import { chatFailure, chatHistory, type ChatExchange, type ChatCitation } from './komo-chat-state.js';
import './komo-chat.css';

type Props = { context: EditorAiContext; endpoint?: string; fetch?: typeof fetch; onComplete?(): void };
const scopeLabels = { document: 'Whole document', page: 'Current page', selection: 'Selected text objects' };
const visualLabels = { auto: 'Automatic images', always: 'Include page images', text: 'Text only' };

/** A document revision owns one in-memory conversation; no task or session store. */
export function KomoChatPanel(props: Props) {
  return <Chat key={`${props.context.document?.id ?? 'empty'}:${props.context.document?.revision ?? 0}:${props.context.document?.permissions.copy === true}`} {...props} />;
}

function Chat({ context, endpoint = '/api/v1/ai/requests', fetch, onComplete }: Props) {
  const { t } = useI18n();
  const latest = useRef(context); latest.current = context;
  const controller = useRef<AbortController | null>(null);
  const [authorization] = useState(() => new DocumentAiAuthorization(context.document?.id ?? 'empty'));
  const [consent, setConsent] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [scope, setScope] = useState<ChatScope>('document');
  const [visualMode, setVisualMode] = useState<ChatVisualMode>('auto');
  const [exchanges, setExchanges] = useState<ChatExchange[]>([]);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [newAnswer, setNewAnswer] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const sources = context.document?.sourceIds ?? [];
  const canCopy = context.document?.permissions.copy === true;
  const canRun = consent && canCopy && !!context.document && !context.disabled && !busy;

  useEffect(() => () => { controller.current?.abort(); authorization.revoke(); }, [authorization]);
  useEffect(() => {
    const list = transcript.current;
    if (!list) return;
    if (followLatest.current) {
      const answer = list.querySelector<HTMLElement>('.komo-chat-exchange:last-child .komo-chat-assistant');
      if (exchanges.at(-1)?.status === 'complete' && answer) {
        list.scrollTop += answer.getBoundingClientRect().top - list.getBoundingClientRect().top - 4;
      } else list.scrollTop = list.scrollHeight;
    } else if (exchanges.at(-1)?.status !== 'pending') setNewAnswer(true);
  }, [exchanges]);

  const update = (id: string, value: Partial<ChatExchange>) => {
    setExchanges(items => items.map(item => item.id === id ? { ...item, ...value } : item));
  };
  const send = async (question = instruction, nextScope = scope, nextVisualMode = visualMode) => {
    const prompt = question.trim();
    if (!canRun || !prompt || controller.current || !context.document) return;
    const abort = new AbortController(); controller.current = abort;
    const id = crypto.randomUUID();
    setBusy(true); setSettingsOpen(false); setScope(nextScope); setVisualMode(nextVisualMode);
    if (question === instruction) setInstruction('');
    followLatest.current = true; setNewAnswer(false);
    setExchanges(items => [...items, { id, prompt, status: 'pending', progress: 'Reading the selected context…' }]);
    input.current?.focus();
    try {
      authorization.enable(sources);
      const prepared = await prepareChatContext({
        engine: context.engine, document: context.document, page: context.page,
        selectedIds: context.selectedIds, scope: nextScope, visualMode: nextVisualMode, instruction: prompt,
        history: chatHistory(exchanges), signal: abort.signal,
      });
      abort.signal.throwIfAborted();
      if (latest.current.document?.permissions.copy !== true) throw new ChatContextError(CHAT_COPY_RESTRICTED);
      setScanned(prepared.scanned);
      update(id, { progress: 'komo is preparing an answer…', pages: prepared.pageNumbers, images: prepared.imagePageNumbers });
      const workflow = new AiWorkflow({
        endpoint, authorization, ...(fetch ? { fetch } : {}),
        getCurrentDocument: () => latest.current.document ?? { id: '', revision: -1 },
        nextTransactionId: () => crypto.randomUUID(),
        apply: async () => { throw new Error('Web komo is read-only'); },
      });
      const outcome = await workflow.run({ request: prepared.request, snapshot: prepared.snapshot,
        sourceIds: sources, signal: abort.signal });
      abort.signal.throwIfAborted();
      const document = latest.current.document;
      if (!document || document.id !== context.document.id || document.revision !== context.document.revision) return;
      const result = outcome.response.result;
      if (result.kind !== 'answer' && result.kind !== 'clarification') throw new Error('Unexpected answer type');
      const citations: ChatCitation[] = result.kind === 'answer' ? result.citations.flatMap(citation => {
        const resolved = resolveCitation(prepared.snapshot, citation, document);
        if (resolved.status !== 'resolved' || !resolved.currentLocation) return [];
        const location = resolved.currentLocation;
        return [{ pageId: location.pageId, pageNumber: location.pageNumber, blockId: location.blockId,
          range: { start: location.range[0], end: location.range[1] } }];
      }) : [];
      for (const pageNumber of prepared.imagePageNumbers) {
        if (!citations.some(citation => citation.pageNumber === pageNumber)) citations.push({ pageId: document.pageOrder[pageNumber - 1]!, pageNumber });
      }
      update(id, { status: 'complete', answer: result.kind === 'answer' ? result.text : result.question, citations });
    } catch (caught) {
      if (abort.signal.aborted) update(id, { status: 'cancelled' });
      else {
        if (caught instanceof ChatContextError) setScanned(caught.scanned);
        update(id, { status: 'failed', failure: chatFailure(caught) });
      }
    } finally { controller.current = null; setBusy(false); onComplete?.(); }
  };
  const editQuestion = (prompt: string) => { setInstruction(prompt); input.current?.focus(); };
  const locate = (citation: ChatCitation) => {
    if (citation.blockId) context.locateText?.(citation.pageId, citation.blockId, citation.range);
    else void context.navigatePage?.(citation.pageId);
  };

  return <section className="komo-chat" aria-label="komo">
    <header className="komo-chat-heading"><span className="komo-chat-avatar" aria-hidden="true">k</span>
      <h2 translate="no">komo</h2><span className="komo-chat-tag">{t('PDF Q&A')}</span>
      <button type="button" className="icon-button" aria-label={t('Clear conversation')} title={t('Clear conversation')}
        disabled={busy || !exchanges.length} onClick={() => { setExchanges([]); setScanned(false); setNewAnswer(false); }}><Trash2 size={16} aria-hidden="true" /></button>
    </header>
    {!context.document ? <p>{t('Open a PDF before asking komo.')}</p>
      : !canCopy ? <p role="status">{t(CHAT_COPY_RESTRICTED)}</p> : <>
      <details className="komo-chat-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
        <summary>{t(scopeLabels[scope])} · {t(visualLabels[visualMode])}{!consent ? ` · ${t('Permission needed')}` : ''}</summary>
        <div>
          <label>{t('Context')}<select value={scope} disabled={busy} onChange={event => setScope(event.target.value as ChatScope)}>
            <option value="document">{t('Whole document')}</option><option value="page">{t('Current page')}</option>
            <option value="selection" disabled={!context.selectedIds.length}>{t('Selected text objects')}</option>
          </select></label>
          <label>{t('Page images')}<select value={visualMode} disabled={busy || scope === 'selection'} onChange={event => setVisualMode(event.target.value as ChatVisualMode)}>
            {Object.entries(visualLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select></label>
          <p>{t('Include page images for charts, diagrams and scans, even when the page also has text. Up to two pages per question.')}</p>
          <label className="komo-chat-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => {
            setConsent(event.target.checked); setSettingsOpen(!event.target.checked); if (!event.target.checked) authorization.revoke();
          }} /><span>{t('Allow sending the chosen PDF text, page images and recent conversation to komo when I press Send. The original PDF stays on this device.')}</span></label>
          <p>{t('Only in this tab. The latest six exchanges are used for follow-up questions. Editing or switching the PDF starts a fresh conversation.')}</p>
        </div>
      </details>
      <div className="komo-chat-transcript" ref={transcript} role="log" aria-live="polite" aria-relevant="additions text" onScroll={() => {
        const list = transcript.current!;
        followLatest.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
        if (followLatest.current) setNewAnswer(false);
      }}>
        {!exchanges.length && <div className="komo-chat-empty"><h3>{t('Read together. Ask a little more.')}</h3>
          <p>{t('Summarize, clarify a passage, or ask a follow-up. Web komo answers questions; it does not edit your PDF.')}</p>
          <div className="komo-chat-suggestions">{['Summarize this document', 'What are the key takeaways?'].map(prompt =>
            <button type="button" key={prompt} disabled={busy} onClick={() => editQuestion(t(prompt))}>{t(prompt)}</button>)}</div>
        </div>}
        {exchanges.map(exchange => <div className="komo-chat-exchange" key={exchange.id}>
          <article className="komo-chat-message komo-chat-user"><strong>{t('You')}</strong><p>{exchange.prompt}</p></article>
          <article className="komo-chat-message komo-chat-assistant" aria-busy={exchange.status === 'pending'}>
            <strong translate="no">komo</strong>
            {exchange.status === 'complete' ? <>
              <AiMarkdown text={exchange.answer!} />
              <div className="komo-chat-citations">{exchange.citations?.map((citation, index) => <button type="button" key={index}
                disabled={context.disabled} title={t(citation.blockId ? 'Locate cited text' : 'View image page')}
                onClick={() => locate(citation)}>{t(citation.blockId ? 'Source · page {page}' : 'Image · page {page}', { page: citation.pageNumber })}</button>)}</div>
              <details className="komo-chat-coverage"><summary>{t('Context used')}</summary>
                <p>{t('Context pages')}: {exchange.pages?.join(', ')}{exchange.images?.length ? ` · ${t('Visual pages')}: ${exchange.images.join(', ')}` : ''}</p>
              </details>
            </> : exchange.status === 'pending' ? <p className="komo-chat-progress" role="status">{t(exchange.progress!)}</p>
              : <><p className={exchange.status === 'failed' ? 'komo-chat-error' : ''} role={exchange.status === 'failed' ? 'alert' : 'status'}>
                {t(exchange.failure?.message ?? 'Stopped. You can edit your question and send it again.')}</p>
                <div className="komo-chat-actions">
                  {exchange.failure?.retryable !== false ? <button type="button" disabled={!canRun} onClick={() => void send(exchange.prompt)}>{t('Retry question')}</button> : null}
                  <button type="button" onClick={() => editQuestion(exchange.prompt)}>{t('Edit question')}</button>
                  {exchange.failure?.action === 'page' ? <button type="button" disabled={!canRun} onClick={() => void send(exchange.prompt, 'page')}>{t('Ask about current page')}</button> : null}
                  {exchange.failure?.action === 'image' ? <button type="button" disabled={!canRun} onClick={() => void send(exchange.prompt, 'page', 'always')}>{t('Ask with page image')}</button> : null}
                  {exchange.failure?.action === 'clear' ? <button type="button" disabled={busy} onClick={() => { setExchanges([]); setScanned(false); setNewAnswer(false); editQuestion(exchange.prompt); }}>{t('Clear conversation')}</button> : null}
                </div>
              </>}
          </article>
        </div>)}
      </div>
      {newAnswer ? <button type="button" className="komo-new-answer" onClick={() => {
        followLatest.current = true; setNewAnswer(false); if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
      }}>{t('New answer · scroll to latest')}</button> : null}
      {scanned ? <details className="komo-chat-scan"><summary><span translate="no">KOLMOPDF → Markdown</span> · {t('Why convert?')}</summary><p>{t(SCAN_RECOMMENDATION)}</p></details> : null}
      {!consent ? <button type="button" className="komo-sharing-reminder" onClick={() => setSettingsOpen(true)}>{t('Review sharing settings before sending')}</button> : null}
      <form className="komo-chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="komo-question">{t('Message')}</label>
        <textarea ref={input} id="komo-question" name="question" autoComplete="off" rows={2} maxLength={16000} value={instruction} disabled={context.disabled}
          placeholder={t('Ask komo to help with your PDF…')} onChange={event => setInstruction(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
          }} />
        <div><small>{t('Enter to send · Shift+Enter for a new line')}</small>{busy
          ? <button type="button" className="button button-quiet" onClick={() => controller.current?.abort()}><Square size={14} aria-hidden="true" />{t('Stop')}</button>
          : <button type="submit" className="button button-primary" disabled={!canRun || !instruction.trim()}><ArrowUp size={16} aria-hidden="true" />{t('Send')}</button>}</div>
      </form>
    </>}
  </section>;
}
