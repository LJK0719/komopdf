import { describe, expect, it, vi } from 'vitest';
import type { AccountService } from '../src/accounts.js';
import type { ProviderAdapter } from '../src/provider-types.js';
import { loadGatewayConfig } from '../src/config.js';
import { buildGateway } from '../src/server.js';

const payload = { requestId: 'free-text', action: 'translate', segments: [{ id: 's1', text: 'Hello' }], sourceLanguage: 'auto', targetLanguage: 'zh', tone: 'neutral' };
const provider: ProviderAdapter = {
  generate: async () => ({ text: JSON.stringify({ requestId: payload.requestId, action: payload.action, detectedLanguage: 'en', segments: [{ id: 's1', text: '你好' }] }), finishReason: 'STOP', usage: { totalTokenCount: 100 } }),
  stream: async function* () { throw new Error('Not used by text actions'); },
};
describe('free tools in the production gateway', () => {
  it('works without account configuration while paid routes remain protected', async () => {
    const app = buildGateway({ config: await loadGatewayConfig(), provider });
    try {
      const result = await app.inject({ method: 'POST', url: '/api/v1/ai/text-actions', payload });
      expect(result.statusCode).toBe(200); expect(result.json().segments[0].text).toBe('你好');
      const paid = await app.inject({ method: 'POST', url: '/api/v1/ai/requests', payload: {} });
      expect(paid.statusCode).toBe(503); expect(paid.json().error.code).toBe('ACCOUNTS_NOT_CONFIGURED');
    } finally { await app.close(); }
  });
  it('never authenticates, reserves, or settles KOMO credits for a fixed text tool', async () => {
    const accounts = { register: vi.fn(), authenticate: vi.fn(), reserve: vi.fn(), store: { settle: vi.fn() } };
    const app = buildGateway({ config: await loadGatewayConfig(), provider, accounts: accounts as unknown as AccountService });
    try {
      const result = await app.inject({ method: 'POST', url: '/api/v1/ai/text-actions', payload });
      expect(result.statusCode).toBe(200); expect(accounts.authenticate).not.toHaveBeenCalled();
      expect(accounts.reserve).not.toHaveBeenCalled(); expect(accounts.store.settle).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
