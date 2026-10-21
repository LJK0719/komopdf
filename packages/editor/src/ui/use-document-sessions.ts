import { useCallback, useMemo, useRef, useState, type SetStateAction } from 'react';
import type { DocumentSource, SaveOutcome } from '@pdf-editor/contracts';
import type { LoadedDocument } from './EditorShell.js';
import type { PageView, PointerTool } from './DocumentViewport.js';
import type { RibbonTab } from './EditorRibbon.js';

type SessionView = {
  history: { canUndo: boolean; canRedo: boolean };
  zoom: number;
  selectedIds: string[];
  view: PageView;
  continuous: boolean;
  pointer: PointerTool;
  tab: RibbonTab;
  scroll: { top: number; left: number };
};
export type DocumentSession = SessionView & {
  loaded: LoadedDocument;
  identity?: string;
  location?: string;
  saveIdentity?: string;
  saveLocation?: string;
  hasSaveTarget: boolean;
  downloadedRevision?: number;
};
type SessionsState = { documents: Map<string, DocumentSession>; activeId: string | null; empty: SessionView };
const initialView = (): SessionView => ({ history: { canUndo: false, canRedo: false }, zoom: 1.25,
  selectedIds: [], view: 'single', continuous: true, pointer: 'select', tab: 'home', scroll: { top: 0, left: 0 } });

export function useDocumentSessions() {
  const [state, setState] = useState<SessionsState>(() => ({ documents: new Map(), activeId: null, empty: initialView() }));
  const current = useRef(state);
  const commit = useCallback((next: SessionsState) => { current.current = next; setState(next); }, []);
  const patch = useCallback((id: string, update: Partial<DocumentSession> | ((session: DocumentSession) => DocumentSession)) => {
    const state = current.current, session = state.documents.get(id);
    if (!session) return;
    const next = typeof update === 'function' ? update(session) : { ...session, ...update };
    const documents = new Map(state.documents); documents.set(id, next);
    commit({ ...state, documents });
  }, [commit]);
  const setDocument = useCallback((value: SetStateAction<LoadedDocument | null>) => {
    const state = current.current;
    const previous = state.activeId ? state.documents.get(state.activeId)?.loaded ?? null : null;
    const loaded = typeof value === 'function' ? value(previous) : value;
    if (loaded === previous) return;
    if (!loaded) { commit({ ...state, activeId: null }); return; }
    const documents = new Map(state.documents), session = documents.get(loaded.info.id);
    documents.set(loaded.info.id, session ? { ...session, loaded } : { ...initialView(), loaded, hasSaveTarget: false });
    commit({ ...state, documents, activeId: loaded.info.id });
  }, [commit]);
  // Existing page/edit handlers keep a synchronous view of the same session store.
  const documentRef = useMemo(() => ({
    get current() { const state = current.current; return state.activeId ? state.documents.get(state.activeId)?.loaded ?? null : null; },
    set current(value: LoadedDocument | null) { setDocument(value); },
  }), [setDocument]);
  const updateView = useCallback(<K extends keyof SessionView>(key: K, value: SetStateAction<SessionView[K]>) => {
    const state = current.current, session = state.activeId ? state.documents.get(state.activeId) : undefined;
    const previous = (session ?? state.empty)[key];
    const next = typeof value === 'function' ? (value as (previous: SessionView[K]) => SessionView[K])(previous) : value;
    if (Object.is(previous, next)) return;
    if (session && state.activeId) patch(state.activeId, { [key]: next });
    else commit({ ...state, empty: { ...state.empty, [key]: next } });
  }, [commit, patch]);
  const setters = useMemo(() => ({
    setHistory: (value: SetStateAction<SessionView['history']>) => updateView('history', value),
    setZoom: (value: SetStateAction<number>) => updateView('zoom', value),
    setSelectedIds: (value: SetStateAction<string[]>) => updateView('selectedIds', value),
    setView: (value: SetStateAction<PageView>) => updateView('view', value),
    setContinuous: (value: SetStateAction<boolean>) => updateView('continuous', value),
    setPointer: (value: SetStateAction<PointerTool>) => updateView('pointer', value),
    setTab: (value: SetStateAction<RibbonTab>) => updateView('tab', value),
  }), [updateView]);
  const add = useCallback((loaded: LoadedDocument, source?: DocumentSource) => {
    const state = current.current, documents = new Map(state.documents);
    documents.set(loaded.info.id, { ...initialView(), loaded, hasSaveTarget: false,
      ...(source?.identity ? { identity: source.identity } : {}), ...(source?.location ? { location: source.location } : {}) });
    commit({ ...state, documents, activeId: loaded.info.id });
  }, [commit]);
  const activate = useCallback((id: string) => {
    const state = current.current;
    if (state.documents.has(id) && state.activeId !== id) commit({ ...state, activeId: id });
  }, [commit]);
  const remove = useCallback((id: string) => {
    const state = current.current, documents = new Map(state.documents);
    const ids = [...documents.keys()], index = ids.indexOf(id);
    documents.delete(id);
    const activeId = state.activeId === id ? (ids[index + 1] ?? ids[index - 1] ?? null) : state.activeId;
    commit({ ...state, documents, activeId });
  }, [commit]);
  const save = useCallback((id: string, revision: number, outcome?: SaveOutcome) => {
    patch(id, session => ({ ...session, hasSaveTarget: true,
      ...(outcome?.identity ? { saveIdentity: outcome.identity } : {}), ...(outcome?.location ? { saveLocation: outcome.location } : {}),
      loaded: { ...session.loaded, name: outcome?.name ?? session.loaded.name,
        info: { ...session.loaded.info, savedRevision: revision } } }));
  }, [patch]);
  const active = state.activeId ? state.documents.get(state.activeId) : undefined;
  return { state, current, active, document: active?.loaded ?? null, documentRef, setDocument,
    ...(active ?? state.empty), ...setters, add, activate, remove, patch, save };
}
