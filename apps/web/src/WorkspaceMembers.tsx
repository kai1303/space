import { useEffect, useRef, useState } from 'react';
import { Avatar, Badge, Button, Dialog, Reveal } from '@space/ui';
import { Robot, Users } from '@phosphor-icons/react';
import type { AgentPairing, AgentPairingStatus, WorkspaceParticipant } from '@space/contracts';
import { listAll, request } from './chat-client.js';
import './members.css';
const errorText = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to update members';
const statusText = { online: 'Online', offline: 'Offline', auth_required: 'Sign-in required', error: 'Connection needs attention' };
export function WorkspaceMembers(props: { workspace: string; viewer: string; open: boolean; onClose: () => void }) {
  return props.open ? <MemberDialog key={props.workspace} {...props} /> : null;
}
function MemberDialog({ workspace, viewer, onClose }: { workspace: string; viewer: string; onClose: () => void }) {
  const [members, setMembers] = useState<WorkspaceParticipant[]>([]), [loaded, setLoaded] = useState(false);
  const [pairing, setPairing] = useState<AgentPairing>(), [pairStatus, setPairStatus] = useState<AgentPairingStatus>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const active = useRef(true), pending = useRef<AgentPairing | undefined>(undefined);
  const status = useRef<AgentPairingStatus | undefined>(undefined);
  async function refresh() {
    const items = await listAll<WorkspaceParticipant>(`/workspaces/${workspace}/participants`);
    if (active.current) { setMembers(items); setLoaded(true); }
    const current = pending.current;
    if (current) {
      const value = await request<AgentPairingStatus>(`/agent-pairings/${current.id}`);
      if (active.current && pending.current?.id === current.id) { status.current = value; setPairStatus(value); }
    }
  }
  useEffect(() => {
    active.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); }
      catch (e) { if (active.current) { setError(errorText(e)); if (e instanceof Error && ['unauthorized', 'not_found'].includes(e.message)) { setMembers([]); setPairing(undefined); pending.current = undefined; return; } } }
      if (active.current) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { active.current = false; clearTimeout(timer); };
  }, [workspace]);
  async function createPairing() {
    setBusy(true); setError('');
    try {
      const value = await request<AgentPairing>(`/workspaces/${workspace}/agent-pairings`, {});
      if (!active.current) { void request(`/agent-pairings/${value.id}/cancel`, {}).catch(() => {}); return; }
      pending.current = value; status.current = undefined; setPairing(value); setPairStatus(undefined); setCopied(false);
    } catch (e) { if (active.current) setError(errorText(e)); }
    finally { if (active.current) setBusy(false); }
  }
  async function cancel() {
    if (!pairing) return; setBusy(true); setError('');
    try {
      const result = await request<AgentPairingStatus>(`/agent-pairings/${pairing.id}/cancel`, {});
      if (!active.current) return;
      if (result.status === 'claimed') { status.current = result; setPairStatus(result); await refresh(); }
      else { pending.current = undefined; status.current = undefined; setPairing(undefined); setPairStatus(undefined); }
    } catch (e) { if (active.current) setError(errorText(e)); }
    finally { if (active.current) setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try {
      await request(`/agents/connections/${id}/revoke`, {});
      if (active.current) {
        if (status.current?.installation_id === id) {
          pending.current = undefined; status.current = undefined; setPairing(undefined); setPairStatus(undefined);
        }
        setMembers(old => old.filter(m => m.id !== id)); await refresh();
      }
    }
    catch (e) { if (active.current) setError(errorText(e)); }
    finally { if (active.current) setBusy(false); }
  }
  function close() {
    if (pending.current && status.current?.status !== 'claimed') void request(`/agent-pairings/${pending.current.id}/cancel`, {}).catch(() => {});
    onClose();
  }
  const expired = pairStatus?.status === 'expired' || pairStatus?.status === 'cancelled' || (pairing && Date.parse(pairing.expires_at) <= Date.now() && pairStatus?.status !== 'claimed');
  const connected = members.find(m => m.id === pairStatus?.installation_id);
  const command = `pnpm connector --url ${window.location.origin} --connect`;
  return <Dialog open title="Workspace members" description="People and agents, together in your workspace." onClose={close}>
    <div className="space-members">
      <div className="space-members-heading"><span><Users size={19} /> Members</span><Button size="sm" onClick={() => void createPairing()} loading={busy} disabled={Boolean(pairing && !expired && pairStatus?.status !== 'claimed')}><Robot size={17} /> Connect Local Codex</Button></div>
      {error && <div role="alert" className="space-members-error">{error}<Button size="sm" variant="ghost" onClick={() => { setError(''); void refresh().catch(e => setError(errorText(e))); }}>Retry</Button></div>}
      <Reveal open={Boolean(pairing)} immediateExit>{pairing && <section className="space-pairing" aria-label="Connect Local Codex">
        {pairStatus?.status === 'claimed' ? <><strong>Codex paired with this workspace</strong><p role="status">{connected?.status === 'online' ? 'Your local Codex is connected and signed in.' : 'Complete Continue with ChatGPT in the local connector. Its status will update here.'}</p><Button size="sm" onClick={() => { pending.current = undefined; status.current = undefined; setPairing(undefined); setPairStatus(undefined); }}>Done</Button></> : expired ? <><strong>This pairing code has expired or was cancelled.</strong><Button size="sm" loading={busy} onClick={() => void createPairing()}>Generate new code</Button></> : <>
          <strong>Connect Codex on your computer</strong>
          <ol><li>From your Space checkout, run:<code>{command}</code></li><li>Paste this code when the connector asks:<label className="space-pairing-code">Pairing code<input readOnly value={pairing.code} onFocus={e => e.target.select()} /></label><Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard.writeText(pairing.code).then(() => setCopied(true)).catch(() => setError('Select the code and copy it manually.')); }}>{copied ? 'Copied' : 'Copy code'}</Button></li><li>Choose <strong>Continue with ChatGPT</strong> in the connector to authorize your account.</li></ol>
          <p className="space-members-hint">Code expires at {new Date(pairing.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Only use it on your own computer.</p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>Cancel pairing</Button>
        </>}
      </section>}</Reveal>
      {!loaded && !error && <p role="status">Loading members…</p>}
      <ul className="space-member-list">{members.map(member => <li key={`${member.kind}:${member.id}`}>
        <Avatar name={member.name} initials={member.kind === 'agent' ? 'CX' : member.name.slice(0, 2).toUpperCase()} size="sm" tone={member.kind === 'agent' ? 'purple' : 'blue'} />
        <div className="space-member-details"><div><strong>{member.name}</strong>{member.kind === 'agent' && <Badge>Agent</Badge>}</div><small>{member.kind === 'agent' ? statusText[member.status ?? 'offline'] : member.id === viewer ? 'You' : 'Member'}{member.kind === 'agent' && member.owner_id === viewer ? ' · Owned by you' : ''}</small></div>
        {member.kind === 'agent' && member.owner_id === viewer && <Button size="sm" variant="ghost" aria-label={`Disconnect ${member.name}`} disabled={busy} onClick={() => void revoke(member.id)}>Disconnect</Button>}
      </li>)}</ul>
      <p className="space-members-hint">Local connections report account and connection status. Task execution will be enabled in a separate update.</p>
    </div>
  </Dialog>;
}
