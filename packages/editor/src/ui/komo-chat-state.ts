import { AiClientError } from '@pdf-editor/ai-client';
import { ChatContextError, type ChatTurn } from './komo-chat-context.js';

export type ChatCitation = { pageId: string; pageNumber: number; blockId?: string; range?: { start: number; end: number } };
export type ChatFailure = { message: string; action?: 'page' | 'image' | 'clear' };
export type ChatExchange = {
  id: string; prompt: string; status: 'pending' | 'complete' | 'failed' | 'cancelled';
  answer?: string; progress?: string; failure?: ChatFailure;
  pages?: number[]; images?: number[]; citations?: ChatCitation[];
};

export function chatHistory(exchanges: readonly ChatExchange[]): ChatTurn[] {
  return exchanges.filter(item => item.status === 'complete' && item.answer).slice(-6)
    .flatMap(item => [{ role: 'user' as const, text: item.prompt }, { role: 'assistant' as const, text: item.answer! }]);
}

export function chatFailure(error: unknown): ChatFailure {
  if (error instanceof ChatContextError) return { message: error.message, ...(error.action ? { action: error.action } : {}) };
  if (error instanceof TypeError) return { message: 'Could not connect to komo. Check your connection, then retry this question.' };
  if (error instanceof AiClientError) {
    if (error.status === 429 || /^(IP_RATE_LIMIT|RATE_LIMIT|IP_CONCURRENCY_LIMIT):/.test(error.message)) {
      return { message: 'komo is receiving too many requests. Wait a moment, then retry this question.' };
    }
    if (error.status === 413 || /^(INVALID_REQUEST|PAYLOAD_TOO_LARGE):/.test(error.message)) {
      return { message: 'This request is too large or its context is unsupported. Choose the current page and try again.', action: 'page' };
    }
    if (error.status === 504 || /^REQUEST_TIMEOUT:/.test(error.message)) {
      return { message: 'komo took too long to respond. Retry this question or choose a smaller scope.' };
    }
    if (error.code === 'INVALID_SSE' || error.code === 'TRUNCATED_SSE' || error.code === 'MISSING_RESULT' || /^INVALID_MODEL_OUTPUT:/.test(error.message)) {
      return { message: 'The answer was interrupted or could not be verified. Retry this question; it was not added to the conversation context.' };
    }
  }
  return { message: 'komo is temporarily unavailable. Your question is kept here; try again later.' };
}
