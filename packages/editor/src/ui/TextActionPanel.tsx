import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, MessageSquare, StickyNote, Check, Square, Expand, ArrowUp } from 'lucide-react';
import { preferredAiLanguage, saveAiLanguage } from './ai-preferences.js';
import { AppDialog } from './AppDialog.js';
import { AiFloatingWindow } from './AiFloatingWindow.js';
import { TEXT_LANGUAGES, type CommitResult, type DocumentInfo, type EditCommand, type EditorAiServices, type EngineAdapter, type TextAction, type TextStyle } from '@pdf-editor/contracts';
import { AiPanelDiff } from './AiPanelDiff.js';
import { AiMarkdown } from './AiMarkdown.js';
import { prepareTextActionApplication } from './text-action-application.js';
import { useI18n } from './i18n.js';
import { ensureEditorFont, type EditorFont } from './font-resources.js';
import { TEXT_ACTION_LABELS, normalizeActionText, selectionMaterial, selectionUnits, type AiMaterial, type TextActionSelection, type TextActionTarget } from './text-actions.js';

type Outcome = { action: TextAction; kind: 'answer' | 'replacement'; targetLanguage: string; detectedLanguage: string; texts: Record<string, string> };
type Props = {
  preferenceOwner?: string | null | undefined; onCommentCreated?(pageId: string, annotationId: string): void;
  selection: TextActionSelection; document: DocumentInfo; engine: EngineAdapter; services: EditorAiServices;
  active: boolean; onClose(): void; fonts: EditorFont[]; disabled: boolean; onBusyChange(busy: boolean): void;
  onCommitted(result: CommitResult): Promise<void>; onDiscuss(material: AiMaterial): void;
  onBeforeWrite(): Promise<boolean>; getDocument(): DocumentInfo; onAdjustSource(target: TextActionTarget): void;
};
export function TextActionPanel({ preferenceOwner, onCommentCreated, selection, document, engine, services, active, onClose, fonts, disabled, onBusyChange, onCommitted, onDiscuss, onBeforeWrite, getDocument, onAdjustSource }: Props) {
  const { t, locale } = useI18n();
  const action = selection.action, isTranslation = action === 'translate', custom = action === 'assist';
  const units = useMemo(() => selectionUnits(selection), [selection]);
  const [instruction, setInstruction] = useState('');
  const [targetLanguage, setTargetLanguage] = useState(() => preferredAiLanguage(locale, preferenceOwner));
  const [choosingLanguage, setChoosingLanguage] = useState(isTranslation);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const preferenceState = useRef({ owner: preferenceOwner, edited: false, save: false });
  useEffect(() => {
    if (preferenceOwner === undefined) return;
    const previous = preferenceState.current;
    if (previous.owner === undefined && previous.edited) {
      if (previous.save) saveAiLanguage(preferenceOwner, targetLanguage);
    } else { setTargetLanguage(preferredAiLanguage(locale, preferenceOwner)); previous.edited = false; previous.save = false; }
    previous.owner = preferenceOwner;
  }, [preferenceOwner]);
  const chooseLanguage = (language: string, remember = false) => {
    preferenceState.current.edited = true; preferenceState.current.save = remember; setTargetLanguage(language);
    if (remember) saveAiLanguage(preferenceOwner, language);
  };
  const rememberLanguage = () => { preferenceState.current.save = true; saveAiLanguage(preferenceOwner, targetLanguage); };
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fontId, setFontId] = useState('');
  const [fontSize, setFontSize] = useState('');
  const [layout, setLayout] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState(false);
  const appliedRevision = useRef<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (!active) controller.current?.abort(); }, [active]);
  useEffect(() => {
    setLayout({});
    if (appliedRevision.current !== null && document.revision !== appliedRevision.current) {
      appliedRevision.current = null; setApplied(false); setNotice('');
    }
  }, [document.revision]);
  const text = outcome ? units.map(unit => outcome.texts[unit.id] ?? '').join('\n\n') : '';
  const canReplace = outcome?.kind === 'replacement';
  const selectedTargets = selection.targets;
  const isDraft = Boolean(selection.draft);
  const staleDraft = isDraft && !selection.draft!.current();
  const canModify = document.permissions.modify && document.capabilities.includes('text.replace');
  const close = () => { controller.current?.abort(); onClose(); };
  const run = async () => {
    if (controller.current || disabled || !document.permissions.copy || (custom && !instruction.trim())) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setNotice(''); setLayout({});
    try {
      const unit = units[0];
      if (!unit?.text.trim()) throw new Error('Select text to continue.');
      const response = await services.textAction({ requestId: crypto.randomUUID(), action,
        ...(custom ? { instruction: instruction.trim() } : {}),
        segments: [{ id: unit.id, text: unit.text }], sourceLanguage: 'auto', targetLanguage, tone: 'neutral' }, abort.signal);
      abort.signal.throwIfAborted();
      const result = response.segments.find(item => item.id === unit.id);
      if (!result?.text.trim()) throw new Error('Unable to finish this request. Please try again.');
      setOutcome({ action, kind: response.kind ?? (['explain', 'summarize', 'assist'].includes(action) ? 'answer' : 'replacement'), targetLanguage,
        detectedLanguage: response.detectedLanguage, texts: { [unit.id]: normalizeActionText(result.text) } });
      appliedRevision.current = null; setApplied(false);
    } catch (caught) {
      if (mounted.current) {
        if (abort.signal.aborted) setNotice(t('Stopped'));
        else setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally { if (mounted.current) setBusy(false); if (controller.current === abort) controller.current = null; }
  };
  useEffect(() => {
    if (isTranslation || custom) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) void run(); });
    return () => { cancelled = true; };
  }, []);
  const checkSources = async () => {
    const info = getDocument();
    if (info.id !== selection.documentId) throw new Error('Open the source PDF to apply this result.');
    if (selection.draft) {
      if (!selection.draft.current()) throw new Error('Select the updated text to continue.');
      return info;
    }
    for (const pageId of new Set(selectedTargets.map(target => target.pageId))) {
      const page = await engine.describePage(info.id, pageId);
      for (const target of selectedTargets.filter(target => target.pageId === pageId)) {
        const block = page.objects.find(object => object.textBlock?.id === target.blockId)?.textBlock;
        if (!block || block.runs.map(run => run.text).join('') !== target.blockText) throw new Error('Select the updated text to continue.');
      }
    }
    if (getDocument().revision !== info.revision) throw new Error('The PDF changed. Please try again.');
    return info;
  };
  const apply = async () => {
    if (!outcome || disabled || applying || applied || !canReplace) return;
    setError(''); setNotice('');
    if (selection.draft) {
      if (selection.draft.replace(text)) { setApplied(true); setNotice(t('Applied to draft')); }
      else setError('Select the updated text to continue.');
      return;
    }
    if (!await onBeforeWrite()) return;
    setApplying(true); onBusyChange(true);
    try {
      const info = await checkSources();
      const font = fonts.find(font => font.id === fontId);
      if (font) await ensureEditorFont(engine, font);
      const style: TextStyle = { ...(fontId ? { fontId } : {}), ...(Number(fontSize) > 0 ? { fontSize: Number(fontSize) } : {}) };
      const prepared = await prepareTextActionApplication({ engine, document: info, targets: selectedTargets, units, texts: outcome.texts, style });
      setLayout(prepared.layout);
      if (!prepared.transaction) return;
      const result = await engine.apply(prepared.transaction);
      appliedRevision.current = result.revision;
      await onCommitted(result); setApplied(true); setNotice(t('Applied'));
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
      const commands: EditCommand[] = units.map(unit => {
        const target = selection.targets.find(target => target.id === unit.targetIds[0])!;
        return { type: 'annotation.add', pageId: target.pageId, annotationId: crypto.randomUUID(), subtype: 'text',
          bounds: { x: target.rects[0]?.x ?? 24, y: target.rects[0]?.y ?? 24, width: 24, height: 24 },
          text: `${t(TEXT_ACTION_LABELS[outcome.action])}\n\n${outcome.texts[unit.id] ?? ''}`, color: [1, 0.85, 0.3] };
      });
      if (!commands.length) return;
      await onCommitted(await engine.apply({ id: crypto.randomUUID(), docId: info.id, baseRevision: info.revision, source: 'ai', commands }));
      setNotice(t('Comment saved'));
      const first = commands[0];
      if (first?.type === 'annotation.add' && onCommentCreated) { close(); onCommentCreated(first.pageId, first.annotationId); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setApplying(false); onBusyChange(false); }
  };
  const updateText = (id: string, value: string) => { setOutcome(previous => previous ? { ...previous, texts: { ...previous.texts, [id]: value } } : null); setLayout({}); setApplied(false); };
  const discuss = () => {
    const material = selectionMaterial(selection, text || undefined, outcome ? { sourceLanguage: outcome.detectedLanguage, targetLanguage: outcome.targetLanguage } : undefined);
    if (getDocument().revision !== selection.revision) { material.kind = 'text'; material.locations = material.locations.map(({ pageId, pageNumber }) => ({ pageId, pageNumber })); }
    close(); onDiscuss(material);
  };
  const title = t(isTranslation ? 'Translation' : custom ? 'Use AI' : TEXT_ACTION_LABELS[action]);
  const languageName = (code: string) => TEXT_LANGUAGES.find(language => language.code === code)?.name ?? t(code === 'mul' ? 'Multiple languages' : code === 'und' ? 'Unknown language' : code);
  const copyResult = () => { void navigator.clipboard.writeText(text).then(() => setNotice(t('Copied'))).catch(() => setError('Unable to copy. Select the text and use Ctrl/Cmd+C.')); };

  return <>
    <AppDialog open={active && choosingLanguage} onOpenChange={open => { if (!open) { setChoosingLanguage(false); if (!outcome) close(); } }} title={t('Translate selected text')} className="ai-owned-focus ai-language-dialog">
      <form onSubmit={event => { event.preventDefault(); rememberLanguage(); setChoosingLanguage(false); void run(); }}>
        <label>{t('Target language')}<select autoFocus aria-label={t('Target language')} value={targetLanguage} onChange={event => chooseLanguage(event.target.value)}>
          {TEXT_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}</select></label>
        <footer><button type="button" className="button" onClick={() => { setChoosingLanguage(false); if (!outcome) close(); }}>{t('Cancel')}</button>
          <button type="submit" className="button button-primary" disabled={disabled}>{t('Translate')}</button></footer>
      </form>
    </AppDialog>
    <AiFloatingWindow title={title} anchor={selection.anchor} hidden={!active || choosingLanguage} onClose={close}>
      <section className={'task-panel ai-text-panel' + (expanded ? ' ai-text-expanded' : '')} aria-label={t('AI text tools')}>
        <header className="task-panel-header"><p className="ai-source-caption" title={selection.name}>{selection.name} · {t('Pages')} {[...new Set(selection.targets.map(target => target.pageNumber))].join(', ')}</p></header>
        <div className="task-panel-body">
          {error && <p className="task-error" role="alert">{t(error)}</p>}
          {notice && <p role="status">{notice}</p>}
          {custom && <><details className="ai-pending-source"><summary>{t('Selected text')}</summary><p dir="auto">{units.map(unit => unit.text).join('\n\n')}</p></details>
            <form className="ai-instruction-form" onSubmit={event => { event.preventDefault(); void run(); }}>
              <label className="sr-only" htmlFor={`ai-instruction-${selection.id}`}>{t('AI instruction')}</label>
              <textarea autoFocus id={`ai-instruction-${selection.id}`} rows={2} maxLength={16000} value={instruction} disabled={busy || applying}
                placeholder={t('Ask a question or describe a change…')} onChange={event => setInstruction(event.target.value)} onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void run(); }
                }} />
              <button type="submit" className="button button-primary" disabled={busy || disabled || !instruction.trim()}><ArrowUp size={15} />{t('Send')}</button>
            </form></>}
          {busy && <p role="status">{t('Working…')}</p>}
          {!outcome && !custom && <div className="ai-pending-source"><strong>{t('Selected text')}</strong><p dir="auto">{units.map(unit => unit.text).join('\n\n')}</p></div>}
          {outcome && <div className="ai-text-result">
            {isTranslation && <div className="ai-result-actions"><div className="ai-result-language"><label>{t('Target language')}<select aria-label={t('Target language')} value={targetLanguage} disabled={busy} onChange={event => chooseLanguage(event.target.value, true)}>
              {TEXT_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}</select></label>
              <button type="button" className="button" disabled={busy || disabled} onClick={() => { rememberLanguage(); void run(); }}>{t('Translate again')}</button></div>
              <button type="button" className="text-button" onClick={() => setExpanded(value => !value)}><Expand size={14} />{t(expanded ? 'Reduce window' : 'Expand window')}</button>
              <button type="button" className="text-button" aria-pressed={showOriginal} onClick={() => setShowOriginal(value => !value)}>{t(showOriginal ? 'Hide original' : 'View original')}</button>
            </div>}
            {units.map(unit => {
              const target = selection.targets.find(target => target.id === unit.targetIds[0])!;
              return <article key={unit.id} className="ai-text-candidate">
                {isTranslation ? <div className={showOriginal ? 'ai-bilingual' : 'ai-translation-only'}>
                  {showOriginal && <label><span>{t('Original text')} <small>{languageName(outcome.detectedLanguage)}</small></span>
                    <textarea readOnly dir="auto" aria-label={t('Original text on page {page}', { page: target.pageNumber })} value={unit.text} /></label>}
                  <label><span>{t('Translation')} <small>{languageName(outcome.targetLanguage)}</small></span>
                    <textarea dir="auto" aria-label={t('AI result on page {page}', { page: target.pageNumber })} value={outcome.texts[unit.id] ?? ''} disabled={applying || applied}
                      onChange={event => updateText(unit.id, event.target.value)} /></label>
                </div> : outcome.kind === 'answer' ? <AiMarkdown text={outcome.texts[unit.id] ?? ''} />
                  : <textarea aria-label={t('AI result on page {page}', { page: target.pageNumber })} rows={5} value={outcome.texts[unit.id] ?? ''} disabled={applying || applied} onChange={event => updateText(unit.id, event.target.value)} />}
                {canReplace && !isTranslation && <details><summary>{t('Compare with original')}</summary><AiPanelDiff original={unit.text} suggested={outcome.texts[unit.id] ?? ''} showStats={false} /></details>}
                {layout[unit.id] && layout[unit.id] !== 'Layout checked' && <><p className="task-error">{t(layout[unit.id]!)}</p>
                  <button type="button" className="button" onClick={() => onAdjustSource(target)}>{t('Adjust text box')}</button></>}
              </article>;
            })}
            {canReplace && canModify && !isDraft && !applied && <details className="ai-layout-options"><summary>{t('Layout options')}</summary>
              <label>{t('Font')}<select value={fontId} disabled={applying} onChange={event => { setFontId(event.target.value); setLayout({}); }}><option value="">{t('Keep source font')}</option>{fonts.map(font => <option key={font.id} value={font.id}>{font.label ?? `${font.family} ${font.style}`}</option>)}</select></label>
              <label>{t('Font size')}<input type="number" min="1" max="1000" step="0.5" placeholder={t('Keep original')} value={fontSize} onChange={event => { setFontSize(event.target.value); setLayout({}); }} /></label>
            </details>}
          </div>}
        </div>
        <footer className="task-panel-footer ai-text-footer">
          {busy && <button type="button" className="button" onClick={() => controller.current?.abort()}><Square size={14} />{t('Stop')}</button>}
          {!busy && !custom && !isTranslation && <button type="button" className="text-button" disabled={disabled} onClick={() => void run()}>{t(outcome ? 'Run again' : 'Try again')}</button>}
          {outcome && <><button type="button" className={isTranslation ? 'button button-primary' : 'button'} onClick={copyResult}><Copy size={16} />{t(isTranslation ? 'Copy translation' : 'Copy result')}</button>
            {document.permissions.annotate && document.capabilities.includes('annotation.add') && <button type="button" className="button" disabled={disabled || applying || !selectedTargets.length} onClick={() => void addNote()}><StickyNote size={16} />{t('Save as comment')}</button>}
            {canReplace && canModify && <button type="button" className={isTranslation ? 'button' : 'button button-primary'} disabled={disabled || applying || applied || !selectedTargets.length || staleDraft}
              onClick={() => void apply()}><Check size={16} />{t(applied ? 'Applied' : applying ? 'Applying…' : isDraft ? 'Apply to draft' : 'Apply to PDF')}</button>}</>}
          <button type="button" className="button" onClick={discuss}><MessageSquare size={16} />{t('Continue in komo')}</button>
        </footer>
      </section>
    </AiFloatingWindow>
  </>;
}
