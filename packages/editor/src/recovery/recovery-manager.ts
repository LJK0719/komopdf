import {
  EngineError,
  type DocumentInfo,
  type EngineAdapter,
  type HostAdapter,
  type RecoverySource,
} from '@pdf-editor/contracts';

export const RECOVERY_MANIFEST_KEY = 'recovery-manifest';

export type RecoverySessionMeta = {
  docId: string;
  name: string;
  revision: number;
  savedRevision: number;
  timestamp: number;
  encrypted: boolean;
  pageCount: number;
};

export type RecoveryManifest = {
  version: 1;
  sessions: RecoverySessionMeta[];
};

const hostQueues = new WeakMap<HostAdapter, Promise<unknown>>();

export function enqueueRecoveryOperation<T>(host: HostAdapter, op: () => Promise<T>): Promise<T> {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const next = previous.then(op, op);
  hostQueues.set(host, next);
  return next;
}

export function serializeManifest(manifest: RecoveryManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

export function deserializeManifest(bytes: Uint8Array | null): RecoveryManifest {
  if (!bytes || bytes.byteLength === 0) {
    return { version: 1, sessions: [] };
  }
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || !('sessions' in parsed)) {
      return { version: 1, sessions: [] };
    }
    const sessions = Array.isArray((parsed as { sessions: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions.filter(isValidSessionMeta)
      : [];
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: [] };
  }
}

function isValidSessionMeta(value: unknown): value is RecoverySessionMeta {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.docId === 'string' &&
    item.docId.length > 0 &&
    typeof item.name === 'string' &&
    typeof item.revision === 'number' &&
    typeof item.savedRevision === 'number' &&
    typeof item.timestamp === 'number' &&
    typeof item.encrypted === 'boolean' &&
    typeof item.pageCount === 'number'
  );
}

export async function readManifest(host: HostAdapter): Promise<RecoveryManifest> {
  try {
    const bytes = await host.readRecovery(RECOVERY_MANIFEST_KEY);
    return deserializeManifest(bytes);
  } catch {
    return { version: 1, sessions: [] };
  }
}

export async function writeManifest(host: HostAdapter, manifest: RecoveryManifest): Promise<void> {
  const bytes = serializeManifest(manifest);
  await host.writeRecovery(RECOVERY_MANIFEST_KEY, bytes);
}

export async function checkRecoverableSessions(
  host: HostAdapter,
  activeDocId?: string,
): Promise<RecoverySessionMeta[]> {
  const manifest = await readManifest(host);
  const validSessions: RecoverySessionMeta[] = [];
  let manifestModified = false;

  for (const session of manifest.sessions) {
    if (activeDocId && session.docId === activeDocId) {
      validSessions.push(session);
      continue;
    }

    let exists: boolean | null = null;
    try {
      if (host.readRecoverySnapshot) {
        const snapshot = await host.readRecoverySnapshot(session.docId);
        exists = snapshot !== null;
      } else {
        const raw = await host.readRecovery(session.docId);
        exists = raw !== null;
      }
    } catch {
      // Temporary I/O error or permission issue: do NOT prune manifest on transient errors
      exists = null;
    }

    if (exists === true) {
      validSessions.push(session);
    } else if (exists === false) {
      // Explicitly confirmed missing by host
      manifestModified = true;
    } else {
      // Transient error: retain record in manifest
      validSessions.push(session);
    }
  }

  if (manifestModified) {
    try {
      await writeManifest(host, { version: 1, sessions: validSessions });
    } catch {
      // Non-fatal pruning error
    }
  }

  return validSessions.filter((s) => !activeDocId || s.docId !== activeDocId);
}

export function persistRecoverySnapshot(
  engine: EngineAdapter,
  host: HostAdapter,
  doc: {
    info: {
      id: string;
      permissions?: { encrypted?: boolean };
      pageOrder?: string[];
    };
    name: string;
  },
): Promise<RecoverySessionMeta | null> {
  return enqueueRecoveryOperation(host, async () => {
    if (!engine.exportRecovery || !host.writeRecoverySnapshot) {
      return null;
    }

    // Export from core: snapshot has actual revision and savedRevision
    const snapshot = await engine.exportRecovery(doc.info.id);
    await host.writeRecoverySnapshot(snapshot.docId, snapshot);

    const manifest = await readManifest(host);
    const meta: RecoverySessionMeta = {
      docId: snapshot.docId,
      name: doc.name,
      revision: snapshot.revision,
      savedRevision: snapshot.savedRevision,
      timestamp: Date.now(),
      encrypted: Boolean(doc.info.permissions?.encrypted),
      pageCount: doc.info.pageOrder?.length ?? 0,
    };

    const idx = manifest.sessions.findIndex((s) => s.docId === snapshot.docId);
    if (idx >= 0) {
      manifest.sessions[idx] = meta;
    } else {
      manifest.sessions.push(meta);
    }

    await writeManifest(host, manifest);
    return meta;
  });
}

export function discardRecoveryRecord(host: HostAdapter, docId: string): Promise<void> {
  return enqueueRecoveryOperation(host, async () => {
    await host.removeRecovery(docId);
    const manifest = await readManifest(host);
    const nextSessions = manifest.sessions.filter((s) => s.docId !== docId);
    if (nextSessions.length !== manifest.sessions.length) {
      await writeManifest(host, { version: 1, sessions: nextSessions });
    }
  });
}

export async function restoreRecoveryRecord(
  engine: EngineAdapter,
  host: HostAdapter,
  session: RecoverySessionMeta,
  password?: string,
): Promise<DocumentInfo> {
  if (!engine.restoreRecovery || !host.readRecoverySnapshot) {
    throw new EngineError(
      'UNSUPPORTED_CAPABILITY',
      'Recovery restore is not supported by the current PDF engine or host adapter',
    );
  }

  const source = await host.readRecoverySnapshot(session.docId);
  if (!source) {
    throw new EngineError('DOCUMENT_NOT_FOUND', 'Recovery snapshot file is missing or has expired');
  }

  return engine.restoreRecovery(password ? { source, password } : { source });
}
