import { subscribeUpdates } from '../../../shared/realtime/live-updates.js';
import { useEffect, useRef, useState } from 'react';
import { Avatar, Button, Dialog, ListRowSkeleton, Select, toast } from '@space/ui/primitives';
import { ArrowLeft, ArrowRight, CheckCircle, Cloud, Copy, Desktop, Plug, ShieldCheck } from '@phosphor-icons/react';
import { type PairedConnector, type AgentPairing, type AgentPairingStatus, type WorkspaceParticipant } from '@space/contracts';
import { listAll, request } from '../../../shared/api/request.js';
import { MacRunnerLinks } from './MacRunnerLinks.js';
import './members.css';
const errorText = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to update members';
const statusText = { online: 'Online', offline: 'Offline', auth_required: 'Sign-in required', error: 'Connection needs attention' };
export function WorkspaceMembers(props: { returnOnPaired?: boolean; initialConnector?: string; agent?: string; workspace: string; viewer: string; open: boolean; onClose: () => void }) {
  return props.open ? <MemberDialog key={`${props.workspace}:${props.agent ?? props.initialConnector ?? 'new'}`} {...props} /> : null;
}
function MemberDialog({ returnOnPaired, initialConnector, agent, workspace, viewer, onClose }: { returnOnPaired?: boolean; initialConnector?:string; agent?:string; workspace: string; viewer: string; onClose: () => void }) {
  const [connector, setConnector] = useState(initialConnector ?? 'codex.local'), [connectors, setConnectors] = useState<PairedConnector[]>([]);
  const [connectionType, setConnectionType] = useState<'local' | 'cloud' | 'endpoint'>();
  const [members, setMembers] = useState<WorkspaceParticipant[]>([]), [loaded, setLoaded] = useState(false);
  const [providersReady, setProvidersReady] = useState(false);
  const [readErrors, setReadErrors] = useState<Partial<Record<'providers' | 'members' | 'pairing', string>>>({});
  const [revoked, setRevoked] = useState(false);
  const [pairing, setPairing] = useState<AgentPairing>(), [pairStatus, setPairStatus] = useState<AgentPairingStatus>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const active = useRef(true), pending = useRef<AgentPairing | undefined>(undefined);
  const status = useRef<AgentPairingStatus | undefined>(undefined);
  const generation = useRef(0);
  function loseAccess(code: string) {
    generation.current++;
    pending.current = undefined; status.current = undefined;
    setMembers([]); setConnectors([]); setPairing(undefined); setPairStatus(undefined);
    setReadErrors({}); setRevoked(true); setError(errorText(new Error(code)));
  }
  async function refresh() {
    const attempt = ++generation.current;
    const current = () => active.current && attempt === generation.current;
    setReadErrors({});
    async function read<T>(section: keyof typeof readErrors, result: Promise<T>, apply: (value: T) => void) {
      try {
        const value = await result;
        if (current()) apply(value);
      } catch (reason) {
        if (!current()) return;
        if (section === 'members' && reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) {
          loseAccess(reason.message);
          return;
        }
        setReadErrors(previous => ({ ...previous, [section]: errorText(reason) }));
      }
    }
    const pair = pending.current;
    await Promise.all([
      read('members', listAll<WorkspaceParticipant>(`/workspaces/${workspace}/participants`), items => {
        setRevoked(false); setMembers(items); setLoaded(true);
      }),
      read('providers', request<PairedConnector[]>('/agents/connectors'), registered => {
        if (!Array.isArray(registered)) throw new Error('Unable to load connectors');
        setConnectors(registered); setProvidersReady(true);
        setConnector(current => registered.some(entry => entry.id === current) ? current : registered[0]?.id ?? '');
      }),
      pair && read('pairing', request<AgentPairingStatus>(`/agent-pairings/${pair.id}`), value => {
        if (pending.current?.id === pair.id) { status.current = value; setPairStatus(value); }
      }),
    ]);
  }
  useEffect(() => {
    active.current = true;
    const stop = subscribeUpdates('workspace', workspace, refresh, code => {
      active.current = false; loseAccess(code);
    });
    return () => { active.current = false; generation.current++; stop(); };
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
  const desktop = window.spaceDesktop;
  const macBrowser = !desktop && /Mac/.test(navigator.platform) && navigator.maxTouchPoints <= 1;
  async function createPairing() {
    if (!selected || busy || revoked) return;
    setBusy(true); setError('');
    try {
      const value = await request<AgentPairing>(`/workspaces/${workspace}/agent-pairings`, { connector_id: selected.id });
      if (!active.current) { void request(`/agent-pairings/${value.id}/cancel`, {}).catch(() => {}); return; }
      pending.current = value; status.current = undefined; setPairing(value); setPairStatus(undefined); setCopied(false);
      if (desktop && selected.provider) {
        try { await desktop.pair(selected.provider, value.code); }
        catch (reason) {
          const result = await request<AgentPairingStatus>(`/agent-pairings/${value.id}/cancel`, {});
          if (active.current && pending.current?.id === value.id && result.status !== 'claimed') {
            pending.current = undefined; setPairing(undefined); setPairStatus(undefined);
          }
          throw reason;
        }
        if (active.current) await refresh();
      }
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
  async function revoke({id, name}: WorkspaceParticipant) {
    setBusy(true); setError('');
    try {
      await request(`/agents/connections/${id}/revoke`, {});
      if (active.current) {
        toast.success(`Disconnected ${name}`);
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
  const preferred = connectors.find(entry => entry.id === connector) ?? connectors[0];
  const mode = connectionType ?? (preferred && !preferred.provider ? 'cloud' : 'local');
  const available = connectors.filter(entry => mode === 'local' ? Boolean(entry.provider) : mode === 'cloud' && !entry.provider);
  const selected = available.find(entry => entry.id === connector) ?? available[0];
  const descriptor = connectors.find(entry => entry.id === (pairing?.connector_id ?? selected?.id));
  const pairingProvider = pairing?.provider ?? descriptor?.provider;
  const name = descriptor?.name ?? 'agent';
  const remote = !pairingProvider;
  const command = `pnpm connector${pairingProvider && pairingProvider !== 'codex' ? ` --provider ${pairingProvider}` : ''} --url ${window.location.origin} --connect`;
  const agents = members.filter(member => member.kind === 'agent' && (!agent || member.id === agent));
  const types = [
    { id: 'local' as const, label: 'Local runner', icon: <Desktop size={19} /> },
    { id: 'cloud' as const, label: 'Cloud runner', icon: <Cloud size={19} /> },
    { id: 'endpoint' as const, label: 'Hosted endpoint', icon: <Plug size={19} /> },
  ];
  const type = types.find(item => item.id === mode)!;
  const copy = (value: string) => { void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => setError('Select the code and copy it manually.')); };
  return <Dialog open title={agent ? 'Agent connection' : 'Connect an agent'} description={agent ? 'Manage this agent’s connection to your workspace.' : 'Bring your own agent into your team’s conversations.'} onClose={close}>
    <div className="space-members space-agent-dialog">
      {(error || Object.keys(readErrors).length > 0) && <div role="alert" className="space-members-error">{error || Object.values(readErrors).join(' · ')}{active.current && <Button size="sm" variant="ghost" onClick={() => { setError(''); void refresh(); }}>Retry</Button>}</div>}
      {!agent && !pairing && <section className="space-agent-setup" aria-label="Agent setup">
        <div className="space-agent-fields">
          <label className="space-agent-field"><span>Connection type</span>
            <Select aria-label="Connection type" disabled={busy} value={mode} onChange={event => {setConnectionType(event.target.value as 'local' | 'cloud' | 'endpoint');setError('');}}>
              {types.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </Select>
          </label>
          {mode !== 'endpoint' && <label className="space-agent-field"><span>Agent provider</span>
            <Select aria-label="Agent provider" disabled={busy || !selected} value={selected?.id ?? ''} onChange={event => setConnector(event.target.value)}>
              {available.length ? available.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>) : <option value="">{readErrors.providers || revoked ? 'Providers unavailable' : providersReady ? 'No providers available' : 'Loading providers…'}</option>}
            </Select>
          </label>}
        </div>
        {mode === 'endpoint' ? <div className="space-agent-explainer"><span className="space-agent-method-icon"><Plug size={24}/></span><div><h3>Connect a hosted HTTP agent</h3><p>Your Space operator can connect an AG-UI endpoint and enable it for your workspace. Endpoint credentials stay on the server.</p><p className="space-members-hint">Hosted endpoints are configured by your operator, not paired with a code.</p></div></div>
          : selected ? <>
            <div className="space-agent-explainer"><span className="space-agent-method-icon">{mode === 'local' ? <Desktop size={24}/> : <Cloud size={24}/>}</span><div><h3>{mode === 'local' ? 'Runs on your computer' : 'Runs in your cloud environment'}</h3><p>{mode === 'local' ? 'Connect your agent, sign in on your computer, and keep the runner open while you work.' : 'Pair a registered runner on your server or container. It connects securely to Space and sends results back to your conversations.'}</p></div></div>
            {macBrowser && selected.provider && <MacRunnerLinks workspace={workspace} provider={selected.provider}/>}
            <div className="space-agent-setup-action"><span className="space-members-hint">{desktop && selected.provider ? 'Your provider CLI must be installed on this Mac.' : 'You’ll get a code to pair your runner.'}</span><Button variant="primary" loading={busy} disabled={revoked} onClick={() => void createPairing()}>{mode === 'local' ? desktop ? 'Connect on this Mac' : macBrowser ? 'Use the CLI' : `Connect Local ${selected.name}` : `Connect ${selected.name}`}<ArrowRight size={17}/></Button></div>
          </> : providersReady && !readErrors.providers && !revoked && <div className="space-agent-explainer"><span className="space-agent-method-icon">{type.icon}</span><div><h3>{mode === 'cloud' ? 'No cloud connectors configured' : 'No local connectors configured'}</h3><p>{mode === 'cloud' ? 'Ask your Space operator to register your cloud runner. It will appear here when it is available.' : 'Ask your Space operator to enable a local provider.'}</p></div></div>}
      </section>}
      {pairing && <section className="space-pairing" aria-label={`Connect ${name}`}>
        {pairStatus?.status === 'claimed' ? <>
          <div className="space-agent-success"><CheckCircle size={30}/><div><strong>{name} paired with this workspace</strong><p role="status">{connected?.status === 'online' ? remote || pairingProvider === 'claude' ? `${name} is connected and ready.` : `Your local ${name} is connected and signed in.` : remote ? 'Start your cloud runner and finish its setup. Its status will update here.' : pairingProvider === 'codex' ? 'Complete Continue with ChatGPT in the local connector. Its status will update here.' : `Sign in to ${name} in its connector. Its status will update here.`}</p></div></div>
          <Button variant="primary" onClick={() => {pending.current = undefined; status.current = undefined; setPairing(undefined); setPairStatus(undefined); if (returnOnPaired) onClose();}}>Done</Button>
        </> : expired ? <><strong>This pairing code has expired or was cancelled.</strong><p>Create a new code to continue connecting your agent.</p><Button variant="primary" loading={busy} onClick={() => void createPairing()}>Generate new code</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>Back to setup</Button></> : desktop && pairingProvider ? <p role="status">Connecting {name} on this Mac…</p> : <>
          <div className="space-pairing-heading"><span className="space-agent-step-label">PAIR YOUR RUNNER</span><strong>{remote ? `Connect ${name} to your cloud runner` : `Connect ${name} on your computer`}</strong></div>
          <ol className="space-pairing-steps">
            <li><strong>{remote ? 'Open your runner’s connection settings' : 'Start the local runner'}</strong>{remote ? <><p>Use a Space address your runner can reach over HTTPS.</p><label className="space-pairing-code">Space URL<input readOnly value={window.location.origin} onFocus={e => e.target.select()}/></label><p className="space-members-hint">A localhost address is only reachable from this computer. Open your deployed Space address before pairing a cloud runner.</p></> : <><p>{'Run this command from your Space checkout.'}</p><code>{command}</code></>}</li>
            <li><strong>Enter your pairing code</strong><p>Paste this into the runner when prompted.</p><div className="space-pairing-code-row"><label className="space-pairing-code">Pairing code<input readOnly value={pairing.code} onFocus={e => e.target.select()}/></label><Button size="sm" variant="secondary" aria-label={copied ? 'Copied' : 'Copy code'} onClick={() => copy(pairing.code)}><Copy size={16}/>{copied ? 'Copied' : 'Copy'}</Button></div></li>
            <li><strong>{remote ? 'Start your cloud runner' : 'Sign in to your agent'}</strong><p>{remote ? 'Keep the runner connected. Provider credentials stay in your cloud environment.' : pairingProvider === 'codex' ? <>Choose <strong>Continue with ChatGPT</strong> in the connector to authorize your account.</> : <>Sign in to {name} using the connector’s local login prompt. Your credentials stay on your computer.</>}</p></li>
          </ol>
          <div className="space-pairing-footer"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}><ArrowLeft size={16}/>Cancel pairing</Button><span>Expires at {new Date(pairing.expires_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div>
        </>}
      </section>}
      {!loaded && !readErrors.members && !revoked && (!pairing || pairStatus?.status === 'claimed') && <ListRowSkeleton label="Loading connections…"/>}
      {loaded && (!pairing || pairStatus?.status === 'claimed') && agents.length > 0 && <section className="space-agent-connections" aria-label="Connected agents"><h3>{agent ? 'Connection status' : 'In this workspace'}<span>{agents.length}</span></h3><ul className="space-member-list">{agents.map(member => <li key={member.id}>
        <Avatar name={member.name} initials={member.name.slice(0, 2).toUpperCase()} size="sm" tone="purple"/>
        <div className="space-member-details"><strong>{member.name}</strong><small><span className={`space-agent-status-dot space-agent-status-dot--${member.status ?? 'offline'}`}/>{statusText[member.status ?? 'offline']}{member.owner_id === viewer ? ' · Owned by you' : ''}</small></div>
        {member.owner_id === viewer && <Button size="sm" variant="ghost" aria-label={`Disconnect ${member.name}`} disabled={busy} onClick={() => void revoke(member)}>Disconnect</Button>}
      </li>)}</ul></section>}
      <div className="space-agent-permissions"><ShieldCheck size={18}/><p>A paired agent inherits your access to conversations. Channel memory requires a separate grant.</p></div>
    </div>
  </Dialog>;
}
