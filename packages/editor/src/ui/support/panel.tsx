'use client';
import { useEffect, useRef, useState } from 'react';
import { Bot, X, ArrowLeft, Send, MessageSquare, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessage, SupportClient, SupportCopy, SupportTicket } from './types';

export type SupportPanelProps = { open: boolean; onClose(): void; client: SupportClient; copy: SupportCopy; product: string; adminHref?: string };
export function SupportPanel({ open, onClose, client, copy: c, product, adminHref }: SupportPanelProps) {
  const dialog = useRef<HTMLDialogElement>(null); const scroll = useRef<HTMLDivElement>(null); const abort = useRef<AbortController | null>(null);
  const [admin, setAdmin] = useState(false);
  const [ready, setReady] = useState(false); const [view, setView] = useState<'chat' | 'support' | 'feedback' | 'list' | 'detail'>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>([]); const [draft, setDraft] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [email, setEmail] = useState(''); const [subject, setSubject] = useState(''); const [body, setBody] = useState('');
  const [include, setInclude] = useState(false); const [transcript, setTranscript] = useState(''); const [ticket, setTicket] = useState<SupportTicket | null>(null); const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const submission = useRef(''); const replyId = useRef('');
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); else if (!open) dialog.current?.close(); }, [open]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (!open) return; let live = true; client.request<{ isAdmin: boolean }>('session').then(result => { if (live) { setReady(true); setAdmin(result.isAdmin); } }).catch(() => { if (live) setError(c.error); }); return () => { live = false; }; }, [open, client, c.error]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }, [messages, view, ticket]);
  const status = (value: string) => c[`${value}Status`] || value;
  function form(kind: 'support' | 'feedback') {
    setError(''); setView(kind); submission.current = crypto.randomUUID(); setSubject(''); setBody(''); setInclude(false);
    setTranscript(messages.map(message => `${message.role === 'user' ? c.youLabel : c.komoLabel}: ${message.content}`).join('\n\n').slice(0,12000));
  }
  async function list() {
    setError(''); setBusy(true);
    try { setTickets(await client.request<SupportTicket[]>('list')); setView('list'); } catch { setError(c.error); } finally { setBusy(false); }
  }
  async function detail(id: string) {
    setError(''); setBusy(true);
    try { setTicket(await client.request<SupportTicket>('detail', { id })); setView('detail'); replyId.current = ''; } catch { setError(c.error); } finally { setBusy(false); }
  }
  async function sendChat(event: React.FormEvent) {
    event.preventDefault(); if (!draft.trim() || busy || !ready) return;
    setError(''); setBusy(true); const next = [...messages.filter(message => message.content.trim()), { role: 'user' as const, content: draft.trim() }].slice(-13);
    setMessages([...next, { role: 'assistant', content: '' }]); setDraft(''); const controller = new AbortController(); abort.current = controller;
    try { await client.chat(next, content => setMessages([...next, { role: 'assistant', content }]), controller.signal); }
    catch { if (!controller.signal.aborted) setError(c.slow); }
    finally { setBusy(false); abort.current = null; }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy || !ready) return; setBusy(true); setError('');
    submission.current ||= crypto.randomUUID();
    try {
      const result = await client.request<SupportTicket>('create', { id: submission.current, kind: view, email, subject, body: include && transcript.trim() ? `${body}\n\n${c.conversation}\n${transcript}` : body });
      setTicket(result); setBody(''); setView('detail'); submission.current = ''; replyId.current = '';
    } catch { setError(c.error); } finally { setBusy(false); }
  }
  async function reply(event: React.FormEvent) {
    event.preventDefault(); if (!ticket || !body.trim() || busy) return; setBusy(true); setError(''); replyId.current ||= crypto.randomUUID();
    try { setTicket(await client.request<SupportTicket>('message', { id: ticket.id, messageId: replyId.current, body })); setBody(''); replyId.current = ''; }
    catch { setError(c.error); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="komo-support-dialog" aria-labelledby="komo-support-title" onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <header className="komo-support-header"><div><Bot size={20} /><strong id="komo-support-title">{c.title}</strong></div><button type="button" onClick={onClose} aria-label={c.close}><X size={19} /></button></header>
    <nav className="komo-support-tabs" aria-label={c.open}><button type="button" aria-pressed={view === 'chat'} onClick={() => { setView('chat'); setError(''); }}>{c.chat}</button><button type="button" disabled={busy || !ready} onClick={() => form('support')}>{c.human}</button><button type="button" disabled={busy || !ready} onClick={() => form('feedback')}>{c.feedback}</button><button type="button" disabled={busy || !ready} onClick={() => void list()}>{c.tickets}</button>{admin && adminHref ? <a href={adminHref}>{c.adminTitle}</a> : null}</nav>
    <div className="komo-support-content" ref={scroll}>
      {view === 'chat' ? <><div className="komo-support-welcome"><Bot size={30} /><h2>{c.welcome}</h2><p>{c.placeholder.replace('{product}', product)}</p></div><div className="komo-support-messages" role="log" aria-live="polite">{messages.map((message, index) => <div className={`komo-support-bubble ${message.role}`} key={index}>{message.content ? <ReactMarkdown>{message.content}</ReactMarkdown> : <span aria-label={c.sending}>•••</span>}</div>)}</div></> : null}
      {view === 'support' || view === 'feedback' ? <form className="komo-support-form" onSubmit={submit}><h2>{view === 'support' ? c.human : c.feedback}</h2><label>{c.email}<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label><label>{c.subject}<input required maxLength={160} value={subject} onChange={event => setSubject(event.target.value)} /></label><label>{c.message}<textarea required rows={5} maxLength={10000} value={body} onChange={event => setBody(event.target.value)} /></label>{messages.length ? <><label className="komo-support-check"><input type="checkbox" checked={include} onChange={event => setInclude(event.target.checked)} />{c.includeChat}</label>{include ? <label>{c.conversation}<textarea rows={5} maxLength={12000} value={transcript} onChange={event => setTranscript(event.target.value)} /></label> : null}</> : null}<button className="komo-support-primary" disabled={busy || !ready} type="submit">{busy ? c.sending : c.submit}<Send size={15} /></button></form> : null}
      {view === 'list' ? <><div className="komo-support-section"><h2>{c.tickets}</h2><button type="button" onClick={() => void list()} disabled={busy} aria-label={c.refresh}><RefreshCw size={16} /></button></div>{tickets.length ? tickets.map(item => <button className="komo-support-ticket" type="button" key={item.id} onClick={() => { setBody(''); void detail(item.id); }} disabled={busy}><span><small>{item.reference}</small><strong>{item.subject}</strong></span><span className="komo-support-status">{status(item.status)}</span></button>) : <p className="komo-support-muted">{c.empty}</p>}</> : null}
      {view === 'detail' && ticket ? <><div className="komo-support-section"><button type="button" onClick={() => void list()} aria-label={c.back}><ArrowLeft size={17} /></button><span className="komo-support-status">{status(ticket.status)}</span><button type="button" onClick={() => void detail(ticket.id)} disabled={busy} aria-label={c.refresh}><RefreshCw size={16} /></button></div><small>{ticket.reference}</small><h2>{ticket.subject}</h2><div className="komo-support-thread">{ticket.messages?.map(message => <article className={`komo-support-note ${message.author}`} key={message.id}><strong>{message.author === 'staff' ? c.staff : c.customer}</strong><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleString()}</time></article>)}</div><form className="komo-support-form" onSubmit={reply}><label>{c.reply}<textarea required rows={3} maxLength={12000} value={body} onChange={event => setBody(event.target.value)} /></label><button className="komo-support-primary" type="submit" disabled={busy || !body.trim()}>{busy ? c.sending : c.send}<Send size={15} /></button></form></> : null}
    </div>
    {error ? <p className="komo-support-error" role="alert">{error}</p> : null}
    {view === 'chat' ? <form className="komo-support-composer" onSubmit={sendChat}><textarea aria-label={c.message} placeholder={c.placeholder.replace('{product}', product)} maxLength={5000} rows={2} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button className="komo-support-primary" type="submit" disabled={busy || !ready || !draft.trim()} aria-label={c.send}><Send size={17} /></button></form> : null}
  </dialog>;
}
export function SupportLauncher({ onClick, label }: { onClick(): void; label: string }) {
  return <button type="button" className="komo-support-launcher" aria-label={label} title={label} onClick={onClick}><MessageSquare size={20} /><span>{label}</span></button>;
}
