import type { SaveResult } from './engine.js';
import type { TextActionRequest, TextActionResult } from './text-actions.js';

export type KolmoTranslationOptions = {
  sourceLanguage: string;
  targetLanguage: string;
  layoutModes: ('translated_only' | 'side_by_side')[];
  translateImages: boolean;
  translateTables: boolean;
  glossary?: { name: string; text: string };
};
export type KolmoConnection = { configured: boolean; points: number | null };
export type KolmoJob = {
  id: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number | null;
  phase?: string;
  message?: string;
  points_deducted?: number;
  remaining_points?: number;
  error?: { message?: string; code?: string };
  result?: { filename: string; kind: string; content_type?: string; bytes?: number; download_url: string;
    files?: { name: string; kind: string }[] };
};
export type KolmoDocumentInput = {
  name: string;
  pageCount: number;
  documentId: string;
  revision: number;
  snapshot: SaveResult;
  workspaceId?: string;
};
export type KolmoFile = { name: string; mimeType: string; location?: string; identity?: string } & (
  | { kind: 'bytes'; bytes: ArrayBuffer }
  | { kind: 'native-file'; handle: string }
);
export type KolmoSavedJob = { job: KolmoJob; name: string; createdAt: number; documentId: string; revision: number };

/** Services have their own credentials and billing; neither channel launches the document agent. */
export interface EditorAiServices {
  textAction(request: TextActionRequest, signal: AbortSignal): Promise<TextActionResult>;
  kolmoConnection(signal?: AbortSignal): Promise<KolmoConnection>;
  configureKolmo(key: string): Promise<KolmoConnection>;
  subscribeKolmoConnection?(listener: () => void): Promise<() => void>;
  translateDocument(input: KolmoDocumentInput, options: KolmoTranslationOptions, submissionId: string, signal: AbortSignal): Promise<KolmoJob>;
  getKolmoJob(id: string, signal: AbortSignal): Promise<KolmoJob>;
  cancelKolmoJob(id: string): Promise<KolmoJob>;
  downloadKolmoResult(id: string, signal: AbortSignal): Promise<KolmoFile[]>;
  listKolmoJobs(): Promise<KolmoSavedJob[]>;
}
