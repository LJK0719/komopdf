import type { CommandType, EditCommand, EditTransaction, TextStyle } from './commands.js';

export type Rect = { x: number; y: number; width: number; height: number };
export type Matrix = [number, number, number, number, number, number];
export type TextRange = [number, number];
export type DocumentSource =
  | { kind: 'bytes'; sourceId: string; name: string; bytes: ArrayBuffer }
  | { kind: 'native-file'; sourceId: string; name: string; handle: string };
export type DocumentPermissions = { modify: boolean; copy: boolean; annotate: boolean; fillForms: boolean;
  print?: boolean; encrypted: boolean; signed: boolean };
export type DocumentInfo = {
  id: string; revision: number; savedRevision: number; pageOrder: string[];
  sourceIds: string[]; sourceBytes?: number; permissions: DocumentPermissions; capabilities: CommandType[];
};
export type FormFieldInfo = {
  id: string; name: string; type: 'text' | 'checkbox' | 'radio' | 'choice';
  value: string | boolean | string[]; readOnly: boolean; required: boolean;
  multiple?: boolean; choiceKind?: 'combo' | 'list'; options: string[];
  widgets: { pageId: string; bounds: Rect }[];
  tooltip?: string;
  maxLen?: number;
};
export type OutlineEntry = { title: string; pageId: string | null; level: number };
export type PdfAnnotationInfo = {
  id: string; pageId: string; subtype: 'highlight' | 'text' | 'rectangle' | 'ink' | 'link' | 'other';
  bounds: Rect; text: string; color: [number, number, number]; opacity: number;
  targetPageId?: string | undefined;
  targetTopPt?: number | undefined;
};
export type SourceObjectLocator = { pageId: string; containerPath: number[]; objectIndex: number };
export type StyledTextRun = { text: string; style: TextStyle; sourceObjectIds: string[] };
export type TextBlock = {
  id: string; pageId: string; sourceId?: string; sourceObjectIds: string[]; runs: StyledTextRun[];
  bounds: Rect; transform: Matrix; editability: 'direct' | 'font-replacement' | 'geometry-only'; isOcr?: boolean;
  isParagraph?: boolean;
};
export type EditableObject = {
  id: string; pageId: string; type: 'text' | 'image' | 'path' | 'form' | 'group' | 'shading';
  bounds: Rect; transform: Matrix; locator: SourceObjectLocator; textBlock?: TextBlock;
};
export type PageModel = { id: string; widthPt: number; heightPt: number; rotation: 0 | 90 | 180 | 270; objects: EditableObject[] };
export type RenderRequest = { docId: string; pageId: string; scale: number; clip?: Rect };
export type RenderResult = { width: number; height: number; stride: number; format: 'rgba'; pixels: ArrayBuffer; revision: number };
export type ExtractionRequest = { docId: string; pageIds: string[] };
export type OcrRecognitionRequest = { docId: string; pageId: string; baseRevision: number; jobId: string; clip?: Rect };
export type OcrRecognitionLine = { text: string; confidence: number; bounds: Rect; rotated180?: boolean; transform?: Matrix };
export type OcrRecognitionResult = {
  jobId: string; docId: string; pageId: string; baseRevision: number; lines: OcrRecognitionLine[];
};
export type TextLayoutRequest = { docId: string; pageId: string; blockId: string; range: TextRange; text: string; style?: TextStyle };
export type TextLayoutResult = { bounds: Rect; overflow: boolean; lines: { bounds: Rect; range: TextRange }[]; replacementFontId?: string };
export type TextInsertLayoutRequest = { docId: string; baseRevision: number; command: Extract<EditCommand, { type: 'text.insert' | 'text.reflow' }> };
export type CommitResult = { docId: string; revision: number; changedPageIds: string[]; pageOrder: string[]; canUndo: boolean; canRedo: boolean };
export type SaveRequest = { docId: string; target?: string; protection: 'preserve' | 'remove' | 'set'; password?: string;
  optimize?: boolean; imageOptimization?: { quality: number; maxEdge?: number } };
export type SaveResult = { docId: string; savedRevision: number } & (
  | { kind: 'bytes'; bytes: ArrayBuffer }
  | { kind: 'native-file'; handle: string }
);
export type ExtractPagesRequest = { docId: string; pageIds: string[] };
export type ExtractPagesResult = { docId: string; sourceRevision: number; pageIds: string[] } & (
  | { kind: 'bytes'; bytes: ArrayBuffer }
  | { kind: 'native-file'; handle: string }
);
export type ResourceSource =
  | { kind: 'rgba'; width: number; height: number; bytes: ArrayBuffer }
  | { kind: 'pdf'; bytes: ArrayBuffer }
  | { kind: 'native-file'; handle: string };
export type RegisterResourceRequest = { docId: string; resourceId: string; source: ResourceSource };
export type ResourceInfo = { id: string; kind: 'image' | 'pdf'; width?: number; height?: number; pageCount?: number };
export type TransactionPreviewResult = { docId: string; baseRevision: number; pageOrder: string[]; changedPageIds: string[] };
export type SaveConfirmation = { docId: string; savedRevision: number };
export type SaveOutcome = { status: 'written' | 'download-started' };
export type FontSource = { kind: 'bytes'; bytes: ArrayBuffer } | { kind: 'native-file'; handle: string };
export type FontFaceInfo = { index: number; family: string; style: string; format: 'ttf' | 'otf';
  weight: number; italic: boolean; fsType: number; editableEmbedding: boolean };
export type RegisteredFontInfo = FontFaceInfo & { id: string; faceIndex: number };
export type RegisterFontRequest = { id: string; source: FontSource; faceIndex: number };
export type FontSelection = { name: string; source: FontSource };
export type SystemFontEntry = { id: string; label: string };
export type RecoverySource =
  | { kind: 'bytes'; bytes: ArrayBuffer }
  | { kind: 'native-file'; handle: string };
export type RecoverySnapshot = {
  docId: string;
  revision: number;
  savedRevision: number;
} & RecoverySource;
export type RestoreRecoveryRequest = {
  source: RecoverySource;
  password?: string | undefined;
};
export interface EngineAdapter {
  previewTextInsert?(request: TextInsertLayoutRequest): Promise<TextLayoutResult>;
  inspectFont?(source: FontSource): Promise<FontFaceInfo[]>;
  registerFont?(request: RegisterFontRequest): Promise<RegisteredFontInfo>;
  registerResource(request: RegisterResourceRequest): Promise<ResourceInfo>;
  previewTransaction(transaction: EditTransaction): Promise<TransactionPreviewResult>;
  confirmSave(request: SaveConfirmation): Promise<DocumentInfo>;
  open(source: DocumentSource, password?: string): Promise<DocumentInfo>;
  describePage(docId: string, pageId: string): Promise<PageModel>;
  describeForms?(docId: string): Promise<FormFieldInfo[]>;
  describeAnnotations?(docId: string, pageId: string): Promise<PdfAnnotationInfo[]>;
  describeOutline?(docId: string): Promise<OutlineEntry[]>;
  describeFonts?(docId: string): Promise<RegisteredFontInfo[]>;
  render(request: RenderRequest): Promise<RenderResult>;
  extract(request: ExtractionRequest): Promise<TextBlock[]>;
  recognizeOcr?(request: OcrRecognitionRequest): Promise<OcrRecognitionResult>;
  cancelOcr?(jobId: string): Promise<void>;
  previewText(request: TextLayoutRequest): Promise<TextLayoutResult>;
  apply(transaction: EditTransaction): Promise<CommitResult>;
  undo(docId: string): Promise<CommitResult>;
  redo(docId: string): Promise<CommitResult>;
  save(request: SaveRequest): Promise<SaveResult>;
  extractPages?(request: ExtractPagesRequest): Promise<ExtractPagesResult>;
  close(docId: string): Promise<void>;
  exportRecovery?(docId: string): Promise<RecoverySnapshot>;
  restoreRecovery?(request: RestoreRecoveryRequest): Promise<DocumentInfo>;
}
export const WEB_LIMITS = Object.freeze({ inputBytes: 50 * 1024 * 1024, pagesPerDocument: 200,
  openDocuments: 2, retainedSourceBytes: 100 * 1024 * 1024, totalPages: 400,
  bitmapCacheBytes: 96 * 1024 * 1024, renderPixels: 8_000_000 });
export type HostCapabilities = { platform: 'web' | 'windows' | 'macos'; nativeFiles: boolean; ocr: boolean; systemFonts: boolean };
export interface HostAdapter {
  readonly capabilities: HostCapabilities;
  pickDocument(): Promise<DocumentSource | null>;
  saveDocument(result: SaveResult, suggestedName: string): Promise<SaveOutcome | void>;
  printDocument?(result: SaveResult, pageIds: string[]): Promise<void>;
  pickResource?(kind: 'image' | 'pdf'): Promise<ResourceSource | null>;
  pickFont?(): Promise<FontSelection | null>;
  listSystemFonts?(): Promise<SystemFontEntry[]>;
  getSystemFont?(id: string): Promise<FontSelection>;
  onCloseRequested?(handler: () => Promise<boolean>): Promise<() => void>;
  loadResource(resourceId: string): Promise<ArrayBuffer>;
  readRecovery(id: string): Promise<Uint8Array | null>;
  writeRecovery(id: string, data: Uint8Array): Promise<void>;
  removeRecovery(id: string): Promise<void>;
  readRecoverySnapshot?(id: string): Promise<RecoverySource | null>;
  writeRecoverySnapshot?(id: string, source: RecoverySource): Promise<void>;
  listRecovery?(): Promise<string[]>;
  openExternal(url: string): Promise<void>;
}
export const WORKER_PROTOCOL_VERSION = 1 as const;
export type WorkerHandshake = { protocolVersion: 1; coreBuildId: string; capabilities: CommandType[] };
export type EngineErrorCode = 'INVALID_REQUEST' | 'DOCUMENT_NOT_FOUND' | 'STALE_REVISION' | 'UNSUPPORTED_CAPABILITY' | 'PASSWORD_REQUIRED' | 'WORKER_EXITED' | 'CORE_UNAVAILABLE' | 'RESOURCE_LIMIT' | 'SAVE_FAILED';
export class EngineError extends Error {
  constructor(public readonly code: EngineErrorCode, message: string) { super(message); this.name = 'EngineError'; }
}
