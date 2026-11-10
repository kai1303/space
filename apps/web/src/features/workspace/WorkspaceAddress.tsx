import { workspacePath } from '@space/contracts';
import { useEffect, useState } from 'react';
import { Button } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import { authClient } from '../auth/auth-client.js';

export function WorkspaceAddress({slug,email}:{slug:string;email:string}) {
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const enter=(id:string)=>window.location.assign(workspacePath(id));
  useEffect(()=>{let active=true;request<{workspace_id:string}>(`/workspaces/by-slug/${encodeURIComponent(slug)}`).then(value=>{if(active)enter(value.workspace_id);}).catch(()=>{if(active)setLoading(false);});return()=>{active=false;};},[slug]);
  async function join(){if(busy)return;setBusy(true);setError('');try{const value=await request<{workspace_id:string}>(`/workspaces/by-slug/${encodeURIComponent(slug)}/join`,{});enter(value.workspace_id);}catch(reason){setError(reason instanceof Error?reason.message==='verified_workspace_email_required'?'Verify your email address and use an email domain approved by this workspace.':reason.message==='workspace_reactivation_required'?'Ask a workspace administrator to reactivate your account.':'This workspace is unavailable or your account cannot join it.':'Unable to join.');}finally{setBusy(false);}}
  async function verify(){setBusy(true);try{const result=await authClient.sendVerificationEmail({email,callbackURL:window.location.href});if(result.error)throw new Error(result.error.message);setNotice('Check your email for a verification link.');}catch(reason){setError(reason instanceof Error?reason.message:'Unable to send verification email.');}finally{setBusy(false);}}
  return <main className="chat-login"><section><h1>Join {slug}</h1>{loading?<p role="status">Opening workspace…</p>:<><p>Workspaces can allow people with a verified company email address to join.</p><Button variant="primary" loading={busy} onClick={()=>void join()}>Join workspace</Button><Button disabled={busy} onClick={()=>void verify()}>Verify email address</Button><p><a href="/chat">Back to your workspaces</a></p></>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}</section></main>;
}
