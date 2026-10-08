import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AiUsage } from '@pdf-editor/contracts';

export const TOKENS_PER_CREDIT = 10_000;
export const FREE_TOKENS = 1_000 * TOKENS_PER_CREDIT;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class AccountError extends Error {
  constructor(public code: string, public statusCode: number, message: string) { super(message); }
}
type User = { id: string; spent: number; customer: string | null; subscription: string | null;
  status: string | null; paid_until: number; cancel_at_end: number };
export type AccountLease = { id: string; userId: string; reserved: number };

/** Integer token ledger: rounding is for display, not repeated per message. */
export class AccountStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, spent INTEGER NOT NULL DEFAULT 0,
        customer TEXT UNIQUE, subscription TEXT, status TEXT, paid_until INTEGER NOT NULL DEFAULT 0, cancel_at_end INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tokens INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, reserved INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS logins (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        state TEXT NOT NULL, user_id TEXT, code_hash TEXT UNIQUE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (secret TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS leases_user ON leases(user_id);`);
  }
  user(id: string): User {
    this.db.prepare('INSERT OR IGNORE INTO accounts(id) VALUES (?)').run(id);
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as User;
  }
  isMember(user: User): boolean {
    return user.status === 'active' && user.paid_until > Date.now() / 1000;
  }
  snapshot(id: string) {
    const user = this.user(id);
    const pending = this.pending(id);
    return { userId: id, plan: this.isMember(user) ? 'plus' : 'free', monthlyPrice: 4.99,
      freeCredits: FREE_TOKENS / TOKENS_PER_CREDIT, usedCredits: user.spent / TOKENS_PER_CREDIT,
      remainingCredits: Math.max(0, FREE_TOKENS - user.spent - pending) / TOKENS_PER_CREDIT,
      tokensPerCredit: TOKENS_PER_CREDIT, subscriptionStatus: user.status,
      currentPeriodEnd: user.paid_until || null, cancelAtPeriodEnd: Boolean(user.cancel_at_end) };
  }
  pending(id: string): number {
    return Number(this.db.prepare('SELECT COALESCE(SUM(reserved),0) AS total FROM leases WHERE user_id = ? AND expires > ?').get(id, Date.now())!.total);
  }
  reserve(userId: string, inputBound: number, outputLimit: number, minimumOutput = 1): { lease: AccountLease; maxOutput: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const user = this.user(userId);
      const member = this.isMember(user);
      const available = FREE_TOKENS - user.spent - this.pending(userId);
      const maxOutput = member ? outputLimit : Math.min(outputLimit, available - inputBound);
      if (maxOutput < minimumOutput) throw new AccountError('CREDITS_EXHAUSTED', 402,
        'Not enough credits. Start a new conversation or upgrade to Plus.');
      const lease = { id: randomUUID(), userId, reserved: member ? 0 : inputBound + maxOutput };
      this.db.prepare('INSERT INTO leases VALUES (?,?,?,?)').run(lease.id, userId, lease.reserved, Date.now() + 15 * 60_000);
      this.db.exec('COMMIT');
      return { lease, maxOutput };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settle(lease: AccountLease, usage: AiUsage | null, completed: boolean): void {
    const tokens = usage?.totalTokenCount ?? ((usage?.promptTokenCount ?? 0) +
      (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0));
    // Successful upstreams must report usage. Missing usage consumes the reserved bound;
    // failures with no observed usage release it. Partial observed usage is still counted.
    const hasUsage = usage && [usage.totalTokenCount, usage.promptTokenCount, usage.candidatesTokenCount, usage.thoughtsTokenCount]
      .some(value => value !== undefined);
    const charged = Math.max(0, hasUsage ? tokens : (completed ? lease.reserved : 0));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO usage VALUES (?,?,?,?)').run(lease.id, lease.userId, charged, Date.now());
      if (result.changes) this.db.prepare('UPDATE accounts SET spent = spent + ? WHERE id = ?').run(charged, lease.userId);
      this.db.prepare('DELETE FROM leases WHERE id = ?').run(lease.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createSession(userId: string): string {
    this.user(userId);
    const token = 'komo_' + randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), userId, Date.now() + 30 * 86400_000);
    return token;
  }
  createLogin(challenge: string, redirectUri: string, state: string): string {
    const id = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO logins VALUES (?,?,?,?,NULL,NULL,?)').run(id, challenge, redirectUri, state, Date.now() + 10 * 60_000);
    return id;
  }
  completeLogin(id: string, userId: string): string {
    const login = this.db.prepare('SELECT redirect_uri, state FROM logins WHERE id = ? AND user_id IS NULL AND expires > ?')
      .get(id, Date.now()) as { redirect_uri: string; state: string } | undefined;
    if (!login) throw new AccountError('LOGIN_EXPIRED', 400, 'Sign-in expired. Please try again.');
    const code = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE logins SET user_id = ?, code_hash = ? WHERE id = ?').run(userId, hash(code), id);
    const redirect = new URL(login.redirect_uri);
    redirect.searchParams.set('code', code); redirect.searchParams.set('state', login.state);
    return redirect.href;
  }
  exchangeLogin(code: string, verifier: string, redirectUri: string): string {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const login = this.db.prepare('SELECT * FROM logins WHERE code_hash = ? AND expires > ?').get(hash(code), Date.now()) as
        { id: string; user_id: string; challenge: string; redirect_uri: string } | undefined;
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!login || login.challenge !== challenge || login.redirect_uri !== redirectUri) {
        throw new AccountError('INVALID_LOGIN', 400, 'Unable to sign in. Please try again.');
      }
      const token = this.createSession(login.user_id);
      this.db.prepare('DELETE FROM logins WHERE id = ?').run(login.id);
      this.db.exec('COMMIT');
      return token;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  session(token: string): string | undefined {
    return this.db.prepare('SELECT user_id FROM sessions WHERE secret = ? AND expires > ?').get(hash(token), Date.now())?.user_id as string | undefined;
  }
  revoke(token: string): void { this.db.prepare('DELETE FROM sessions WHERE secret = ?').run(hash(token)); }
  setCustomer(id: string, customer: string): void {
    this.user(id); this.db.prepare('UPDATE accounts SET customer = ? WHERE id = ?').run(customer, id);
  }
  customerUser(customer: string): string | undefined {
    return this.db.prepare('SELECT id FROM accounts WHERE customer = ?').get(customer)?.id as string | undefined;
  }
  setSubscription(id: string, subscription: string, status: string, until: number, cancel: boolean): void {
    this.db.prepare('UPDATE accounts SET subscription = ?, status = ?, paid_until = ?, cancel_at_end = ? WHERE id = ?').run(subscription, status, until, Number(cancel), id);
  }
  close(): void { this.db.close(); }
}
