import { useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@space/ui/primitives';
import { authClient } from './auth-client.js';
import { motion, useReducedMotion } from 'motion/react';
import { motionTransition } from '@space/ui/motion';
import { AccessFrame } from './AccessFrame.js';
import { WarningCircle } from '@phosphor-icons/react';

export function AuthScreen({ embedded = false, onAuthenticated, onBusyChange }: { embedded?: boolean; onAuthenticated?: () => void; onBusyChange?: (busy: boolean) => void } = {}) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const reduced = useReducedMotion();
  const pending = busy || opening;
  const errorId = useId();
  const credentialsRejected = error === 'Invalid email or password';
  const submitting = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || opening) return;
    submitting.current = true; setBusy(true); onBusyChange?.(true); setError('');
    try {
      const result = mode === 'sign-up'
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) setError(result.error.message ?? 'Could not sign in. Please try again.');
      else { setPassword(''); if (!embedded) setOpening(true); onAuthenticated?.(); }
    } catch { setError('Cannot reach the server. Please try again.'); }
    finally { submitting.current = false; setBusy(false); onBusyChange?.(false); }
  }
  const form = <motion.form layout={reduced ? false : 'position'} transition={motionTransition(reduced, .22)} onSubmit={submit} aria-busy={pending}>
    {mode === 'sign-up' && <label>Your name<input autoComplete="name" maxLength={100} required disabled={pending} value={name} onChange={e => { setName(e.target.value); setError(''); }} /></label>}
    <label>Email<input type="email" autoComplete="email" required disabled={pending} value={email} aria-invalid={credentialsRejected || undefined} aria-describedby={credentialsRejected ? errorId : undefined} onChange={e => { setEmail(e.target.value); setError(''); }} /></label>
    <label>Password<input type="password" autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} minLength={mode === 'sign-up' ? 12 : undefined} maxLength={128} required disabled={pending} value={password} aria-invalid={credentialsRejected || undefined} aria-describedby={error ? errorId : undefined} onChange={e => { setPassword(e.target.value); setError(''); }} /></label>
    {mode === 'sign-up' && <small>Use at least 12 characters. New accounts start with no access to existing workspaces.</small>}
    <div className="auth-feedback">
      {error && <motion.div id={errorId} className="auth-error" role="alert" initial={reduced ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={motionTransition(reduced)}>
        <WarningCircle size={20} aria-hidden="true" />
        <div><strong>{credentialsRejected ? 'Email or password didn’t match.' : mode === 'sign-in' ? 'We couldn’t sign you in.' : 'We couldn’t create your account.'}</strong><p>{credentialsRejected ? 'Check your details and try again.' : error}</p></div>
      </motion.div>}
    </div>
    <Button variant="primary" type="submit" loading={pending}>{opening ? 'Opening workspace…' : busy ? mode === 'sign-in' ? 'Signing in…' : 'Creating account…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}</Button>
    {pending && <span className="sp-sr-only" role="status">{opening ? 'Opening your workspace…' : mode === 'sign-in' ? 'Signing in…' : 'Creating account…'}</span>}
    <Button variant="ghost" disabled={pending} onClick={() => { setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in'); setError(''); setPassword(''); }}>{mode === 'sign-in' ? 'New here? Create an account' : 'Already have an account? Sign in'}</Button>
  </motion.form>;
  return embedded ? form : <AccessFrame screen={mode} step={mode === 'sign-up' ? 1 : undefined} title={mode === 'sign-in' ? 'Welcome back.' : 'Create your account.'} description={mode === 'sign-in' ? 'Sign in to pick up where you left off.' : 'First, your account. Next, a workspace for your team.'}>{form}</AccessFrame>;
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
