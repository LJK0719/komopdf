import { describe, expect, it } from 'vitest';
import { WEB_LIMITS, type DocumentInfo, type PageModel } from '@pdf-editor/contracts';
import { WorkerRpcClient } from '../src/rpc/client.js';
import { WasmEngineAdapter } from '../src/rpc/wasm-engine-adapter.js';

const permissions = {
  modify: true,
  copy: true,
  annotate: true,
  fillForms: true,
  encrypted: false,
  signed: false,
};

describe('WASM web resource limits', () => {
  it('closes new document and rejects opening when parsed pages exceed 200', async () => {
    const calls: string[] = [];
    const info: DocumentInfo = {
      id: 'large-doc', revision: 0, savedRevision: 0,
      pageOrder: Array.from({ length: 201 }, (_, index) => `p${index + 1}`),
      sourceIds: ['source'], permissions, capabilities: [],
    };
    const rpc = {
      call: async (method: string) => {
        calls.push(method);
        return method === 'open' ? info : undefined;
      },
    } as unknown as WorkerRpcClient;
    const adapter = new WasmEngineAdapter(rpc);

    await expect(adapter.open({
      kind: 'bytes', sourceId: 'source', name: 'large.pdf', bytes: new ArrayBuffer(1),
    })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(calls).toEqual(['open', 'close']);
  });

  it('budgets restored source bytes instead of the larger recovery snapshot', async () => {
    const calls: string[] = [];
    const info: DocumentInfo = {
      id: 'restored-doc', revision: 4, savedRevision: 1, sourceBytes: 1024,
      pageOrder: ['page-1'], sourceIds: ['source'], permissions, capabilities: [],
    };
    const rpc = {
      call: async (method: string) => {
        calls.push(method);
        return info;
      },
    } as unknown as WorkerRpcClient;
    const adapter = new WasmEngineAdapter(rpc);
    const snapshot = new ArrayBuffer(WEB_LIMITS.inputBytes + 1);

    await expect(adapter.restoreRecovery({ source: { kind: 'bytes', bytes: snapshot } }))
      .resolves.toEqual(info);
    expect(calls).toEqual(['restoreRecovery']);
  });

  it('rejects requests exceeding 8M pixels based on page dimensions before rendering', async () => {
    const page: PageModel = {
      id: 'page-1', widthPt: 4000, heightPt: 3000, rotation: 0, objects: [],
    };
    const calls: string[] = [];
    const rpc = {
      call: async (method: string) => {
        calls.push(method);
        return page;
      },
    } as unknown as WorkerRpcClient;
    const adapter = new WasmEngineAdapter(rpc);

    await expect(adapter.render({ docId: 'doc', pageId: 'page-1', scale: 1 }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(calls).toEqual(['describePage']);
  });
});
