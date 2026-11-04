import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@space/ui/primitives';
import { authClient } from './auth-client.js';
import { SpaceLogo } from '../../shared/branding/SpaceLogo.js';

export function AuthScreen({ embedded = false, onAuthenticated, onBusyChange }: { embedded?: boolean; onAuthenticated?: () => void; onBusyChange?: (busy: boolean) => void } = {}) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submitting = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true; setBusy(true); onBusyChange?.(true); setError('');
    try {
      const result = mode === 'sign-up'
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) setError(result.error.message ?? 'Could not sign in. Please try again.');
      else { setPassword(''); onAuthenticated?.(); }
    } catch { setError('Cannot reach the server. Please try again.'); }
    finally { submitting.current = false; setBusy(false); onBusyChange?.(false); }
  }
  const form = <form onSubmit={submit}>
    {!embedded && <><div className="chat-brand"><SpaceLogo /></div>
    <h1>{mode === 'sign-in' ? 'Welcome back.' : 'A place to work together.'}</h1>
    <p>{mode === 'sign-in' ? 'Sign in to your workspace.' : 'Create an account to start collaborating.'}</p></>}
    {mode === 'sign-up' && <label>Your name<input autoComplete="name" maxLength={100} required value={name} onChange={e => setName(e.target.value)} /></label>}
    <label>Email<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label>Password<input type="password" autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} minLength={mode === 'sign-up' ? 12 : undefined} maxLength={128} required value={password} onChange={e => setPassword(e.target.value)} /></label>
    {mode === 'sign-up' && <small>Use at least 12 characters. New accounts start with no access to existing workspaces.</small>}
    {error && <p role="alert">{error}</p>}
    <Button variant="primary" type="submit" loading={busy}>{mode === 'sign-in' ? 'Sign in' : 'Create account'}</Button>
    <Button variant="ghost" disabled={busy} onClick={() => { setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in'); setError(''); setPassword(''); }}>{mode === 'sign-in' ? 'New here? Create an account' : 'Already have an account? Sign in'}</Button>
  </form>;
  return embedded ? form : <main className="chat-login">{form}</main>;
}
export function SignOutButton() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function signOut() {
    setBusy(true); setError('');
    try { const result = await authClient.signOut(); if (result.error) setError('Could not sign out. Try again.'); }
    catch { setError('Could not sign out. Try again.'); } finally { setBusy(false); }
  }
  return <><Button variant="ghost" size="sm" loading={busy} onClick={() => void signOut()}>Sign out</Button>{error && <span role="alert">{error}</span>}</>;
}
