import { AiClientError } from '@pdf-editor/ai-client';
import { ChatContextError, type ChatScope, type ChatTurn, type ChatVisualMode, type PreparedChatContext } from './komo-chat-context.js';
import { freezeMaterials, mergeHandoffMaterials, MaterialContextError } from './komo-materials.js';
import type { AiHandoff, AiMaterial } from './text-actions.js';

export type ChatRequestContext = {
  documentId: string; revision: number; scope: ChatScope; pageId: string | null;
  selectedIds: string[]; visualMode: ChatVisualMode;
  materials?: AiMaterial[]; history?: ChatTurn[]; prepared?: PreparedChatContext;
};
type RetryDocument = { id: string; revision: number; pageOrder: readonly string[]; permissions?: { copy: boolean } };
export const CHAT_CONTEXT_EXPIRED = 'The original context has changed. Edit this question and send it with the current material instead.';
export function canRetryContext(saved: ChatRequestContext | undefined, document: RetryDocument | null, getDocument?: (id: string) => RetryDocument | null): boolean {
  if (!saved || !document || saved.documentId !== document.id || saved.revision !== document.revision
    || (saved.scope !== 'document' && (!saved.pageId || !document.pageOrder.includes(saved.pageId)))
    || (saved.scope === 'selection' && !saved.selectedIds.length)) return false;
  const request = saved.prepared?.request;
  const sources = request?.context.sourceDocuments?.filter(source => request.context.referenceEvidence?.some(evidence => evidence.docId === source.id && evidence.revision === source.revision && evidence.kind !== 'generated'))
    ?? saved.materials?.filter(material => material.kind !== 'text').map(material => ({ id: material.documentId, revision: material.revision })) ?? [];
  return sources.every(source => {
    const current = source.id === document.id ? document : getDocument?.(source.id);
    return !!current && current.revision === source.revision && current.permissions?.copy !== false;
  });
}
export type ChatSession = {
  exchanges: ChatExchange[]; instruction: string; consent: boolean; scope: ChatScope;
  visualMode: ChatVisualMode; scanned: boolean; materials: AiMaterial[]; suggestedQuestions: string[];
};
export function createChatSession(): ChatSession {
  return { exchanges: [], instruction: '', consent: false, scope: 'document', visualMode: 'auto', scanned: false, materials: [], suggestedQuestions: [] };
}
export type KomoChatStore = { sessions: Record<string, ChatSession>; owner?: string | null; generation: number; consumed: Set<string> };
export function createKomoChatStore(): KomoChatStore { return { sessions: {}, generation: 0, consumed: new Set() }; }
/** Anonymous drafts survive the first login; another known account never inherits a conversation. */
export function synchronizeChatOwner(store: KomoChatStore, owner: string | null | undefined): boolean {
  if (owner === undefined || store.owner === owner) return false;
  const previous = store.owner;
  store.owner = owner;
  if (previous != null && previous !== owner) {
    store.sessions = {}; store.generation += 1;
  } else if (owner && previous !== owner) {
    store.sessions = Object.fromEntries(Object.entries(store.sessions).map(([id, session]) => [id, { ...session, exchanges: [], consent: false }]));
  }
  return true;
}
export function attachChatHandoff(session: ChatSession, handoff: AiHandoff): ChatSession {
  return { ...session, materials: mergeHandoffMaterials(session.materials, handoff),
    suggestedQuestions: handoff.question ? [...new Set([...session.suggestedQuestions, handoff.question])] : session.suggestedQuestions };
}
export function freezeChatRequestContext(context: ChatRequestContext): ChatRequestContext {
  const prepared = context.prepared;
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.values(value).forEach(freeze); Object.freeze(value);
  };
  if (prepared) freeze(prepared);
  return Object.freeze({ ...context, selectedIds: Object.freeze([...context.selectedIds]) as unknown as string[],
    history: Object.freeze((context.history ?? []).map(turn => Object.freeze({ ...turn }))) as unknown as ChatTurn[],
    materials: Object.freeze(freezeMaterials(context.materials ?? [])) as unknown as AiMaterial[] });
}

export type ChatCitation = {
  pageId?: string; pageNumber?: number; blockId?: string; range?: { start: number; end: number };
  documentId?: string; revision?: number; name?: string; materialId?: string; kind?: 'source' | 'generated' | 'analysis'; role?: 'attached' | 'result';
};
export type ChatFailure = { message: string; action?: 'page' | 'image' | 'clear'; retryable?: boolean };
export type ChatExchange = {
  id: string; prompt: string; status: 'pending' | 'complete' | 'failed' | 'cancelled';
  answer?: string; progress?: string; failure?: ChatFailure;
  pages?: number[]; images?: number[]; citations?: ChatCitation[]; requestContext?: ChatRequestContext;
};

export function chatHistory(exchanges: readonly ChatExchange[], revision?: number, getDocument?: (id: string) => RetryDocument | null): ChatTurn[] {
  return exchanges.filter(item => item.status === 'complete' && item.answer
    && (revision === undefined || item.requestContext?.revision === revision)
    && (!getDocument || !item.requestContext || canRetryContext(item.requestContext, getDocument(item.requestContext.documentId), getDocument))).slice(-6)
    .flatMap(item => [{ role: 'user' as const, text: item.prompt }, { role: 'assistant' as const, text: item.answer! }]);
}

export function chatFailure(error: unknown): ChatFailure {
  if (error instanceof ChatContextError) return { message: error.message, ...(error.action ? { action: error.action } : {}) };
  if (error instanceof MaterialContextError) return { message: error.message, retryable: false };
  if (error instanceof TypeError) return { message: 'Could not connect to komo. Check your connection, then retry this question.' };
  if (error instanceof AiClientError) {
    if (error.status === 401) return { message: 'Sign in again to continue.', retryable: false };
    if (error.status === 402) return { message: 'Not enough credits. Start a new conversation or upgrade to Plus.', action: 'clear', retryable: false };
    if (error.status === 429 || /^(IP_RATE_LIMIT|RATE_LIMIT|IP_CONCURRENCY_LIMIT):/.test(error.message)) return { message: 'komo is receiving too many requests. Wait a moment, then retry this question.' };
    if (error.status === 413 || /^(INVALID_REQUEST|PAYLOAD_TOO_LARGE):/.test(error.message)) return { message: 'This request is too large or its context is unsupported. Choose the current page and try again.', action: 'page' };
    if (error.status === 504 || /^REQUEST_TIMEOUT:/.test(error.message)) return { message: 'komo took too long to respond. Retry this question or choose a smaller scope.' };
    if (error.code === 'INVALID_SSE' || error.code === 'TRUNCATED_SSE' || error.code === 'MISSING_RESULT' || /^INVALID_MODEL_OUTPUT:/.test(error.message)) return { message: 'The answer was interrupted or could not be verified. Retry this question; it was not added to the conversation context.' };
  }
  return { message: 'komo is temporarily unavailable. Your question is kept here; try again later.' };
}
