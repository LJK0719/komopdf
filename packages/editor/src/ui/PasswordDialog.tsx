import { useState, useEffect } from 'react';
import { AppDialog } from './AppDialog.js';
import { useI18n } from './i18n.js';

export type PasswordPrompt = { name: string; incorrect: boolean; resolve(value: string | null): void };

export function PasswordDialog({ prompt }: { prompt: PasswordPrompt }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  useEffect(() => { setPassword(''); }, [prompt]);
  const answer = (value: string | null) => { setPassword(''); prompt.resolve(value); };
  return <AppDialog open onOpenChange={open => { if (!open) answer(null); }} title={t('Open encrypted PDF')}>
    <p className="password-filename">{prompt.name}</p>
    {prompt.incorrect && <p role="alert">{t('The password was not accepted. Try again or cancel.')}</p>}
    <form className="password-form" onSubmit={event => { event.preventDefault(); answer(password); }}>
      <label>{t('PDF password')}<input type="password" autoFocus autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <div><button className="button button-quiet" type="button" onClick={() => answer(null)}>{t('Cancel')}</button><button className="button button-primary" type="submit" disabled={!password}>{t('Open')}</button></div>
    </form>
  </AppDialog>;
}
