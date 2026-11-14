import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@space/ui/primitives';
import { authClient } from './auth-client.js';
import { motion, useReducedMotion } from 'motion/react';
import { motionTransition } from '@space/ui/motion';
import { AccessFrame, AccessLoading } from './AccessFrame.js';
import { WarningCircle } from '@phosphor-icons/react';

export function AuthScreen({ embedded = false, onAuthenticated, onBusyChange }: { embedded?: boolean; onAuthenticated?: () => void; onBusyChange?: (busy: boolean) => void } = {}) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const reduced = useReducedMotion();
  const errorId = useId();
  const credentialsRejected = error === 'Invalid email or password';
  const submitting = useRef<AbortController | null>(null);
  const draftVersion = useRef(0);
  useEffect(() => () => submitting.current?.abort(), []);

  function edited() {
    draftVersion.current++;
    setError('');
  }
  function switchMode() {
    if (submitting.current) {
      submitting.current.abort();
      submitting.current = null;
      setBusy(false);
      onBusyChange?.(false);
    }
    setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
    setPassword('');
    setError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || opening) return;
    const controller = new AbortController();
    const version = draftVersion.current;
    submitting.current = controller;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      const options = { signal: controller.signal };
      const result = mode === 'sign-up'
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password }, options)
        : await authClient.signIn.email({ email: email.trim(), password }, options);
      if (controller.signal.aborted) return;
      if (result.error) {
        setError(version === draftVersion.current
          ? result.error.message ?? 'Please try again.'
          : 'The submitted details were rejected. Try again with your updated details.');
      } else {
        setPassword('');
        if (!embedded) setOpening(true);
        onAuthenticated?.();
      }
    } catch {
      if (!controller.signal.aborted) setError('Cannot reach the server. Please try again.');
    } finally {
      if (!controller.signal.aborted) {
        submitting.current = null;
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  if (opening) return <AccessLoading />;
  const form = <motion.form layout={reduced ? false : 'position'} transition={motionTransition(reduced, .22)} onSubmit={submit}>
    {mode === 'sign-up' && <label>Your name<input autoComplete="name" maxLength={100} required value={name} onChange={e => { setName(e.target.value); edited(); }} /></label>}
    <label>Email<input type="email" autoComplete="email" required value={email} aria-invalid={credentialsRejected || undefined} aria-describedby={credentialsRejected ? errorId : undefined} onChange={e => { setEmail(e.target.value); edited(); }} /></label>
    <label>Password<input type="password" autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} minLength={mode === 'sign-up' ? 12 : undefined} maxLength={128} required value={password} aria-invalid={credentialsRejected || undefined} aria-describedby={error ? errorId : undefined} onChange={e => { setPassword(e.target.value); edited(); }} /></label>
    {mode === 'sign-up' && <small>Use at least 12 characters. New accounts start with no access to existing workspaces.</small>}
    <div className="auth-feedback">
      {error && <motion.div id={errorId} className="auth-error" role="alert" initial={reduced ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={motionTransition(reduced)}>
        <WarningCircle size={20} aria-hidden="true" />
        <div><strong>{credentialsRejected ? 'Email or password didn’t match.' : mode === 'sign-in' ? 'We couldn’t sign you in.' : 'We couldn’t create your account.'}</strong><p>{credentialsRejected ? 'Check your details and try again.' : error}</p></div>
      </motion.div>}
    </div>
    <Button variant="primary" type="submit" loading={busy}>{busy ? mode === 'sign-in' ? 'Signing in…' : 'Creating account…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}</Button>
    {busy && <span className="sp-sr-only" role="status">{mode === 'sign-in' ? 'Signing in…' : 'Creating account…'}</span>}
    <Button variant="ghost" onClick={switchMode}>{mode === 'sign-in' ? 'New here? Create an account' : 'Already have an account? Sign in'}</Button>
  </motion.form>;
  return embedded ? form : <AccessFrame screen={mode} step={mode === 'sign-up' ? 1 : undefined} title={mode === 'sign-in' ? 'Welcome back.' : 'Create your account.'} description={mode === 'sign-in' ? 'Sign in to pick up where you left off.' : 'First, your account. Next, a workspace for your team.'}>{form}</AccessFrame>;
}
export function SignOutButton({ role }: { role?: 'menuitem' } = {}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function signOut() {
    setBusy(true); setError('');
    try { const result = await authClient.signOut(); if (result.error) setError('Could not sign out. Try again.'); }
    catch { setError('Could not sign out. Try again.'); } finally { setBusy(false); }
  }
  return <><Button role={role} variant="ghost" size="sm" loading={busy} onClick={() => void signOut()}>Sign out</Button>{error && <span role="alert">{error}</span>}</>;
}
