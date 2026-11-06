'use client';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Send } from 'lucide-react';
import type { SupportClient, SupportCopy, SupportTicket, SupportStatus, MailState } from './types';

export function SupportDesk({ client, copy: c, signInHref }: { client: SupportClient; copy: SupportCopy; signInHref: string }) {
  const [allowed, setAllowed] = useState<boolean | null>(null); const [items, setItems] = useState<SupportTicket[]>([]); const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [status, setStatus] = useState(''); const [kind, setKind] = useState(''); const [body, setBody] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const replyId = useRef(''); const selection = useRef('');
  useEffect(() => { let live = true; client.request<{ isAdmin: boolean }>('session').then(result => { if (live) setAllowed(result.isAdmin); }).catch(() => { if (live) setAllowed(false); }); return () => { live = false; }; }, [client]);
  useEffect(() => { if (!allowed) return; let live = true; client.request<SupportTicket[]>('admin.list', { ...(status ? { status } : {}), ...(kind ? { kind } : {}) }).then(result => { if (live) setItems(result); }).catch(() => { if (live) setError(c.error); }); return () => { live = false; }; }, [allowed, status, kind, client, c.error]);
  async function refresh(id = selection.current) {
    const result = await client.request<SupportTicket[]>('admin.list', { ...(status ? { status } : {}), ...(kind ? { kind } : {}) }); setItems(result);
    if (id) { const detail = await client.request<SupportTicket>('detail', { id }); if (selection.current === id) setTicket(detail); }
  }
  async function pick(id: string) {
    selection.current = id; setTicket(null); setBody(''); replyId.current = ''; setNotice(''); setError('');
    try { const detail = await client.request<SupportTicket>('detail', { id }); if (selection.current === id) setTicket(detail); } catch { setError(c.error); }
  }
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); await refresh(); } catch { setError(c.error); } finally { setBusy(false); }
  }
  async function reply(event: React.FormEvent) {
    event.preventDefault(); if (!ticket || !body.trim()) return; replyId.current ||= crypto.randomUUID();
    await action(async () => { await client.request('admin.reply', { id: ticket.id, messageId: replyId.current, body }); setBody(''); replyId.current = ''; setNotice(c.replySaved); });
  }
  const statusLabel = (value: string) => c[`${value}Status`] || value;
  const mailLabel = (value: MailState) => value === 'sent' ? c.mailSent : value === 'failed' ? c.mailFailed : value === 'sending' ? c.mailSending : c.mailPending;
  return <section className="komo-support-admin"><div className="komo-support-section"><h1>{c.adminTitle}</h1>{allowed ? <button type="button" aria-label={c.refresh} disabled={busy} onClick={() => void action(() => refresh())}><RefreshCw size={18} /></button> : null}</div>
    {allowed === false ? <div><p>{c.adminSignIn}</p><a href={signInHref}>{c.signIn}</a></div> : null}
    {allowed ? <><div className="komo-support-admin-filters"><label>{c.status} <select aria-label={c.status} value={status} onChange={event => setStatus(event.target.value)}><option value="">{c.all}</option>{['open','active','resolved'].map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label><select aria-label={c.all} value={kind} onChange={event => setKind(event.target.value)}><option value="">{c.all}</option><option value="support">{c.supportKind}</option><option value="feedback">{c.feedbackKind}</option></select></div>
      <div className="komo-support-admin-grid"><div className="komo-support-admin-list">{items.length ? items.map(item => <button type="button" className="komo-support-ticket" key={item.id} onClick={() => void pick(item.id)} aria-pressed={ticket?.id === item.id} disabled={busy}><span><small>{item.reference}</small><strong>{item.subject}</strong><small>{item.kind === 'feedback' ? c.feedbackKind : c.supportKind}</small></span><span className="komo-support-status">{statusLabel(item.status)}</span></button>) : <p>{c.empty}</p>}{items.length === 100 ? <small>{c.loadMore}</small> : null}</div>
      <div className="komo-support-admin-detail">{ticket ? <><small>{ticket.reference} · {ticket.email}</small><h2>{ticket.subject}</h2><label>{c.status} <select value={ticket.status} disabled={busy} onChange={event => { const value = event.target.value as SupportStatus; void action(() => client.request('admin.status', { id: ticket.id, status: value })); }}>{['open','active','resolved'].map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label><div className="komo-support-thread">{ticket.messages?.map(message => <article className={`komo-support-note ${message.author}`} key={message.id}><strong>{message.author === 'staff' ? c.staff : c.youLabel}</strong><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleString()}</time>{(['team','customer'] as const).map(target => { const state = target === 'team' ? message.teamMail : message.customerMail; return state === 'skip' ? null : <div className="komo-support-delivery" key={target}><span>{target === 'team' ? c.teamMail : c.customerMail}: {mailLabel(state)}</span>{state === 'failed' || state === 'pending' ? <button type="button" disabled={busy} onClick={() => void action(() => client.request('admin.retry', { id: ticket.id, messageId: message.id }))}>{c.resend}</button> : null}</div>; })}</article>)}</div><form className="komo-support-form" onSubmit={reply}><label>{c.reply}<textarea required maxLength={12000} rows={5} value={body} onChange={event => setBody(event.target.value)} /></label><button type="submit" className="komo-support-primary" disabled={busy || !body.trim()}>{busy ? c.sending : c.send}<Send size={16} /></button></form></> : <p className="komo-support-muted">{c.select}</p>}</div></div></> : null}
    {notice ? <p role="status">{notice}</p> : null}{error ? <p className="komo-support-error" role="alert">{error}</p> : null}
  </section>;
}
