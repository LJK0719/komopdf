import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, MessageSquare, StickyNote, Check, Square, Expand } from 'lucide-react';
import { preferredAiLanguage, saveAiLanguage } from './ai-preferences.js';
import { AppDialog } from './AppDialog.js';
import { AiFloatingWindow } from './AiFloatingWindow.js';
import { TEXT_LANGUAGES, type CommitResult, type DocumentInfo, type EditCommand, type EditTransaction, type EditorAiServices, type EngineAdapter, type TextAction, type TextStyle } from '@pdf-editor/contracts';
import { AiPanelDiff } from './AiPanelDiff.js';
import { prepareTextActionApplication } from './text-action-application.js';
import { useI18n } from './i18n.js';
import { ensureEditorFont, type EditorFont } from './font-resources.js';
import { TEXT_ACTION_LABELS, normalizeActionText, selectionMaterial, selectionUnits, type AiMaterial, type TextActionSelection, type TextActionTarget } from './text-actions.js';

type Outcome = { action: TextAction; targetLanguage: string; detectedLanguage: string; texts: Record<string, string> };
type Props = {
  preferenceOwner?: string | null | undefined;
  onCommentCreated?(pageId: string, annotationId: string): void;
  selection: TextActionSelection; document: DocumentInfo; engine: EngineAdapter; services: EditorAiServices;
  active: boolean; onClose(): void;
  fonts: EditorFont[]; disabled: boolean; onBusyChange(busy: boolean): void;
  onCommitted(result: CommitResult): Promise<void>; onDiscuss(material: AiMaterial): void;
  onBeforeWrite(): Promise<boolean>; getDocument(): DocumentInfo; onAdjustSource(target: TextActionTarget): void;
};
export function TextActionPanel({ preferenceOwner, onCommentCreated, selection, document, engine, services, active, onClose, fonts, disabled, onBusyChange, onCommitted, onDiscuss, onBeforeWrite, getDocument, onAdjustSource }: Props) {
  const { t, locale } = useI18n();
  const action = selection.action;
  const units = useMemo(() => selectionUnits(selection), [selection]);
  const [targetLanguage, setTargetLanguage] = useState(() => preferredAiLanguage(locale, preferenceOwner));
  const [choosingLanguage, setChoosingLanguage] = useState(action === 'translate');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [editOriginal, setEditOriginal] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const preferenceState = useRef({ owner: preferenceOwner, edited: false, save: false });
  useEffect(() => {
    if (preferenceOwner === undefined) return;
    const previous = preferenceState.current;
    if (previous.owner === undefined && previous.edited) {
      if (previous.save) saveAiLanguage(preferenceOwner, targetLanguage);
    } else {
      setTargetLanguage(preferredAiLanguage(locale, preferenceOwner));
      previous.edited = false; previous.save = false;
    }
    previous.owner = preferenceOwner;
  }, [preferenceOwner]);
  const chooseLanguage = (language: string, remember = false) => {
    preferenceState.current.edited = true;
    preferenceState.current.save = remember;
    setTargetLanguage(language);
    if (remember) saveAiLanguage(preferenceOwner, language);
  };
  const rememberLanguage = () => {
    preferenceState.current.save = true;
    saveAiLanguage(preferenceOwner, targetLanguage);
  };
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fontId, setFontId] = useState('');
  const [fontSize, setFontSize] = useState('');
  const [preview, setPreview] = useState<EditTransaction | null>(null);
  const [layout, setLayout] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState(false);
  const appliedRevision = useRef<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (!active) controller.current?.abort(); }, [active]);
  useEffect(() => {
    setPreview(null); setLayout({});
    if (appliedRevision.current !== null && document.revision !== appliedRevision.current) {
      appliedRevision.current = null; setApplied(false); setNotice('');
    }
  }, [document.revision]);
  const text = outcome ? units.map(unit => outcome.texts[unit.id] ?? '').join('\n\n') : '';
  const canReplace = outcome && !['explain', 'summarize'].includes(outcome.action);
  const selectedUnits = units;
  const selectedIds = new Set(selectedUnits.flatMap(unit => unit.targetIds));
  const selectedTargets = selection.targets.filter(target => selectedIds.has(target.id));
  const isDraft = Boolean(selection.draft);
  const staleDraft = isDraft && !selection.draft!.current();
  const canModify = document.permissions.modify && document.capabilities.includes('text.replace');
  const close = () => { controller.current?.abort(); onClose(); };

  const run = async () => {
    if (controller.current || disabled || !document.permissions.copy) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setProgress(t('Working…')); setError(''); setNotice(''); setPreview(null); setLayout({});
    try {
      const unit = units[0];
      if (!unit?.text.trim()) throw new Error('Select text to continue.');
      const response = await services.textAction({ requestId: crypto.randomUUID(), action,
        segments: [{ id: unit.id, text: unit.text }], sourceLanguage: 'auto', targetLanguage, tone: 'neutral' }, abort.signal);
      abort.signal.throwIfAborted();
      const result = response.segments.find(item => item.id === unit.id);
      if (!result?.text.trim()) throw new Error('The AI result is incomplete. Try again.');
      setOutcome({ action, targetLanguage, detectedLanguage: response.detectedLanguage,
        texts: { [unit.id]: normalizeActionText(result.text) } }); setEditOriginal(false);
      appliedRevision.current = null; setApplied(false);
    } catch (caught) {
      if (mounted.current) {
        if (abort.signal.aborted) setNotice(t('Stopped. You can try again.'));
        else setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally { if (mounted.current) { setBusy(false); setProgress(''); } if (controller.current === abort) controller.current = null; }
  };
  useEffect(() => {
    if (action === 'translate') return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) void run(); });
    return () => { cancelled = true; };
  }, []);
  const checkSources = async () => {
    const info = getDocument();
    if (info.id !== selection.documentId) throw new Error('Return to the source document to apply this result.');
    if (selection.draft) { if (!selection.draft.current()) throw new Error('The text draft changed. Select the text again before applying.'); return info; }
    for (const pageId of new Set(selectedTargets.map(target => target.pageId))) {
      const page = await engine.describePage(info.id, pageId);
      for (const target of selectedTargets.filter(item => item.pageId === pageId)) {
        const block = page.objects.find(object => object.textBlock?.id === target.blockId)?.textBlock;
        if (!block || block.runs.map(run => run.text).join('') !== target.blockText) throw new Error('The source text changed. Select it again before applying.');
      }
    }
    if (getDocument().revision !== info.revision) throw new Error('The document changed. Review the result again.');
    return info;
  };
  const inspect = async () => {
    if (!outcome || disabled || applying || !selectedTargets.length || !canModify) return;
    if (!selection.draft && !await onBeforeWrite()) return;
    setApplying(true); onBusyChange(true); setError(''); setNotice(''); setPreview(null);
    try {
      const info = await checkSources();
      if (selection.draft) { setNotice(t('Apply to the text draft, then finish editing to confirm the PDF layout.')); return; }
      const font = fonts.find(font => font.id === fontId);
      if (font) await ensureEditorFont(engine, font);
      const style: TextStyle = { ...(fontId ? { fontId } : {}), ...(Number(fontSize) > 0 ? { fontSize: Number(fontSize) } : {}) };
      const prepared = await prepareTextActionApplication({ engine, document: info, targets: selectedTargets, units: selectedUnits, texts: outcome.texts, style });
      setLayout(prepared.layout); setPreview(prepared.transaction);
      if (prepared.addedPages) setNotice(t('The translated text continues onto {pages} additional pages.', { pages: prepared.addedPages }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setApplying(false); onBusyChange(false); }
  };
  const apply = async () => {
    if (!outcome || disabled || applying || applied) return;
    setError('');
    if (selection.draft) {
      if (selection.draft.replace(text)) { setApplied(true); setNotice(t('Applied to the text draft. Finish editing to save it to the PDF.')); }
      else setError('The text draft changed. Select the text again before applying.');
      return;
    }
    if (!preview) return;
    setApplying(true); onBusyChange(true);
    try {
      const info = await checkSources();
      if (info.revision !== preview.baseRevision) throw new Error('The document changed. Review the result again.');
      const result = await engine.apply(preview);
      appliedRevision.current = result.revision;
      await onCommitted(result); setApplied(true); setPreview(null); setNotice(t('Applied. You can undo this change.'));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setApplying(false); onBusyChange(false); }
  };
  const addNote = async () => {
    if (!outcome || disabled || applying) return;
    setError('');
    try {
      if (!await onBeforeWrite()) return;
      const info = getDocument();
      if (!info.permissions.annotate || info.id !== selection.documentId) return;
      setApplying(true); onBusyChange(true);
      const commands: EditCommand[] = selectedUnits.map(unit => {
        const target = selection.targets.find(target => target.id === unit.targetIds[0])!;
        return { type: 'annotation.add', pageId: target.pageId, annotationId: crypto.randomUUID(), subtype: 'text',
          bounds: { x: target.rects[0]?.x ?? 24, y: target.rects[0]?.y ?? 24, width: 24, height: 24 },
          text: `${t(TEXT_ACTION_LABELS[outcome.action])}\n\n${outcome.texts[unit.id] ?? ''}`, color: [1, 0.85, 0.3] };
      });
      if (!commands.length) return;
      await onCommitted(await engine.apply({ id: crypto.randomUUID(), docId: info.id, baseRevision: info.revision, source: 'ai', commands }));
      setNotice(t('Saved as a comment. You can undo this change.'));
      const first = commands[0];
      if (first?.type === 'annotation.add' && onCommentCreated) { close(); onCommentCreated(first.pageId, first.annotationId); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setApplying(false); onBusyChange(false); }
  };
  const updateText = (id: string, value: string) => { setOutcome(previous => previous ? { ...previous, texts: { ...previous.texts, [id]: value } } : null); setPreview(null); setLayout({}); setApplied(false); };
  const discuss = () => {
    const material = selectionMaterial(selection, text || undefined, outcome ? { sourceLanguage: outcome.detectedLanguage, targetLanguage: outcome.targetLanguage } : undefined);
    if (getDocument().revision !== selection.revision) {
      material.kind = 'text'; material.locations = material.locations.map(({ pageId, pageNumber }) => ({ pageId, pageNumber }));
    }
    close(); onDiscuss(material);
  };
  const isTranslation = action === 'translate';
  const title = t(isTranslation ? 'Translation' : TEXT_ACTION_LABELS[action]);
  const languageName = (code: string) => TEXT_LANGUAGES.find(language => language.code === code)?.name ?? t(code === 'mul' ? 'Multiple languages' : code === 'und' ? 'Unknown language' : code);
  const copyResult = () => { void navigator.clipboard.writeText(text).then(() => setNotice(t('Copied'))).catch(() => setError('Clipboard access was denied. Select the result and use Ctrl/Cmd+C.')); };
  const layoutOptions = !isDraft && !applied && <details className="ai-layout-options"><summary>{t('Layout options')}</summary>
    <label>{t('Font')}<select value={fontId} disabled={applying} onChange={event => { setFontId(event.target.value); setPreview(null); setLayout({}); }}>
      <option value="">{t('Keep source font')}</option>{fonts.map(font => <option key={font.id} value={font.id}>{font.label ?? `${font.family} ${font.style}`}</option>)}</select></label>
    <label>{t('Font size')}<input type="number" min="1" max="1000" step="0.5" placeholder={t('Keep original')} value={fontSize} onChange={event => { setFontSize(event.target.value); setPreview(null); setLayout({}); }} /></label>
  </details>;

  return <>
    <AppDialog open={active && choosingLanguage} onOpenChange={open => { if (!open) { setChoosingLanguage(false); if (!outcome) close(); } }} title={t('Translate selected text')} className="ai-owned-focus ai-language-dialog">
      <form onSubmit={event => {
        event.preventDefault();
        rememberLanguage();
        setChoosingLanguage(false); void run();
      }}>
        <label>{t('Target language')}<select autoFocus aria-label={t('Target language')} value={targetLanguage} onChange={event => chooseLanguage(event.target.value)}>
          {TEXT_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}
        </select></label>
        <footer><button type="button" className="button" onClick={() => { setChoosingLanguage(false); if (!outcome) close(); }}>{t('Cancel')}</button>
          <button type="submit" className="button button-primary" disabled={disabled}>{t('Confirm')}</button></footer>
      </form>
    </AppDialog>
    <AiFloatingWindow title={title} anchor={selection.anchor} hidden={!active || choosingLanguage} onClose={close}>
      <section className={'task-panel ai-text-panel' + (expanded ? ' ai-text-expanded' : '')} aria-label={t('AI text tools')}>
        <header className="task-panel-header"><span className="ai-free-badge">{t('No KOMO credits')}</span>
          <p className="ai-source-caption" title={selection.name}>{selection.name} · {t('Pages')} {[...new Set(selection.targets.map(target => target.pageNumber))].join(', ')}</p>
        </header>
        <div className="task-panel-body">
          {busy && <p role="status">{progress}</p>}
          {error && <p className="task-error" role="alert">{t(error)}</p>}
          {notice && <p role="status">{notice}</p>}
          {!outcome && <div className="ai-pending-source"><strong>{t('Selected text')}</strong><p dir="auto">{units.map(unit => unit.text).join('\n\n')}</p></div>}
          {outcome && <div className="ai-text-result">
            <div className="ai-result-actions">
              {isTranslation && <div className="ai-result-language"><label>{t('Target language')}<select aria-label={t('Target language')} value={targetLanguage} disabled={busy} onChange={event => chooseLanguage(event.target.value, true)}>
                {TEXT_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}
              </select></label><button type="button" className="button" disabled={busy || disabled} onClick={() => { rememberLanguage(); void run(); }}>{t('Translate again')}</button></div>}
              {isTranslation && outcome.targetLanguage !== targetLanguage && <p role="status">{t('Choose Translate again to update the result.')}</p>}
              {isTranslation && <><button type="button" className="text-button" onClick={() => setExpanded(value => !value)}><Expand size={14} />{t(expanded ? 'Reduce window' : 'Expand window')}</button>
                <button type="button" className="text-button" aria-pressed={showOriginal} onClick={() => setShowOriginal(value => !value)}>{t(showOriginal ? 'Hide original' : 'View original')}</button></>}
            </div>
            {document.revision !== selection.revision && !applied && <p className="task-help">{t('The document changed. The original text will be checked before applying.')}</p>}
            {units.map(unit => {
              const target = selection.targets.find(target => target.id === unit.targetIds[0])!;
              return <article key={unit.id} className="ai-text-candidate">
                <span className="ai-candidate-label">{t('Pages')} {[...new Set(selection.targets.map(item => item.pageNumber))].join(', ')}</span>
                {isTranslation ? <div className={showOriginal ? "ai-bilingual" : "ai-translation-only"}>
                  {showOriginal && <label><span>{t('Original text')} <small>{languageName(outcome.detectedLanguage)}</small></span>
                    <textarea readOnly dir="auto" aria-label={t('Original text on page {page}', { page: target.pageNumber })} value={unit.text} /></label>}
                  <label><span>{t('Translation')} <small>{languageName(outcome.targetLanguage)}</small></span>
                    <textarea dir="auto" aria-label={t('AI result on page {page}', { page: target.pageNumber })} value={outcome.texts[unit.id] ?? ''} disabled={applying || applied}
                      onChange={event => updateText(unit.id, event.target.value)} /></label>
                </div> : <textarea aria-label={t('AI result on page {page}', { page: target.pageNumber })} rows={5} value={outcome.texts[unit.id] ?? ''} disabled={applying || applied}
                  onChange={event => updateText(unit.id, event.target.value)} />}
                {canReplace && !isTranslation && <details><summary>{t('Compare with original')}</summary><AiPanelDiff original={unit.text} suggested={outcome.texts[unit.id] ?? ''} showStats={false} /></details>}
                {layout[unit.id] && <p className={['Layout fits', 'Layout checked'].includes(layout[unit.id]!) ? 'ai-layout-fits' : 'task-error'}>{t(layout[unit.id]!)}</p>}
                {layout[unit.id] && !['Layout fits', 'Layout checked'].includes(layout[unit.id]!) && <button type="button" className="button" onClick={() => onAdjustSource(target)}>{t('Adjust source text box')}</button>}
              </article>;
            })}
            {canReplace && canModify && !applied && (isTranslation ? <details className="ai-replace-choice" open={editOriginal} onToggle={event => setEditOriginal(event.currentTarget.open)}>
              <summary>{t('Replace selected text…')}</summary><p className="task-help">{t('Optional: review and confirm before replacing the selected PDF text. Translation alone does not change the PDF.')}</p>{layoutOptions}
            </details> : layoutOptions)}
          </div>}
        </div>
        <footer className="task-panel-footer ai-text-footer">
          {busy ? <button type="button" className="button" onClick={() => controller.current?.abort()}><Square size={14} />{t('Stop')}</button>
            : (!outcome || !isTranslation) && <button type="button" className="text-button" disabled={disabled} onClick={() => void run()}>{t(outcome ? 'Run again' : 'Retry')}</button>}
          {outcome && <><button type="button" className={isTranslation ? 'button button-primary' : 'button'} onClick={copyResult}><Copy size={16} />{t(isTranslation ? 'Copy translation' : 'Copy result')}</button>
            {document.permissions.annotate && document.capabilities.includes('annotation.add') && <button type="button" className="button" disabled={disabled || applying || !selectedTargets.length} onClick={() => void addNote()}><StickyNote size={16} />{t('Save as comment')}</button>}
            {canReplace && canModify && (!isTranslation || editOriginal) && <button type="button" className="button button-primary" disabled={disabled || applying || applied || !selectedTargets.length || staleDraft}
              onClick={() => void (isDraft || preview ? apply() : inspect())}><Check size={16} />{t(applied ? 'Applied' : applying ? 'Checking layout…' : isDraft ? 'Apply to draft' : preview ? 'Confirm and apply' : 'Review layout')}</button>}</>}
          <button type="button" className="button" onClick={discuss}><MessageSquare size={16} />{t('Continue in KOMO')}</button>
        </footer>
      </section>
    </AiFloatingWindow>
  </>;
}
