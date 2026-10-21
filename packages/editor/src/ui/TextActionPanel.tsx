import { useEffect, useRef, useState } from 'react';
import { Copy, MessageSquare, StickyNote, Check, Square, Languages, Expand } from 'lucide-react';
import { AppDialog } from './AppDialog.js';
import { TEXT_ACTIONS, TEXT_LANGUAGES, type CommitResult, type DocumentInfo, type EditCommand, type EditTransaction, type EditorAiServices, type EngineAdapter, type TextAction, type TextStyle } from '@pdf-editor/contracts';
import { AiPanelDiff } from './AiPanelDiff.js';
import { prepareTextActionApplication } from './text-action-application.js';
import { useI18n } from './i18n.js';
import { ensureEditorFont, type EditorFont } from './font-resources.js';
import { TEXT_ACTION_LABELS, selectionMaterial, splitTextActionTargets, type AiMaterial, type TextActionSelection, type TextActionTarget } from './text-actions.js';

type Outcome = { action: TextAction; sourceLanguage: string; targetLanguage: string; detectedLanguage: string; texts: Record<string, string> };
type Props = {
  selection: TextActionSelection; document: DocumentInfo; engine: EngineAdapter; services: EditorAiServices;
  fonts: EditorFont[]; disabled: boolean; onBusyChange(busy: boolean): void;
  onCommitted(result: CommitResult): Promise<void>; onDiscuss(material: AiMaterial): void;
  onBeforeWrite(): Promise<boolean>; getDocument(): DocumentInfo; onAdjustSource(target: TextActionTarget): void;
};
const LANGUAGE_KEY = 'komopdf.ai.target-language.v1';
export function preferredAiLanguage(locale: string): string {
  try { const saved = localStorage.getItem(LANGUAGE_KEY); if (TEXT_LANGUAGES.some(language => language.code === saved)) return saved!; } catch { /* Use the interface language. */ }
  return locale.startsWith('zh') ? 'zh' : 'en';
}
export function TextActionPanel({ selection, document, engine, services, fonts, disabled, onBusyChange, onCommitted, onDiscuss, onBeforeWrite, getDocument, onAdjustSource }: Props) {
  const { t, locale } = useI18n();
  const [action, setAction] = useState(selection.action);
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [targetLanguage, setTargetLanguage] = useState(() => preferredAiLanguage(locale));
  const [tone, setTone] = useState<'neutral' | 'formal' | 'concise' | 'friendly' | 'professional' | 'academic'>('neutral');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(true);
  const [editOriginal, setEditOriginal] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fontId, setFontId] = useState('');
  const [fontSize, setFontSize] = useState('');
  const [selected, setSelected] = useState(() => new Set(selection.targets.map(target => target.id)));
  const [preview, setPreview] = useState<EditTransaction | null>(null);
  const [layout, setLayout] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const partial = useRef<{ signature: string; texts: Map<string, string>; detected: string }>({ signature: '', texts: new Map(), detected: '' });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { setPreview(null); setLayout({}); }, [document.revision]);
  const changeLanguage = (language: string) => {
    setTargetLanguage(language);
    try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* Keep the choice for this panel. */ }
  };
  const text = outcome ? selection.targets.map(target => outcome.texts[target.id] ?? '').join('\n\n') : '';
  const canReplace = outcome && !['explain', 'summarize'].includes(outcome.action);
  const selectedTargets = selection.targets.filter(target => selected.has(target.id));
  const isDraft = Boolean(selection.draft);
  const staleDraft = isDraft && !selection.draft!.current();
  const canModify = document.permissions.modify && document.capabilities.includes('text.replace');
  const changedParameters = outcome && (outcome.action !== action || outcome.sourceLanguage !== sourceLanguage || outcome.targetLanguage !== targetLanguage);

  const run = async () => {
    if (busy || disabled || !document.permissions.copy) return;
    const abort = new AbortController(); controller.current = abort;
    const chunks = splitTextActionTargets(selection.targets);
    const signature = JSON.stringify([selection.id, action, sourceLanguage, targetLanguage, tone]);
    if (partial.current.signature !== signature) partial.current = { signature, texts: new Map(), detected: '' };
    const saved = partial.current;
    setBusy(true); setError(''); setNotice(''); setPreview(null); setLayout({});
    try {
      for (const [index, chunk] of chunks.entries()) {
        abort.signal.throwIfAborted();
        setProgress(t('Processing selection {done}/{total}', { done: index + 1, total: chunks.length }));
        if (saved.texts.has(chunk.id)) continue;
        if (!chunk.text.trim()) { saved.texts.set(chunk.id, chunk.text); continue; }
        const response = await services.textAction({ requestId: crypto.randomUUID(), action,
          segments: [{ id: chunk.id, text: chunk.text }], sourceLanguage, targetLanguage, tone }, abort.signal);
        abort.signal.throwIfAborted();
        const result = response.segments.find(item => item.id === chunk.id);
        if (!result) throw new Error('The AI result is incomplete. Try again.');
        saved.texts.set(chunk.id, result.text);
        saved.detected = !saved.detected || saved.detected === response.detectedLanguage ? response.detectedLanguage : 'mul';
      }
      const texts = Object.fromEntries(selection.targets.map(target => [target.id, chunks.filter(chunk => chunk.targetId === target.id).map(chunk => saved.texts.get(chunk.id) ?? '').join(action === 'explain' || action === 'summarize' ? '\n\n' : '\n')]));
      setOutcome({ action, sourceLanguage, targetLanguage, detectedLanguage: saved.detected, texts }); setOptionsOpen(false); setEditOriginal(false);
      setSelected(new Set(selection.targets.map(target => target.id))); setApplied(false);
      partial.current = { signature: '', texts: new Map(), detected: '' };
    } catch (caught) {
      if (abort.signal.aborted) setNotice(t('Stopped. You can resume without repeating completed parts.'));
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally { if (mounted.current) { setBusy(false); setProgress(''); } controller.current = null; }
  };
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
      const prepared = await prepareTextActionApplication({ engine, document: info, targets: selectedTargets, texts: outcome.texts, style });
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
      await onCommitted(await engine.apply(preview)); setApplied(true); setPreview(null); setNotice(t('Applied. You can undo this change.'));
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
      const targets = selection.targets.filter(target => selected.has(target.id));
      const commands: EditCommand[] = targets.map(target => ({ type: 'annotation.add', pageId: target.pageId,
        annotationId: crypto.randomUUID(), subtype: 'text', bounds: { x: target.rects[0]?.x ?? 24, y: target.rects[0]?.y ?? 24, width: 24, height: 24 },
        text: `${t(TEXT_ACTION_LABELS[outcome.action])}\n\n${outcome.texts[target.id] ?? ''}`, color: [1, 0.85, 0.3] }));
      if (!commands.length) return;
      await onCommitted(await engine.apply({ id: crypto.randomUUID(), docId: info.id, baseRevision: info.revision, source: 'ai', commands }));
      setNotice(t('Saved as a comment. You can undo this change.'));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setApplying(false); onBusyChange(false); }
  };
  const updateText = (id: string, value: string) => { setOutcome(previous => previous ? { ...previous, texts: { ...previous.texts, [id]: value } } : null); setPreview(null); setLayout({}); setApplied(false); };
  const discuss = () => {
    const material = selectionMaterial({ ...selection, action: outcome?.action ?? action }, text || undefined,
      outcome ? { sourceLanguage: outcome.detectedLanguage || outcome.sourceLanguage, targetLanguage: outcome.targetLanguage } : undefined);
    if (getDocument().revision !== selection.revision) {
      material.kind = 'text'; material.locations = material.locations.map(({ pageId, pageNumber }) => ({ pageId, pageNumber }));
    }
    setComparisonOpen(false); onDiscuss(material);
  };
  const isTranslation = outcome?.action === 'translate';
  const languageName = (code: string) => TEXT_LANGUAGES.find(language => language.code === code)?.name ?? t(code === 'mul' ? 'Multiple languages' : code === 'und' ? 'Unknown language' : code);
  const copyResult = () => { void navigator.clipboard.writeText(text).then(() => setNotice(t('Copied'))).catch(() => setError('Clipboard access was denied. Select the result and use Ctrl/Cmd+C.')); };
  const layoutOptions = !isDraft && !applied && <details className="ai-layout-options"><summary>{t('Layout options')}</summary>
    <label>{t('Font')}<select value={fontId} disabled={applying} onChange={event => { setFontId(event.target.value); setPreview(null); setLayout({}); }}>
      <option value="">{t('Keep source font')}</option>{fonts.map(font => <option key={font.id} value={font.id}>{font.label ?? `${font.family} ${font.style}`}</option>)}</select></label>
    <label>{t('Font size')}<input type="number" min="1" max="1000" step="0.5" placeholder={t('Keep original')} value={fontSize} onChange={event => { setFontSize(event.target.value); setPreview(null); setLayout({}); }} /></label>
  </details>;

  return <section className="task-panel ai-text-panel ai-owned-focus" aria-label={t('AI text tools')}>
    <header className="task-panel-header"><h2>{t('AI text tools')}</h2><span className="ai-free-badge">{t('No KOMO credits')}</span>
      <p className="ai-source-caption" title={selection.name}>{selection.name} · {t('Pages')} {[...new Set(selection.targets.map(target => target.pageNumber))].join(', ')}</p>
    </header>
    <div className="task-panel-body">
      <details className="ai-action-options" open={optionsOpen} onToggle={event => setOptionsOpen(event.currentTarget.open)}>
      <summary>{t('Tool options')}{outcome && ['translate', 'explain', 'summarize'].includes(outcome.action) ? ` · ${TEXT_LANGUAGES.find(language => language.code === outcome.targetLanguage)?.name ?? outcome.targetLanguage}` : ''}</summary>
      <div className="ai-action-fields"><label>{t('Action')}<select value={action} disabled={busy} onChange={event => setAction(event.target.value as TextAction)}>
        {TEXT_ACTIONS.map(value => <option key={value} value={value}>{t(TEXT_ACTION_LABELS[value])}</option>)}
      </select></label>
      {action === 'translate' && <label>{t('Source language')}<select value={sourceLanguage} disabled={busy} onChange={event => setSourceLanguage(event.target.value)}>
        <option value="auto">{t('Detect automatically')}</option>{TEXT_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}
      </select></label>}
      {['translate', 'explain', 'summarize'].includes(action) && <label>{t('Target language')}<select value={targetLanguage} disabled={busy} onChange={event => changeLanguage(event.target.value)}>
        {TEXT_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}
      </select></label>}
      {action === 'rewrite' && <label>{t('Tone')}<select value={tone} disabled={busy} onChange={event => setTone(event.target.value as typeof tone)}>
        {(['neutral', 'formal', 'concise', 'friendly', 'professional', 'academic'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}
      </select></label>}
      </div></details>
      {!isTranslation && <details className="ai-source-text"><summary>{t('Selected text')} · {selection.targets.reduce((sum, target) => sum + [...target.text].length, 0)}</summary>
        <p>{selection.targets.map(target => target.text).join('\n')}</p></details>}
      {!outcome && <><p className="task-help">{t('Only this selected text is sent to the AI service when you run the tool.')}</p>
        <div className="ai-run-row"><button type="button" className="button button-primary" disabled={busy || disabled || !document.permissions.copy} onClick={() => void run()}>
          <Languages size={16} />{t(action === 'translate' ? 'Translate' : 'Run tool')}
        </button>{busy && <button type="button" className="button" onClick={() => controller.current?.abort()}><Square size={14} />{t('Stop')}</button>}</div></>}
      {busy && <p role="status">{progress}</p>}
      {error && <p className="task-error" role="alert">{t(error)}</p>}
      {notice && <p role="status">{notice}</p>}
      {outcome && <div className="ai-text-result">
        <div className="ai-result-heading"><h3>{t(isTranslation ? 'Bilingual comparison' : TEXT_ACTION_LABELS[outcome.action])}</h3>
          <div className="ai-result-actions">{isTranslation && <button type="button" className="text-button" onClick={() => setComparisonOpen(true)}><Expand size={14} />{t('Expand comparison')}</button>}
            <button type="button" className="text-button" disabled={busy || disabled || !document.permissions.copy} onClick={() => void run()}>{t('Run again')}</button>
            {busy && <button type="button" className="text-button" onClick={() => controller.current?.abort()}>{t('Stop')}</button>}</div></div>
        {changedParameters && <p className="task-help">{t('Options changed. Run again to update the result.')}</p>}
        {document.revision !== selection.revision && !applied && <p className="task-help">{t('The document changed. The original text will be checked before applying.')}</p>}
        {selection.targets.map(target => <article key={target.id} className="ai-text-candidate">
          <label className="ai-candidate-label">{(!isTranslation || editOriginal) && <input type="checkbox" checked={selected.has(target.id)} disabled={applying || applied} onChange={event => {
            setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(target.id); else next.delete(target.id); return next; }); setPreview(null);
          }} />}{t('Page {page}', { page: target.pageNumber })}</label>
          {isTranslation ? <div className="ai-bilingual">
            <label><span>{t('Original text')} <small>{languageName(outcome.detectedLanguage)}</small></span>
              <textarea readOnly dir="auto" aria-label={t('Original text on page {page}', { page: target.pageNumber })} rows={Math.max(2, Math.min(6, Math.ceil(target.text.length / 30)))} value={target.text} /></label>
            <label><span>{t('Translation')} <small>{languageName(outcome.targetLanguage)}</small></span>
              <textarea dir="auto" aria-label={t('AI result on page {page}', { page: target.pageNumber })} rows={Math.max(2, Math.min(6, Math.ceil((outcome.texts[target.id]?.length ?? 0) / 30)))} value={outcome.texts[target.id] ?? ''} disabled={applying || applied}
                onChange={event => updateText(target.id, event.target.value)} /></label>
          </div> : <textarea aria-label={t('AI result on page {page}', { page: target.pageNumber })} rows={5} value={outcome.texts[target.id] ?? ''} disabled={applying || applied}
            onChange={event => updateText(target.id, event.target.value)} />}
          {canReplace && !isTranslation && <details><summary>{t('Compare with original')}</summary><AiPanelDiff original={target.text} suggested={outcome.texts[target.id] ?? ''} showStats={false} /></details>}
          {layout[target.id] && <p className={['Layout fits', 'Layout checked'].includes(layout[target.id]!) ? 'ai-layout-fits' : 'task-error'}>{t(layout[target.id]!)}</p>}
          {layout[target.id] && !['Layout fits', 'Layout checked'].includes(layout[target.id]!) && <button type="button" className="button" onClick={() => onAdjustSource(target)}>{t('Adjust source text box')}</button>}
        </article>)}
        {canReplace && canModify && !applied && (isTranslation ? <details className="ai-replace-choice" open={editOriginal} onToggle={event => setEditOriginal(event.currentTarget.open)}>
          <summary>{t('Replace selected text…')}</summary><p className="task-help">{t('Optional: review and confirm before replacing the selected PDF text. Translation alone does not change the PDF.')}</p>{layoutOptions}
        </details> : layoutOptions)}
      </div>}
    </div>
    <footer className="task-panel-footer ai-text-footer">
      {outcome && <><button type="button" className={isTranslation ? 'button button-primary' : 'button'} onClick={copyResult}><Copy size={16} />{t(isTranslation ? 'Copy translation' : 'Copy result')}</button>
        {document.permissions.annotate && document.capabilities.includes('annotation.add') && <button type="button" className="button" disabled={disabled || applying || !selectedTargets.length} onClick={() => void addNote()}><StickyNote size={16} />{t('Save as comment')}</button>}
        {canReplace && canModify && (!isTranslation || editOriginal) && <button type="button" className="button button-primary" disabled={disabled || applying || applied || !selectedTargets.length || staleDraft}
          onClick={() => void (isDraft || preview ? apply() : inspect())}><Check size={16} />{t(applied ? 'Applied' : applying ? 'Checking layout…' : isDraft ? 'Apply to draft' : preview ? 'Confirm and apply' : 'Review layout')}</button>}</>}
      <button type="button" className="button" onClick={discuss}><MessageSquare size={16} />{t('Continue in KOMO')}</button>
      <small>{t('Opening KOMO is free. Credits are used only when you send a question.')}</small>
    </footer>
    <AppDialog open={comparisonOpen && !!outcome} onOpenChange={setComparisonOpen} title={t('Bilingual comparison')} className="ai-owned-focus ai-comparison-dialog">
      <div className="ai-comparison-expanded"><p className="ai-source-caption">{selection.name}</p><div className="ai-comparison-body">
        {outcome && selection.targets.map(target => <article key={target.id}><h3>{t('Page {page}', { page: target.pageNumber })}</h3><div className="ai-bilingual">
          <section><h4>{t('Original text')} · {languageName(outcome.detectedLanguage)}</h4><p dir="auto">{target.text}</p></section>
          <section><h4>{t('Translation')} · {languageName(outcome.targetLanguage)}</h4><p dir="auto">{outcome.texts[target.id]}</p></section>
        </div></article>)}
      </div><footer className="ai-comparison-footer"><button type="button" className="button button-primary" onClick={copyResult}><Copy size={16} />{t('Copy translation')}</button>
        <button type="button" className="button" onClick={discuss}><MessageSquare size={16} />{t('Continue in KOMO')}</button>
        {notice && <small role="status">{notice}</small>}</footer></div>
    </AppDialog>
  </section>;
}
