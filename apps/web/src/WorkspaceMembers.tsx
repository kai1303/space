import { subscribeUpdates } from './live-updates.js';
import { useEffect, useRef, useState } from 'react';
import { Avatar, Badge, Button, Dialog, Reveal } from '@space/ui';
import { Robot, Users } from '@phosphor-icons/react';
import { type PairedConnector, type AgentPairing, type AgentPairingStatus, type WorkspaceParticipant } from '@space/contracts';
import { listAll, request } from './chat-client.js';
import './members.css';
const errorText = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to update members';
const statusText = { online: 'Online', offline: 'Offline', auth_required: 'Sign-in required', error: 'Connection needs attention' };
export function WorkspaceMembers(props: { workspace: string; viewer: string; open: boolean; onClose: () => void }) {
  return props.open ? <MemberDialog key={props.workspace} {...props} /> : null;
}
function MemberDialog({ workspace, viewer, onClose }: { workspace: string; viewer: string; onClose: () => void }) {
  const [connector, setConnector] = useState('codex.local'), [connectors, setConnectors] = useState<PairedConnector[]>([]);
  const [members, setMembers] = useState<WorkspaceParticipant[]>([]), [loaded, setLoaded] = useState(false);
  const [pairing, setPairing] = useState<AgentPairing>(), [pairStatus, setPairStatus] = useState<AgentPairingStatus>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const active = useRef(true), pending = useRef<AgentPairing | undefined>(undefined);
  const status = useRef<AgentPairingStatus | undefined>(undefined);
  async function refresh() {
    const [items, registered] = await Promise.all([listAll<WorkspaceParticipant>(`/workspaces/${workspace}/participants`), request<PairedConnector[]>('/agents/connectors')]);
    if (!Array.isArray(registered)) throw new Error('Unable to load connectors');
    if (active.current) { setConnectors(registered); setConnector(current => registered.some(entry => entry.id === current) ? current : registered[0]?.id ?? ''); }
    if (active.current) { setMembers(items); setLoaded(true); }
    const current = pending.current;
    if (current) {
      const value = await request<AgentPairingStatus>(`/agent-pairings/${current.id}`);
      if (active.current && pending.current?.id === current.id) { status.current = value; setPairStatus(value); }
    }
  }
  useEffect(() => {
    active.current = true;
    const update = async () => {
      try { await refresh(); }
      catch (e) { if (active.current) { setError(errorText(e)); if (e instanceof Error && ['unauthorized', 'not_found'].includes(e.message)) { setMembers([]); setPairing(undefined); pending.current = undefined; return; } } }
    };
    const stop = subscribeUpdates('workspace', workspace, update, code => {
      active.current = false; pending.current = undefined; status.current = undefined;
      setMembers([]); setPairing(undefined); setPairStatus(undefined); setLoaded(true); setError(errorText(new Error(code)));
    });
    return () => { active.current = false; stop(); };
  }, [workspace]);
  useEffect(() => {
    if (!pairing || ['claimed', 'expired', 'cancelled'].includes(pairStatus?.status ?? '')) return;
    // Expiry changes with wall-clock time even when no database row is written.
    const timer = setTimeout(() => {
      if (pending.current?.id === pairing.id && status.current?.status !== 'claimed') {
        setPairStatus(current => ({ ...current, status: 'expired' } as AgentPairingStatus));
      }
    }, Math.max(0, Date.parse(pairing.expires_at) - Date.now()));
    return () => clearTimeout(timer);
  }, [pairing, pairStatus?.status]);
  async function createPairing() {
    setBusy(true); setError('');
    try {
      const value = await request<AgentPairing>(`/workspaces/${workspace}/agent-pairings`, { connector_id: connector });
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
  const selected = connectors.find(entry => entry.id === connector);
  const descriptor = connectors.find(entry => entry.id === (pairing?.connector_id ?? connector));
  const pairingProvider = pairing?.provider ?? descriptor?.provider;
  const name = descriptor?.name ?? 'agent';
  const pairingActive = Boolean(pairing && !expired && pairStatus?.status !== 'claimed');
  const command = `pnpm connector${pairingProvider === 'kiro' ? ' --provider kiro' : ''} --url ${window.location.origin} --connect`;
  return <Dialog open title="Workspace members" description="People and agents, together in your workspace." onClose={close}>
    <div className="space-members">
      <div className="space-members-heading"><span><Users size={19} /> Members</span><label className="space-provider-select">Agent provider<select value={connector} disabled={busy || pairingActive} onChange={e => setConnector(e.target.value)}>{connectors.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><Button size="sm" onClick={() => void createPairing()} loading={busy} disabled={pairingActive || !selected}><Robot size={17} /> Connect Local {selected?.name ?? 'agent'}</Button></div>
      {error && <div role="alert" className="space-members-error">{error}<Button size="sm" variant="ghost" onClick={() => { setError(''); void refresh().catch(e => setError(errorText(e))); }}>Retry</Button></div>}
      <Reveal open={Boolean(pairing)} immediateExit>{pairing && <section className="space-pairing" aria-label={`Connect Local ${name}`}>
        {pairStatus?.status === 'claimed' ? <><strong>{name} paired with this workspace</strong><p role="status">{connected?.status === 'online' ? `Your local ${name} is connected and signed in.` : pairingProvider === 'codex' ? 'Complete Continue with ChatGPT in the local connector. Its status will update here.' : `Sign in to ${name} in its connector. Its status will update here.`}</p><Button size="sm" onClick={() => { pending.current = undefined; status.current = undefined; setPairing(undefined); setPairStatus(undefined); }}>Done</Button></> : expired ? <><strong>This pairing code has expired or was cancelled.</strong><Button size="sm" loading={busy} onClick={() => void createPairing()}>Generate new code</Button></> : <>
          <strong>Connect {name} on your computer</strong>
          <ol><li>{pairingProvider ? <>From your Space checkout, run:<code>{command}</code></> : <>Open your {name} connector and start pairing with this Space workspace.</>}</li><li>Paste this code when the connector asks:<label className="space-pairing-code">Pairing code<input readOnly value={pairing.code} onFocus={e => e.target.select()} /></label><Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard.writeText(pairing.code).then(() => setCopied(true)).catch(() => setError('Select the code and copy it manually.')); }}>{copied ? 'Copied' : 'Copy code'}</Button></li><li>{pairingProvider === 'codex' ? <>Choose <strong>Continue with ChatGPT</strong> in the connector to authorize your account.</> : <>Sign in to {name} using the connector’s local login prompt. Your credentials stay on your computer.</>}</li></ol>
          <p className="space-members-hint">Code expires at {new Date(pairing.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Only use it on your own computer.</p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>Cancel pairing</Button>
        </>}
      </section>}</Reveal>
      {!loaded && !error && <p role="status">Loading members…</p>}
      <ul className="space-member-list">{members.map(member => <li key={`${member.kind}:${member.id}`}>
        <Avatar name={member.name} initials={member.kind === 'agent' ? member.name.slice(0, 2).toUpperCase() : member.name.slice(0, 2).toUpperCase()} size="sm" tone={member.kind === 'agent' ? 'purple' : 'blue'} />
        <div className="space-member-details"><div><strong>{member.name}</strong>{member.kind === 'agent' && <Badge>Agent</Badge>}</div><small>{member.kind === 'agent' ? statusText[member.status ?? 'offline'] : member.id === viewer ? 'You' : 'Member'}{member.kind === 'agent' && member.owner_id === viewer ? ' · Owned by you' : ''}</small></div>
        {member.kind === 'agent' && member.owner_id === viewer && <Button size="sm" variant="ghost" aria-label={`Disconnect ${member.name}`} disabled={busy} onClick={() => void revoke(member.id)}>Disconnect</Button>}
      </li>)}</ul>
      <p className="space-members-hint">Pairing grants no channel access. Channel setup currently requires the API. Mention an enabled agent to start a session. The owner's requests autoapprove; other people's requests need the owner's approval.</p>
    </div>
  </Dialog>;
}
