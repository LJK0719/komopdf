import {
  EngineError,
  type DocumentInfo,
  type DocumentSource,
  type EditableObject,
  type EngineAdapter,
  type HostAdapter,
  type SaveConfirmation,
  type SaveOutcome,
} from '@pdf-editor/contracts';
import { ensureLoaded, loadDisplayPage, type LoadedDocument } from './display-document.js';
import { devicePixelRatio, renderPage } from './draw-render.js';

export const RENDER_SCALE = 1.25;
export type EditorActivity = 'idle' | 'opening' | 'rendering' | 'saving' | 'editing';

export async function replaceLoadedDocument(
  engine: EngineAdapter,
  previous: LoadedDocument | null,
  source: DocumentSource,
): Promise<LoadedDocument> {
  const loaded = await openLoadedDocument(engine, source);
  if (previous) await engine.close(previous.info.id).catch(() => undefined);
  return loaded;
}

export async function openLoadedDocument(
  engine: EngineAdapter,
  source: DocumentSource,
  password?: string,
  onOpened?: () => void,
): Promise<LoadedDocument> {
  const info = await (password === undefined ? engine.open(source) : engine.open(source, password));
  try {
    onOpened?.();
    const firstPageId = info.pageOrder[0];
    if (!firstPageId) throw new EngineError('INVALID_REQUEST', 'Document has no displayable pages');
    return await loadPage(engine, info, source.name, firstPageId);
  } catch (error) {
    await engine.close(info.id).catch(() => undefined);
    throw error;
  }
}

export async function loadPage(
  engine: EngineAdapter,
  info: DocumentInfo,
  name: string,
  pageId: string,
  scale = RENDER_SCALE,
  renderPixels = true,
): Promise<LoadedDocument> {
  const display = await loadDisplayPage(engine, info, name, pageId, scale, false, devicePixelRatio(), { priority: 'interaction' });
  const [loaded, render] = await Promise.all([
    ensureLoaded(engine, display, { priority: 'interaction' }),
    renderPixels ? renderPage(engine, info.id, display.page, scale, info.revision) : display.render,
  ]);
  if (display.pageVersion !== (engine.getPageVersion?.(info.id, pageId) ?? render.revision)) {
    throw new EngineError('STALE_REVISION', 'Page changed while rendering');
  }
  return { ...loaded, render };
}

export async function saveCurrentDocument(
  current: Pick<LoadedDocument, 'info' | 'name'>,
  engine: EngineAdapter,
  host: HostAdapter,
  updateSavedRevision: (docId: string, savedRevision: number, name?: string, outcome?: SaveOutcome) => void,
  setError: (message: string | null) => void,
  setNotice: (message: string) => void,
  setActivity: (activity: EditorActivity) => void,
  saveAs = false,
  onDownload?: (docId: string, revision: number) => void,
  onOutcome?: (status: 'written' | 'download-started' | 'cancelled' | 'failed') => void,
): Promise<SaveConfirmation | null> {
  setActivity('saving');
  setError(null);
  setNotice('Saving…');
  try {
    const result = await engine.save({ docId: current.info.id, protection: 'preserve' });
    const outcome = await host.saveDocument(result, current.name, { mode: saveAs ? 'save-as' : 'save' });
    if (outcome?.status === 'cancelled') { setNotice('Save cancelled'); onOutcome?.('cancelled'); return null; }
    if (outcome?.status === 'download-started') {
      onDownload?.(result.docId, result.savedRevision);
      setNotice('Download started'); onOutcome?.('download-started');
      return null;
    }
    const confirmed = await engine.confirmSave({ docId: result.docId, savedRevision: result.savedRevision });
    updateSavedRevision(result.docId, confirmed.savedRevision, outcome?.name, outcome || undefined);
    setNotice('Saved'); onOutcome?.('written');
    return { docId: result.docId, savedRevision: result.savedRevision };
  } catch (caught) {
    setError(formatError(caught));
    setNotice('Save not completed'); onOutcome?.('failed');
    return null;
  } finally {
    setActivity('idle');
  }
}

export function formatError(error: unknown): string {
  if (error instanceof EngineError) return error.message;
  return error instanceof Error ? error.message : 'Operation failed';
}

export function selectionDescription(objects: EditableObject[]): string {
  if (objects.length === 0) return 'Click logical objects on the page; Ctrl/Cmd or Shift to multi-select.';
  const types = [...new Set(objects.map((object) => objectTypeName(object.type)))];
  return types.join(', ');
}

function objectTypeName(type: EditableObject['type']): string {
  const names: Record<EditableObject['type'], string> = {
    text: 'Text',
    image: 'Image',
    path: 'Path',
    form: 'Form',
    group: 'Group',
    shading: 'Gradient',
  };
  return names[type];
}
