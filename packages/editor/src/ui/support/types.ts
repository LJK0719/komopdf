export type SupportCopy = Record<string, string> & {
  title: string; open: string; close: string; welcome: string; placeholder: string; send: string; sending: string; human: string; feedback: string; tickets: string; chat: string;
  email: string; subject: string; message: string; includeChat: string; conversation: string; submit: string; submitted: string; back: string; empty: string;
  staff: string; customer: string; reply: string; refresh: string; error: string; slow: string; adminTitle: string; all: string; supportKind: string; feedbackKind: string;
  status: string; save: string; mailSent: string; mailFailed: string; mailPending: string; mailSending: string; resend: string; teamMail: string; customerMail: string;
  select: string; adminSignIn: string; signIn: string; youLabel: string; komoLabel: string; replySaved: string; loadMore: string;
};
export type SupportStatus = 'open' | 'active' | 'resolved';
export type MailState = 'pending' | 'sending' | 'sent' | 'failed' | 'skip';
export type SupportMessage = { id: string; author: 'customer' | 'staff'; body: string; createdAt: string; teamMail: MailState; customerMail: MailState };
export type SupportTicket = { id: string; reference: string; kind: 'support' | 'feedback'; subject: string; status: SupportStatus; locale: string; createdAt: string; updatedAt: string; email?: string; messages?: SupportMessage[] };
export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export interface SupportClient {
  request<T>(action: string, input?: Record<string, unknown>): Promise<T>;
  chat(messages: ChatMessage[], onText: (text: string) => void, signal: AbortSignal): Promise<void>;
}
export function browserSupportClient(locale: string, fetcher: typeof fetch = fetch): SupportClient {
  return {
    async request<T>(action: string, input: Record<string, unknown> = {}) {
      const response = await fetcher('/api/support', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, action, locale }) });
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json()).data as T;
    },
    async chat(messages, onText, signal) {
      const response = await fetcher('/api/support/chat', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, locale }), signal });
      if (!response.ok || !response.body) throw new Error(String(response.status));
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '';
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); onText(text); }
        text += decoder.decode(); if (!text.trim()) throw new Error('empty'); onText(text);
      } finally { reader.releaseLock(); }
    }
  };
}
