export type AiAuthorizationErrorCode =
  | 'DOCUMENT_MISMATCH'
  | 'AUTHORIZATION_REQUIRED'
  | 'SOURCE_AUTHORIZATION_REQUIRED';

export class AiAuthorizationError extends Error {
  constructor(
    public readonly code: AiAuthorizationErrorCode,
    message: string,
    public readonly missingSourceIds: readonly string[] = [],
  ) {
    super(message);
    this.name = 'AiAuthorizationError';
  }
}

export interface AuthorizedRequestHandle {
  readonly signal: AbortSignal;
  release(): void;
}

/** 当前打开文档会话内的联网授权；重新打开文档应创建新实例。 */
export class DocumentAiAuthorization {
  readonly docId: string;
  #enabled = false;
  #sourceIds = new Set<string>();
  #activeRequests = new Set<AbortController>();

  constructor(docId: string) {
    if (!docId) throw new Error('docId cannot be empty');
    this.docId = docId;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get authorizedSourceIds(): readonly string[] {
    return Object.freeze([...this.#sourceIds]);
  }

  enable(sourceIds: readonly string[]): void {
    this.#enabled = true;
    this.#sourceIds = new Set(validateSourceIds(sourceIds));
  }

  authorizeAdditionalSources(sourceIds: readonly string[]): void {
    if (!this.#enabled) {
      throw new AiAuthorizationError('AUTHORIZATION_REQUIRED', 'AI must be enabled for this document first');
    }
    for (const sourceId of validateSourceIds(sourceIds)) this.#sourceIds.add(sourceId);
  }

  missingSourceIds(sourceIds: readonly string[]): readonly string[] {
    const missing = validateSourceIds(sourceIds).filter(sourceId => !this.#sourceIds.has(sourceId));
    return Object.freeze(missing);
  }

  isAuthorized(docId: string, sourceIds: readonly string[]): boolean {
    return docId === this.docId && this.#enabled && this.missingSourceIds(sourceIds).length === 0;
  }

  assertAuthorized(docId: string, sourceIds: readonly string[]): void {
    if (docId !== this.docId) {
      throw new AiAuthorizationError('DOCUMENT_MISMATCH', 'AI authorization does not belong to the current document');
    }
    if (!this.#enabled) {
      throw new AiAuthorizationError('AUTHORIZATION_REQUIRED', 'AI must be enabled for this document');
    }
    const missing = this.missingSourceIds(sourceIds);
    if (missing.length > 0) {
      throw new AiAuthorizationError(
        'SOURCE_AUTHORIZATION_REQUIRED',
        'Additional sources have not been authorized for AI transmission',
        missing,
      );
    }
  }

  beginRequest(
    docId: string,
    sourceIds: readonly string[],
    externalSignal?: AbortSignal,
  ): AuthorizedRequestHandle {
    this.assertAuthorized(docId, sourceIds);
    const controller = new AbortController();
    this.#activeRequests.add(controller);

    const abortFromExternal = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        externalSignal?.removeEventListener('abort', abortFromExternal);
        this.#activeRequests.delete(controller);
      },
    };
  }

  revoke(reason: unknown = new DOMException('Document AI authorization has been revoked', 'AbortError')): void {
    this.#enabled = false;
    this.#sourceIds.clear();
    for (const controller of this.#activeRequests) controller.abort(reason);
    this.#activeRequests.clear();
  }
}

function validateSourceIds(sourceIds: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const sourceId of sourceIds) {
    if (!sourceId) throw new Error('sourceId cannot be empty');
    unique.add(sourceId);
  }
  return [...unique];
}
