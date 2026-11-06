import { useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@space/ui/primitives';
import { AccessFrame } from '../../auth/AccessFrame.js';
import { SignOutButton } from '../../auth/AuthScreen.js';
import { errorText } from '../../../shared/api/error-text.js';

export function WorkspaceSetup({ name, onCreate }: { name: string; onCreate: (name: string) => Promise<void> }) {
  const [workspaceName, setWorkspaceName] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState(false);
  const submitting = useRef(false), errorId = useId();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    if (!workspaceName.trim()) { setInvalid(true); setError('Enter a workspace name.'); return; }
    submitting.current = true; setBusy(true); setInvalid(false); setError('');
    try { await onCreate(workspaceName.trim()); }
    catch (reason) { setError(errorText(reason)); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <AccessFrame screen="workspace" step={2} title="Name your workspace." description="A shared home for your team’s conversations and ideas.">
    <form onSubmit={submit} aria-busy={busy}>
      <label>Workspace name<input required maxLength={100} autoComplete="organization" placeholder="e.g. Space studio" disabled={busy} value={workspaceName} aria-invalid={invalid || undefined} aria-describedby={error ? errorId : undefined} onChange={event => { setWorkspaceName(event.target.value); setInvalid(false); setError(''); }} /></label>
      {error && <p id={errorId} role="alert">{error}</p>}
      <Button type="submit" variant="primary" loading={busy}>{busy ? 'Creating workspace…' : 'Create workspace'}</Button>
      {busy && <span className="sp-sr-only" role="status">Creating your workspace…</span>}
      <small>Joining an existing team? Open your invitation link, or ask a workspace owner to invite you.</small>
    </form>
    <div className="access-account"><span>Signed in as {name}</span>{!busy && <SignOutButton />}</div>
  </AccessFrame>;
}
