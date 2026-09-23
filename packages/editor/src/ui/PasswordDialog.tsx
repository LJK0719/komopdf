import { useEffect, useState } from 'react';

export type PasswordPrompt = { name: string; incorrect: boolean; resolve(value: string | null): void };

export function PasswordDialog({ prompt }: { prompt: PasswordPrompt }) {
  const [password, setPassword] = useState('');
  useEffect(() => { setPassword(''); }, [prompt]);
  const answer = (value: string | null) => { setPassword(''); prompt.resolve(value); };
  return <div className="password-backdrop">
    <section className="password-dialog" role="dialog" aria-modal="true" aria-label="Open encrypted PDF"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); answer(null); } }}>
      <h2>Open encrypted PDF</h2>
      <p>{prompt.name}</p>
      <p>{prompt.incorrect ? 'The password was not accepted. Try again or cancel.' : 'Enter the document password. It is used only on this device.'}</p>
      <form onSubmit={event => { event.preventDefault(); answer(password); }}>
        <label>PDF password<input type="password" autoFocus autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} /></label>
        <button type="submit" disabled={!password}>Open with password</button>
        <button type="button" onClick={() => answer(null)}>Cancel opening</button>
      </form>
    </section>
  </div>;
}
