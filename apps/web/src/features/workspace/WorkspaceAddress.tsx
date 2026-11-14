import { workspacePath } from '@space/contracts';
import { Button } from '@space/ui/primitives';
import { useEffect, useRef, useState } from 'react';
import { request } from '../../shared/api/request.js';
import './workspace-address.css';
import { authClient } from '../auth/auth-client.js';

type AddressProps = {slug:string;email:string};
export function WorkspaceAddress(props:AddressProps) {
  return <WorkspaceEntry key={JSON.stringify([props.slug,props.email])} {...props}/>;
}

function WorkspaceEntry({slug,email}:AddressProps) {
  const [access,setAccess] = useState<'checking'|'ready'|'joining'>('checking');
  const [verifying,setVerifying] = useState(false);
  const [joinError,setJoinError] = useState(''), [verifyError,setVerifyError] = useState(''), [notice,setNotice] = useState('');
  const path = `/workspaces/by-slug/${encodeURIComponent(slug)}`;
  const scope = useRef<AbortController | null>(null);
  const enter = (id:string) => window.location.assign(workspacePath(id));
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    request<{workspace_id:string}>(path,undefined,undefined,'POST',controller.signal)
      .then(value => { if (!controller.signal.aborted) enter(value.workspace_id); })
      .catch(() => { if (!controller.signal.aborted) setAccess('ready'); });
    return () => controller.abort();
  },[path]);
  async function join() {
    const signal = scope.current?.signal;
    if (access !== 'ready' || !signal || signal.aborted) return;
    setAccess('joining'); setJoinError('');
    try {
      const value = await request<{workspace_id:string}>(path+'/join',{},undefined,'POST',signal);
      if (!signal.aborted) enter(value.workspace_id);
    } catch (reason) {
      if (signal.aborted) return;
      setAccess('ready');
      setJoinError(reason instanceof Error && reason.message==='verified_workspace_email_required'
        ? 'Verify your email address and use an email domain approved by this workspace.'
        : reason instanceof Error && reason.message==='workspace_reactivation_required'
        ? 'Ask a workspace administrator to reactivate your account.'
        : 'This workspace is unavailable or your account cannot join it.');
    }
  }
  async function verify() {
    const signal = scope.current?.signal;
    if (verifying || !signal || signal.aborted) return;
    setVerifying(true); setVerifyError(''); setNotice('');
    try {
      const result = await authClient.sendVerificationEmail({email,callbackURL:window.location.href},{signal});
      if (result.error) throw new Error(result.error.message);
      if (!signal.aborted) setNotice('Check your email for a verification link.');
    } catch (reason) {
      if (!signal.aborted) setVerifyError(reason instanceof Error ? reason.message : 'Unable to send verification email.');
    } finally { if (!signal.aborted) setVerifying(false); }
  }
  return <main className="chat-login"><section><h1>Join {slug}</h1>
    <p>Workspaces can allow people with a verified company email address to join.</p>
    <div className="workspace-address-actions">
      <Button variant="primary" loading={access!=='ready'} onClick={()=>void join()}>
        {access==='checking'?'Checking workspace access…':access==='joining'?'Joining workspace…':'Join workspace'}
      </Button>
      <Button loading={verifying} onClick={()=>void verify()}>Verify email address</Button>
    </div>
    <p><a href="/chat">Back to your workspaces</a></p>
    {joinError && <p role="alert">{joinError}</p>}{verifyError && <p role="alert">{verifyError}</p>}{notice && <p role="status">{notice}</p>}
  </section></main>;
}
