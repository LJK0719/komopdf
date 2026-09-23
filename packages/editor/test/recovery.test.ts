import { describe, expect, it } from 'vitest';
import {
  EngineError,
  type DocumentInfo,
  type EngineAdapter,
  type HostAdapter,
  type RecoverySnapshot,
  type RecoverySource,
  type RestoreRecoveryRequest,
} from '@pdf-editor/contracts';
import {
  RECOVERY_MANIFEST_KEY,
  checkRecoverableSessions,
  deserializeManifest,
  discardRecoveryRecord,
  persistRecoverySnapshot,
  readManifest,
  restoreRecoveryRecord,
  serializeManifest,
  writeManifest,
  type RecoveryManifest,
  type RecoverySessionMeta,
} from '../src/recovery/index.js';

function createMockHost(initialData: Record<string, Uint8Array> = {}): HostAdapter & {
  storage: Map<string, Uint8Array>;
  snapshots: Map<string, RecoverySource>;
} {
  const storage = new Map<string, Uint8Array>(Object.entries(initialData));
  const snapshots = new Map<string, RecoverySource>();

  return {
    storage,
    snapshots,
    capabilities: {
      platform: 'web',
      nativeFiles: false,
      ocr: false,
      systemFonts: false,
    },
    pickDocument: async () => null,
    saveDocument: async () => undefined,
    loadResource: async () => new ArrayBuffer(0),
    readRecovery: async (id: string) => storage.get(id) ?? null,
    writeRecovery: async (id: string, data: Uint8Array) => {
      storage.set(id, data);
    },
    removeRecovery: async (id: string) => {
      storage.delete(id);
      snapshots.delete(id);
    },
    readRecoverySnapshot: async (id: string) => snapshots.get(id) ?? null,
    writeRecoverySnapshot: async (id: string, source: RecoverySource) => {
      snapshots.set(id, source);
    },
    openExternal: async () => undefined,
  };
}

const sampleDocInfo: DocumentInfo = {
  id: 'doc-session-1',
  revision: 5,
  savedRevision: 0,
  pageOrder: ['page-1', 'page-2'],
  sourceIds: ['src-1'],
  permissions: {
    modify: true,
    copy: true,
    annotate: true,
    fillForms: true,
    encrypted: false,
    signed: false,
  },
  capabilities: ['text.replace', 'objects.transform'],
};

describe('Recovery manifest serialization', () => {
  it('handles empty, null, or corrupted data gracefully', () => {
    expect(deserializeManifest(null)).toEqual({ version: 1, sessions: [] });
    expect(deserializeManifest(new Uint8Array(0))).toEqual({ version: 1, sessions: [] });
    expect(deserializeManifest(new TextEncoder().encode('not-json'))).toEqual({ version: 1, sessions: [] });
    expect(deserializeManifest(new TextEncoder().encode('{"some":"other"}'))).toEqual({ version: 1, sessions: [] });
  });

  it('round-trips valid manifest data', () => {
    const meta: RecoverySessionMeta = {
      docId: 'doc-1',
      name: 'report.pdf',
      revision: 4,
      savedRevision: 1,
      timestamp: 1700000000000,
      encrypted: false,
      pageCount: 3,
    };
    const manifest: RecoveryManifest = { version: 1, sessions: [meta] };
    const serialized = serializeManifest(manifest);
    const deserialized = deserializeManifest(serialized);
    expect(deserialized).toEqual(manifest);
  });
});

describe('Recovery persistence and check', () => {
  it('persists snapshot and manifest on document change', async () => {
    const host = createMockHost();
    const fakeBytes = new Uint8Array([10, 20, 30]).buffer;
    const engine: Partial<EngineAdapter> = {
      exportRecovery: async (docId: string): Promise<RecoverySnapshot> => ({
        docId,
        revision: 5,
        savedRevision: 0,
        kind: 'bytes',
        bytes: fakeBytes,
      }),
    };

    await persistRecoverySnapshot(engine as EngineAdapter, host, {
      info: sampleDocInfo,
      name: 'test.pdf',
    });

    // Verify snapshot written to host
    const snapshot = await host.readRecoverySnapshot('doc-session-1');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.kind).toBe('bytes');

    // Verify manifest written
    const manifest = await readManifest(host);
    expect(manifest.sessions).toHaveLength(1);
    expect(manifest.sessions[0]?.docId).toBe('doc-session-1');
    expect(manifest.sessions[0]?.name).toBe('test.pdf');
    expect(manifest.sessions[0]?.revision).toBe(5);
    expect(manifest.sessions[0]?.savedRevision).toBe(0);
  });

  it('filters out recoverable sessions whose snapshot was deleted', async () => {
    const host = createMockHost();
    const manifest: RecoveryManifest = {
      version: 1,
      sessions: [
        {
          docId: 'orphan-session',
          name: 'orphan.pdf',
          revision: 2,
          savedRevision: 0,
          timestamp: Date.now(),
          encrypted: false,
          pageCount: 1,
        },
      ],
    };
    await writeManifest(host, manifest);

    // Snapshot was NOT written into host.snapshots
    const sessions = await checkRecoverableSessions(host);
    expect(sessions).toHaveLength(0);

    // Manifest should have been cleaned up
    const updated = await readManifest(host);
    expect(updated.sessions).toHaveLength(0);
  });

  it('ignores the currently active document during startup check', async () => {
    const host = createMockHost();
    await host.writeRecoverySnapshot('doc-active', { kind: 'bytes', bytes: new ArrayBuffer(4) });
    await host.writeRecoverySnapshot('doc-crashed', { kind: 'bytes', bytes: new ArrayBuffer(4) });

    const manifest: RecoveryManifest = {
      version: 1,
      sessions: [
        {
          docId: 'doc-active',
          name: 'active.pdf',
          revision: 3,
          savedRevision: 0,
          timestamp: Date.now(),
          encrypted: false,
          pageCount: 1,
        },
        {
          docId: 'doc-crashed',
          name: 'crashed.pdf',
          revision: 4,
          savedRevision: 0,
          timestamp: Date.now(),
          encrypted: false,
          pageCount: 2,
        },
      ],
    };
    await writeManifest(host, manifest);

    const recoverable = await checkRecoverableSessions(host, 'doc-active');
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0]?.docId).toBe('doc-crashed');
  });
});

describe('Recovery restore and cleanup', () => {
  it('restores recovery snapshot via engine', async () => {
    const host = createMockHost();
    const fakeBytes = new ArrayBuffer(8);
    await host.writeRecoverySnapshot('doc-1', { kind: 'bytes', bytes: fakeBytes });

    let restoredRequest: RestoreRecoveryRequest | null = null;
    const engine: Partial<EngineAdapter> = {
      restoreRecovery: async (req: RestoreRecoveryRequest): Promise<DocumentInfo> => {
        restoredRequest = req;
        return {
          ...sampleDocInfo,
          id: 'doc-1',
          revision: 5,
        };
      },
    };

    const sessionMeta: RecoverySessionMeta = {
      docId: 'doc-1',
      name: 'restored.pdf',
      revision: 5,
      savedRevision: 0,
      timestamp: Date.now(),
      encrypted: false,
      pageCount: 2,
    };

    const doc = await restoreRecoveryRecord(engine as EngineAdapter, host, sessionMeta);
    expect(doc.id).toBe('doc-1');
    expect(doc.revision).toBe(5);
    expect(restoredRequest?.source).toEqual({ kind: 'bytes', bytes: fakeBytes });
  });

  it('passes password through to engine when encrypted', async () => {
    const host = createMockHost();
    await host.writeRecoverySnapshot('doc-enc', { kind: 'bytes', bytes: new ArrayBuffer(4) });

    let capturedPassword = '';
    const engine: Partial<EngineAdapter> = {
      restoreRecovery: async (req: RestoreRecoveryRequest): Promise<DocumentInfo> => {
        if (!req.password) throw new EngineError('PASSWORD_REQUIRED', 'Password required');
        capturedPassword = req.password;
        return { ...sampleDocInfo, id: 'doc-enc' };
      },
    };

    const sessionMeta: RecoverySessionMeta = {
      docId: 'doc-enc',
      name: 'locked.pdf',
      revision: 1,
      savedRevision: 0,
      timestamp: Date.now(),
      encrypted: true,
      pageCount: 1,
    };

    // First attempt without password throws PASSWORD_REQUIRED
    await expect(restoreRecoveryRecord(engine as EngineAdapter, host, sessionMeta)).rejects.toThrow(
      'Password required',
    );

    // Second attempt with password succeeds
    const restored = await restoreRecoveryRecord(engine as EngineAdapter, host, sessionMeta, 'secret123');
    expect(restored.id).toBe('doc-enc');
    expect(capturedPassword).toBe('secret123');
  });

  it('discards recovery record and cleans up manifest', async () => {
    const host = createMockHost();
    await host.writeRecoverySnapshot('doc-clean', { kind: 'bytes', bytes: new ArrayBuffer(4) });
    await writeManifest(host, {
      version: 1,
      sessions: [
        {
          docId: 'doc-clean',
          name: 'clean.pdf',
          revision: 2,
          savedRevision: 0,
          timestamp: Date.now(),
          encrypted: false,
          pageCount: 1,
        },
      ],
    });

    await discardRecoveryRecord(host, 'doc-clean');

    const manifest = await readManifest(host);
    expect(manifest.sessions).toHaveLength(0);
    const snapshot = await host.readRecoverySnapshot('doc-clean');
    expect(snapshot).toBeNull();
  });

  it('runs persist and discard in sequential order per host, preventing race condition', async () => {
    const host = createMockHost();
    const engine: Partial<EngineAdapter> = {
      exportRecovery: async (docId: string): Promise<RecoverySnapshot> => {
        // Introduce small micro-delay to simulate async engine export
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          docId,
          revision: 3,
          savedRevision: 0,
          kind: 'bytes',
          bytes: new ArrayBuffer(4),
        };
      },
    };

    // Fire persist followed immediately by discard without awaiting persist first
    const persistPromise = persistRecoverySnapshot(engine as EngineAdapter, host, {
      info: sampleDocInfo,
      name: 'race.pdf',
    });
    const discardPromise = discardRecoveryRecord(host, sampleDocInfo.id);

    await Promise.all([persistPromise, discardPromise]);

    // Discard must have executed AFTER persist, so manifest has 0 sessions
    const manifest = await readManifest(host);
    expect(manifest.sessions).toHaveLength(0);
    const snapshot = await host.readRecoverySnapshot(sampleDocInfo.id);
    expect(snapshot).toBeNull();
  });

  it('preserves manifest entry when snapshot check encounters a transient read error', async () => {
    const host = createMockHost();
    await writeManifest(host, {
      version: 1,
      sessions: [
        {
          docId: 'doc-transient-error',
          name: 'error.pdf',
          revision: 2,
          savedRevision: 0,
          timestamp: Date.now(),
          encrypted: false,
          pageCount: 1,
        },
      ],
    });

    // Make readRecoverySnapshot throw an I/O error
    host.readRecoverySnapshot = async () => {
      throw new Error('EACCES: permission denied, resource locked');
    };

    const recoverable = await checkRecoverableSessions(host);
    // Transient error must preserve the session in validSessions
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0]?.docId).toBe('doc-transient-error');

    // And manifest must NOT be pruned
    const manifest = await readManifest(host);
    expect(manifest.sessions).toHaveLength(1);
  });

  it('uses actual revision and savedRevision from exported snapshot metadata', async () => {
    const host = createMockHost();
    const engine: Partial<EngineAdapter> = {
      exportRecovery: async (docId: string): Promise<RecoverySnapshot> => ({
        docId,
        revision: 99,
        savedRevision: 42,
        kind: 'bytes',
        bytes: new ArrayBuffer(4),
      }),
    };

    // Pass doc with different revision (e.g. 5, 0)
    await persistRecoverySnapshot(engine as EngineAdapter, host, {
      info: { ...sampleDocInfo, revision: 5, savedRevision: 0 },
      name: 'actual-rev.pdf',
    });

    const manifest = await readManifest(host);
    expect(manifest.sessions).toHaveLength(1);
    expect(manifest.sessions[0]?.revision).toBe(99);
    expect(manifest.sessions[0]?.savedRevision).toBe(42);
  });

  it('refuses to prune manifest if host removeRecovery fails', async () => {
    const host = createMockHost();
    await host.writeRecoverySnapshot('doc-fail-remove', { kind: 'bytes', bytes: new ArrayBuffer(4) });
    await writeManifest(host, {
      version: 1,
      sessions: [
        {
          docId: 'doc-fail-remove',
          name: 'fail.pdf',
          revision: 1,
          savedRevision: 0,
          timestamp: Date.now(),
          encrypted: false,
          pageCount: 1,
        },
      ],
    });

    // Make removeRecovery fail
    host.removeRecovery = async () => {
      throw new Error('Disk write protected');
    };

    await expect(discardRecoveryRecord(host, 'doc-fail-remove')).rejects.toThrow(
      'Disk write protected',
    );

    // Manifest must retain the entry
    const manifest = await readManifest(host);
    expect(manifest.sessions).toHaveLength(1);
  });
});
