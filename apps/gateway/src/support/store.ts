import { DatabaseSync } from 'node:sqlite';
import { SupportError, type SupportIdentity, type SupportStore } from './engine.js';
type Row = Record<string, unknown>;
const row = (value: Row): Row => Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()), item]));
export class SupportSqliteStore implements SupportStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS support_tickets(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,owner_key TEXT NOT NULL,user_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('support','feedback')),email TEXT NOT NULL,locale TEXT NOT NULL,subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','active','resolved')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS support_owner_updated ON support_tickets(owner_key,updated_at DESC);
      CREATE INDEX IF NOT EXISTS support_status_updated ON support_tickets(status,updated_at DESC);
      CREATE TABLE IF NOT EXISTS support_messages(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
        author TEXT NOT NULL CHECK(author IN ('customer','staff')),body TEXT NOT NULL,team_mail TEXT NOT NULL DEFAULT 'pending',customer_mail TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS support_message_ticket ON support_messages(ticket_id,created_at,id);`);
  }
  private require(actor: SupportIdentity, id: string) {
    const ticket = this.db.prepare('SELECT * FROM support_tickets WHERE id=? AND (owner_key=? OR ?=1)').get(id,actor.key,Number(actor.isAdmin));
    if (!ticket) throw new SupportError(404,'NOT_FOUND');
    return ticket;
  }
  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(actor: SupportIdentity, admin = false, status?: 'open' | 'active' | 'resolved', kind?: 'support' | 'feedback') {
    if (admin && !actor.isAdmin) throw new SupportError(403,'FORBIDDEN');
    return this.db.prepare(`SELECT id,reference,kind,subject,status,locale,created_at,updated_at FROM support_tickets
      WHERE (?=1 OR owner_key=?) AND (? IS NULL OR status=?) AND (? IS NULL OR kind=?) ORDER BY updated_at DESC LIMIT 100`)
      .all(Number(admin),actor.key,status ?? null,status ?? null,kind ?? null,kind ?? null).map(item => row(item));
  }
  detail(actor: SupportIdentity, id: string): Row & { messages: Row[] } {
    const ticket = this.require(actor,id);
    return { ...row(ticket), messages: this.db.prepare('SELECT * FROM support_messages WHERE ticket_id=? ORDER BY created_at,id').all(id).map(item => row(item)) };
  }
  create(actor: SupportIdentity, input: { id: string; kind: 'support' | 'feedback'; email: string; locale: string; subject: string; body: string }) {
    return this.atomic(() => {
      const now = new Date().toISOString();
      const result = this.db.prepare(`INSERT INTO support_tickets(id,reference,owner_key,user_id,kind,email,locale,subject,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(input.id,`KMP-S-${input.id.replaceAll('-','').slice(0,12).toUpperCase()}`,actor.key,actor.userId,input.kind,input.email,input.locale,input.subject,now,now);
      const ticket = this.require(actor,input.id);
      if (ticket.owner_key !== actor.key) throw new SupportError(403,'FORBIDDEN');
      if (result.changes) this.db.prepare('INSERT INTO support_messages(id,ticket_id,author,body,created_at) VALUES(?,?,?,?,?)').run(input.id,input.id,'customer',input.body,now);
      return { id: input.id, messageId: input.id };
    });
  }
  append(actor: SupportIdentity, ticketId: string, id: string, body: string, staff = false) {
    if (staff && !actor.isAdmin) throw new SupportError(403,'FORBIDDEN');
    return this.atomic(() => {
      const ticket = this.require(actor,ticketId);
      if (!staff && ticket.owner_key !== actor.key) throw new SupportError(403,'FORBIDDEN');
      const now = new Date().toISOString();
      const result = this.db.prepare(`INSERT INTO support_messages(id,ticket_id,author,body,team_mail,customer_mail,created_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(id,ticketId,staff ? 'staff' : 'customer',body,staff ? 'skip' : 'pending',staff ? 'pending' : 'skip',now);
      const message = this.db.prepare('SELECT ticket_id,author FROM support_messages WHERE id=?').get(id);
      if (message?.ticket_id !== ticketId || message.author !== (staff ? 'staff' : 'customer')) throw new SupportError(409,'CONFLICT');
      if (result.changes) this.db.prepare('UPDATE support_tickets SET status=?,updated_at=? WHERE id=?').run(staff ? 'active' : 'open',now,ticketId);
      return { id: ticketId, messageId: id };
    });
  }
  status(actor: SupportIdentity, id: string, status: 'open' | 'active' | 'resolved') {
    if (!actor.isAdmin) throw new SupportError(403,'FORBIDDEN');
    this.require(actor,id); this.db.prepare('UPDATE support_tickets SET status=?,updated_at=? WHERE id=?').run(status,new Date().toISOString(),id);
    return { id,status };
  }
  claimMail(actor: SupportIdentity, ticketId: string, messageId: string, target: 'team' | 'customer', retry = false) {
    if (retry && !actor.isAdmin) throw new SupportError(403,'FORBIDDEN');
    this.require(actor,ticketId);
    const column = target === 'team' ? 'team_mail' : 'customer_mail';
    return Boolean(this.db.prepare(`UPDATE support_messages SET ${column}='sending' WHERE id=? AND ticket_id=? AND (${column}='pending' OR (?=1 AND ${column}='failed'))`).run(messageId,ticketId,Number(retry)).changes);
  }
  markMail(actor: SupportIdentity, messageId: string, target: 'team' | 'customer', sent: boolean) {
    const message = this.db.prepare('SELECT ticket_id FROM support_messages WHERE id=?').get(messageId);
    if (!message) throw new SupportError(404,'NOT_FOUND');
    this.require(actor,String(message.ticket_id));
    const column = target === 'team' ? 'team_mail' : 'customer_mail';
    this.db.prepare(`UPDATE support_messages SET ${column}=? WHERE id=? AND ${column}='sending'`).run(sent ? 'sent' : 'failed',messageId);
  }
  close() { this.db.close(); }
}
