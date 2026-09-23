import {
  EngineError,
  WEB_LIMITS,
  type DocumentSource,
  type HostAdapter,
  type HostCapabilities,
  type SaveResult, type SaveOutcome, type ResourceSource, type FontSelection, type SystemFontEntry,
  type RecoverySource,
} from '@pdf-editor/contracts';

const RECOVERY_DATABASE = 'pdf-editor-recovery';
const RECOVERY_STORE = 'sessions';

export class WebHostAdapter implements HostAdapter {
  readonly capabilities: HostCapabilities = {
    platform: 'web',
    nativeFiles: false,
    ocr: false,
    systemFonts: 'queryLocalFonts' in globalThis,
  };

  private readonly recovery = new IndexedDbRecoveryStore();
  private systemFonts = new Map<string, LocalFontData>();

  async pickDocument(): Promise<DocumentSource | null> {
    const file = await pickPdfFile();
    if (!file) return null;
    if (file.size > WEB_LIMITS.inputBytes) {
      throw new EngineError(
        'RESOURCE_LIMIT',
        `Web version limit is 50 MiB per PDF; selected file is ${formatMiB(file.size)} MiB.`,
      );
    }

    return {
      kind: 'bytes',
      sourceId: createSourceId(),
      name: file.name,
      bytes: await file.arrayBuffer(),
    };
  }

  async saveDocument(result: SaveResult, suggestedName: string): Promise<SaveOutcome> {
    if (result.kind !== 'bytes') {
      throw new EngineError('SAVE_FAILED', 'Web version cannot save native file handles');
    }

    const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/pdf' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = normalizePdfName(suggestedName);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { status: 'download-started' };
  }

  async pickResource(kind: 'image' | 'pdf'): Promise<ResourceSource | null> {
    const file = await pickPdfFile(kind === 'pdf' ? 'application/pdf,.pdf' : 'image/png,image/jpeg,.png,.jpg,.jpeg');
    if (!file) return null;
    if (file.size > WEB_LIMITS.inputBytes) throw new EngineError('RESOURCE_LIMIT', 'Resource exceeds the 50 MiB web input limit');
    if (kind === 'pdf') return { kind: 'pdf', bytes: await file.arrayBuffer() };
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width * bitmap.height > WEB_LIMITS.renderPixels) throw new EngineError('RESOURCE_LIMIT', 'Image exceeds the web pixel budget; resize it or use the desktop app');
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new EngineError('CORE_UNAVAILABLE', 'Image decoding is unavailable');
      context.drawImage(bitmap, 0, 0);
      const bytes = context.getImageData(0, 0, bitmap.width, bitmap.height).data.slice().buffer;
      return { kind: 'rgba', width: bitmap.width, height: bitmap.height, bytes };
    } finally { bitmap.close(); }
  }

  async pickFont(): Promise<FontSelection | null> {
    const file = await pickPdfFile('.ttf,.otf,.ttc,.otc');
    return file ? readFontSelection(file.name, file) : null;
  }

  async listSystemFonts(): Promise<SystemFontEntry[]> {
    const api = globalThis as typeof globalThis & { queryLocalFonts?: () => Promise<LocalFontData[]> };
    if (!api.queryLocalFonts) throw new EngineError('UNSUPPORTED_CAPABILITY', 'This browser does not provide local font access; import a font file instead');
    // Called only from a user click, allowing the browser to request permission.
    const fonts = await api.queryLocalFonts();
    this.systemFonts = new Map(fonts.map(font => [font.postscriptName, font]));
    return [...this.systemFonts].map(([id, font]) => ({ id, label: font.fullName })).sort((a, b) => a.label.localeCompare(b.label));
  }

  async getSystemFont(id: string): Promise<FontSelection> {
    const font = this.systemFonts.get(id);
    if (!font) throw new EngineError('INVALID_REQUEST', 'Select a font from the authorized local font list');
    return readFontSelection(font.fullName, await font.blob());
  }

  async loadResource(resourceId: string): Promise<ArrayBuffer> {
    const url = new URL(resourceId, window.location.href);
    if (url.origin !== window.location.origin) {
      throw new EngineError('INVALID_REQUEST', 'Resources must originate from current origin');
    }
    const response = await fetch(url);
    if (!response.ok) throw new EngineError('CORE_UNAVAILABLE', `Resource loading failed: ${response.status}`);
    return response.arrayBuffer();
  }

  readRecovery(id: string): Promise<Uint8Array | null> {
    return this.recovery.read(id);
  }

  writeRecovery(id: string, data: Uint8Array): Promise<void> {
    return this.recovery.write(id, data);
  }

  removeRecovery(id: string): Promise<void> {
    return this.recovery.remove(id);
  }

  async readRecoverySnapshot(id: string): Promise<RecoverySource | null> {
    const bytes = await this.recovery.read(id);
    if (!bytes) return null;
    return { kind: 'bytes', bytes: new Uint8Array(bytes).buffer };
  }

  writeRecoverySnapshot(id: string, source: RecoverySource): Promise<void> {
    if (source.kind !== 'bytes') {
      return Promise.reject(new EngineError('INVALID_REQUEST', 'Web recovery snapshot requires bytes'));
    }
    return this.recovery.write(id, new Uint8Array(source.bytes));
  }

  listRecovery(): Promise<string[]> {
    return this.recovery.list();
  }

  async openExternal(url: string): Promise<void> {
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new EngineError('INVALID_REQUEST', 'Only HTTP(S) links can be opened');
    }
    window.open(target.href, '_blank', 'noopener,noreferrer');
  }
}

export class IndexedDbRecoveryStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  async read(id: string): Promise<Uint8Array | null> {
    const result = await this.request<ArrayBuffer | Uint8Array | undefined>('readonly', (store) => store.get(id));
    if (result === undefined) return null;
    return result instanceof Uint8Array ? result : new Uint8Array(result);
  }

  async write(id: string, data: Uint8Array): Promise<void> {
    const bytes = data.slice().buffer;
    await this.request('readwrite', (store) => store.put(bytes, id));
  }

  async remove(id: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(id));
  }

  async list(): Promise<string[]> {
    const result = await this.request<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return result.map(String);
  }

  private open(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(RECOVERY_DATABASE, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(RECOVERY_STORE)) {
            request.result.createObjectStore(RECOVERY_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open recovery store'));
      });
    }
    return this.databasePromise;
  }

  private async request<Result>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<Result>,
  ): Promise<Result> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(RECOVERY_STORE, mode);
      const request = operation(transaction.objectStore(RECOVERY_STORE));
      let result!: Result;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error('Recovery store operation failed'));
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Recovery store transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Recovery store transaction failed'));
    });
  }
}

type LocalFontData = { postscriptName: string; fullName: string; blob(): Promise<Blob> };

async function readFontSelection(name: string, blob: Blob): Promise<FontSelection> {
  if (!blob.size || blob.size > 64 * 1024 * 1024) throw new EngineError('RESOURCE_LIMIT', 'Font file must be between 1 byte and 64 MiB');
  return { name, source: { kind: 'bytes', bytes: await blob.arrayBuffer() } };
}

function pickPdfFile(accept = 'application/pdf,.pdf'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;

    const finish = (file: File | null): void => {
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => finish(input.files?.item(0) ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    input.click();
  });
}

function createSourceId(): string {
  return `web-${crypto.randomUUID()}`;
}

function normalizePdfName(name: string): string {
  return name.toLocaleLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
