import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ConnectionKind, OutboundAgent, OutboundCall, OutboundConnection, WorkspaceSettings } from '@space/contracts';
import { Button, Dialog, ListRowSkeleton, Select, Spinner, TextField, toast } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { TokenGuide } from './TokenGuide.js';
import './connections.css';

const statusText = { untested: 'Not tested', ready: 'Ready', error: 'Needs attention' };
const callStatus = { pending: 'Pending', succeeded: 'Succeeded', failed: 'Failed', uncertain: 'Uncertain' };
// Only local messages are rendered: a remote failure can contain credentials or tool data.
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (['connection_changed', 'revision_conflict', 'conflict', 'stale_revision'].includes(code)) return 'This connection changed. Refresh and review the latest settings before saving again.';
  if (code === 'outbound_not_configured') return 'The MCP gateway has not been configured for this Space installation.';
  if (code === 'workspace_management_forbidden') return 'Your workspace management access changed.';
  if (code === 'invalid_mcp_url') return 'Use a public HTTPS MCP endpoint without credentials, a query, or a fragment.';
  if (code === 'invalid_mcp_token') return 'Enter a valid bearer token.';
  if (['unauthorized', 'forbidden', 'not_found'].includes(code)) return 'This connection is no longer available to your account. Refresh to continue.';
  return 'Could not complete the request. Check the connection settings and try again.';
}

type AgentPage = { items: OutboundAgent[]; next_cursor?: string | null };
const firstAgentPage: AgentPage & { cursors: string[] } = { items: [], cursors: [] };

type ConnectionPreset = { name: string; url: string; showGuide?: boolean };
type ConnectionsProps = { userId: string; onOpenVault?: () => void; suggested?: ConnectionPreset; onClose: () => void } | { workspaceId: string };

function BrowserVaultSetup({ site, close }: { site: ConnectionPreset; close: () => void }) {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  async function save() {
    setBusy(true); setStatus('');
    try {
      const result = await window.spaceDesktop?.saveBrowserVaultToken?.(site.url);
      if (result === 'saved') close();
      else if (result !== 'cancelled') setStatus('Reopen this website in the Space browser and try again.');
    } catch { setStatus('Vault is unavailable on this Mac.'); }
    finally { setBusy(false); }
  }
  return <Dialog open title={site.name + ' connection'} onClose={close} onBeforeClose={() => !busy}>
    <section className="space-connections">
      <p className="space-connection-url">{site.url}</p>
      <p>Save a token in Keychain on this Mac. In your private browser chat, your paired agent can ask to use a saved token.</p>
      <TokenGuide endpoint={site.url} expanded={!!site.showGuide} local />
      {status && <p role="alert">{status}</p>}
      <Button variant="primary" loading={busy} disabled={busy} onClick={() => void save()}>Save token on this Mac</Button>
    </section>
  </Dialog>;
}

export function Connections(props: ConnectionsProps) {
  if ('suggested' in props && props.suggested && window.spaceDesktop?.saveBrowserVaultToken)
    return <BrowserVaultSetup site={props.suggested} close={props.onClose} />;
  return <ConnectionSettings key={'workspaceId' in props ? 'workspace:'+props.workspaceId : 'user:'+props.userId} {...props}/>;
}

function ConnectionSettings(props: ConnectionsProps) {
  const workspace = 'workspaceId' in props;
  const scopeId = workspace ? props.workspaceId : props.userId;
  const base = workspace ? `/workspaces/${encodeURIComponent(scopeId)}` : '/me';
  const connectionsPath = `${base}/connections`;
  const [role, setRole] = useState<'manager' | 'member'>();
  const [agentPage, setAgentPage] = useState(firstAgentPage);
  const requestedAgentCursors = useRef<string[]>([]);
  const [items, setItems] = useState<OutboundConnection[]>([]), [calls, setCalls] = useState<OutboundCall[]>();
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [revoked, setRevoked] = useState(false);
  const [agentsReady, setAgentsReady] = useState(false);
  const [readErrors, setReadErrors] = useState<Partial<Record<'connections' | 'agents' | 'calls', string>>>({});
  const [editing, setEditing] = useState<OutboundConnection | 'new' | null>(null), [access, setAccess] = useState<string | null>(null), [deleting, setDeleting] = useState<string | null>(null);
  const initialPreset = useRef(workspace ? undefined : props.suggested);
  const [preset, setPreset] = useState<ConnectionPreset>();
  const active = useRef(true), generation = useRef(0);
  function clearAccess(nextRole?: 'member') {
    generation.current++;
    setRole(nextRole); setItems([]); setAgentPage(firstAgentPage); setCalls(undefined); setAgentsReady(false); setReadErrors({});
    requestedAgentCursors.current = [];
    setEditing(null); setAccess(null); setDeleting(null); setBusy(false); setLoaded(false);
  }
  function workspaceDenied(error: unknown) {
    return workspace && error instanceof Error && ['workspace_management_forbidden', 'unauthorized', 'forbidden', 'not_found'].includes(error.message);
  }
  async function refresh(waitForDetails = true) {
    if (!active.current) return;
    setError('');
    const attempt = ++generation.current;
    const current = () => active.current && attempt === generation.current;
    function receiveItems(items: OutboundConnection[]) {
      setItems(items);
      setLoaded(true);
      const site = initialPreset.current;
      if (!site) return;
      initialPreset.current = undefined;
      const endpoint = site.url.replace(/\/$/, '') + '/';
      if (!items.some(item => (item.url.split(/[?#]/, 1)[0] + '/').startsWith(endpoint))) {
        setPreset(site); setEditing('new');
      }
    }
    if (!workspace) {
      setReadErrors({});
      async function read<T>(section: keyof typeof readErrors, result: Promise<T>, apply: (value: T) => void) {
        try {
          const value = await result;
          if (current()) apply(value);
        } catch (reason) {
          if (current()) setReadErrors(previous => ({ ...previous, [section]: failure(reason) }));
        }
      }
      const connections = read('connections', request<{items: OutboundConnection[]}>(connectionsPath), page => receiveItems(page.items));
      const details = Promise.all([
        read('agents', request<AgentPage>('/me/connection-agents'), page => {
          setAgentPage({ ...page, cursors: [] }); setAgentsReady(true);
        }),
        read('calls', request<{items: OutboundCall[]}>('/me/connection-calls'), page => setCalls(page.items)),
      ]);
      await connections;
      if (waitForDetails) await details;
      return;
    }
    try {
      const cursors = requestedAgentCursors.current;
      const settings = await request<WorkspaceSettings>(`${base}/settings`);
      if (!current()) return;
      if (settings.role !== 'owner' && settings.role !== 'admin') {
        clearAccess('member'); setError(''); return;
      }
      setRole('manager');
      const after = cursors.at(-1);
      const pageQuery = after ? `?after=${encodeURIComponent(after)}` : '';
      const page = await request<{ items: OutboundConnection[]; agents: AgentPage }>(`${connectionsPath}${pageQuery}`);
      if (current()) {
        receiveItems(page.items); setAgentPage({ ...page.agents, cursors });
      }
    } catch (reason) {
      if (!current()) return;
      if (workspaceDenied(reason)) clearAccess();
      setError(failure(reason));
    }
  }
  useEffect(() => {
    active.current = true;
    const stop = subscribeUpdates(workspace ? 'workspace' : 'actor', scopeId, refresh, () => {
      active.current = false; clearAccess(); setRevoked(true);
      setError(workspace ? 'You no longer have access to this workspace.' : 'Your access changed. Close Connections and sign in again.');
    });
    return () => { active.current = false; generation.current++; stop(); };
  }, [scopeId, workspace]);
  async function mutate(path: string, body: object, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST') {
    if (busy || !active.current || (workspace && role !== 'manager')) return false;
    setBusy(true); setError(''); if (workspace) generation.current++;
    try {
      await request(path, body, undefined, method, undefined, workspace ? undefined : scopeId);
      if (!active.current) return false;
      await refresh(false);
      return true;
    } catch (e) {
      if (active.current) {
        if (workspaceDenied(e)) clearAccess();
        setError(failure(e));
      }
      return false;
    }
    finally { if (active.current) setBusy(false); }
  }
  function showAgentPage(cursors: string[]) {
    requestedAgentCursors.current = cursors;
    void refresh();
  }
  const selected = items.find(item => item.id === access);
  const canManage = !revoked && (!workspace || role === 'manager');
  const content = <div className="space-connections">
      {!workspace && !revoked && <a href="/vault" onClick={event => {
        if (!props.onOpenVault || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault(); props.onClose(); props.onOpenVault();
      }}>Open personal Vault</a>}
      {workspace && <h2>Workspace MCP servers</h2>}
      {role === 'member' && !revoked && <p>Workspace owners and admins manage MCP servers for this workspace.</p>}
      {canManage && <><p className="space-connections-hint">Connect a remote MCP server using Streamable HTTP over public HTTPS, with a bearer token or no authentication. OAuth and local stdio servers are not supported.</p>
      <p className="space-connections-hint">{workspace ? 'Choose which tools each workspace agent can use with the shared account.' : 'Connections belong to you. Add separate connections for multiple accounts, then choose tools for each of your agents.'} New tools are never granted automatically.</p></>}
      {error && <p role="alert" className="space-connections-error">{error}</p>}
      {canManage && <div className="space-connections-actions"><Button variant="primary" disabled={busy} onClick={() => { initialPreset.current = undefined; setPreset(undefined); setEditing('new'); setAccess(null); setDeleting(null); setError(''); }}>{workspace ? 'Add MCP server' : 'Add connection'}</Button><Button disabled={busy} onClick={() => { setError(''); void refresh(); }}>Refresh</Button></div>}
      {workspace && error && !canManage && !revoked && <Button onClick={() => void refresh()}>Retry</Button>}

      {editing && <ConnectionEditor preset={editing === 'new' ? preset : undefined} workspace={workspace} key={editing === 'new' ? 'new' : editing.id} connection={editing === 'new' ? undefined : editing} busy={busy} onCancel={() => setEditing(null)} onSave={async body => {
        const saved = await mutate(editing === 'new' ? connectionsPath : `${connectionsPath}/${editing.id}`, editing === 'new' ? body : { revision: editing.revision, ...body }, editing === 'new' ? 'POST' : 'PATCH');
        if (saved && active.current) setEditing(null);
      }} />}
      <div className="space-connections-list">
        {readErrors.connections && <p role="alert">{readErrors.connections}</p>}
        {!loaded && !readErrors.connections && (!workspace || !error) && !revoked && role !== 'member' && (workspace && !role
          ? <p className="space-connections-status" role="status"><Spinner/>Checking workspace access…</p>
          : <ListRowSkeleton label={workspace ? "Loading MCP servers…" : "Loading connections…"}/>)}
        {loaded && !readErrors.connections && !error && canManage && !items.length && <p>No connections yet. Add an account to get started.</p>}
        {items.map(item => <section className="space-connection" aria-label={item.name} key={item.id}>
        <div className="space-connection-heading"><h3>{item.name}</h3><span>{item.enabled ? 'Enabled' : 'Disabled'}</span></div>
        <p className="space-connection-url">{item.kind === 'people' ? 'Built-in people directory' : item.kind === 'channels' ? 'Built-in channel directory' : item.url}</p>
        <p className="space-connections-hint">{item.auth_type === 'bearer' ? 'Bearer token saved' : 'No authentication'} · Last observed: {statusText[item.status]} · {item.tools.length} tools</p>
        <div className="space-connections-actions">
          <Button size="sm" disabled={busy} onClick={() => { setEditing(item); setAccess(null); setDeleting(null); setError(''); }}>Edit</Button>
          <Button size="sm" disabled={busy} onClick={() => void mutate(`${connectionsPath}/${item.id}/discover`, { revision: item.revision })}>Test connection</Button>
          <Button size="sm" disabled={busy} onClick={() => { setAccess(item.id); setEditing(null); setDeleting(null); setError(''); }}>Agent access</Button>
          <Button size="sm" disabled={busy} onClick={() => void mutate(`${connectionsPath}/${item.id}`, { revision: item.revision, enabled: !item.enabled }, 'PATCH')}>{item.enabled ? 'Disable' : 'Enable'}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDeleting(item.id); setEditing(null); setAccess(null); }}>Delete</Button>
        </div>
        {deleting === item.id && <div className="space-connection-confirm"><p>Delete {item.name}? Its saved credentials and agent access will be removed.</p><div className="space-connections-actions"><Button disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button><Button disabled={busy} onClick={async () => {
          if (await mutate(`${connectionsPath}/${item.id}`, { revision: item.revision }, 'DELETE')) {
            setDeleting(null);
            toast.success('Connection deleted');
          }
        }}>Delete connection</Button></div></div>}
      </section>)}</div>
      {selected && readErrors.agents && <p role="alert">{readErrors.agents}</p>}
      {selected && !workspace && !agentsReady && !readErrors.agents && <p role="status" className="space-connections-status"><Spinner/>Loading agents…</p>}
      {selected && (workspace || agentsReady) && <GrantEditor workspace={workspace} key={`${selected.id}:${selected.revision}:${agentPage.cursors.at(-1) ?? ''}`} connection={selected} agents={agentPage.items} busy={busy}
        onPrevious={workspace && agentPage.cursors.length ? () => showAgentPage(agentPage.cursors.slice(0, -1)) : undefined}
        onNext={workspace && agentPage.next_cursor ? () => showAgentPage([...agentPage.cursors, agentPage.next_cursor!]) : undefined} onSave={async (installation_id, tools) => { if (await mutate(`${connectionsPath}/${selected.id}/grants`, { revision: selected.revision, installation_id, tools }, 'PUT')) setAccess(null); }} onCancel={() => setAccess(null)} />}
      {canManage && <p className="space-connections-hint">Test connection discovers the server’s current tools. Status shows the last observed result, not a continuous health check.</p>}
      {!workspace && !revoked && <section className="space-connection-history" aria-label="Recent tool calls"><h3>Recent tool calls</h3>
        {readErrors.calls && <p role="alert">{readErrors.calls}</p>}
        {!calls && !readErrors.calls && <p className="space-connections-status" role="status"><Spinner/>Loading recent tool calls…</p>}
        {calls && (!calls.length ? <p className="space-connections-hint">No tool calls yet.</p> : <ul>{calls.map(call => <li key={call.id}><div><strong>{call.tool_name}</strong><span>{callStatus[call.status]}</span></div><p>{call.connection_name} · {call.agent_name}</p><small><time dateTime={call.created_at}>{new Date(call.created_at).toLocaleString()}</time>{call.duration_ms !== null && ` · ${call.duration_ms} ms`}</small>{call.status === 'uncertain' && <p className="space-connections-hint">The remote action may have completed. Check the service before trying it again.</p>}</li>)}</ul>)}
      </section>}
    </div>;
  return workspace ? content : <Dialog open title="Connections" description="Your accounts and the tools your agents can use." onClose={props.onClose} onBeforeClose={() => !busy}>{content}</Dialog>;
}

function ConnectionEditor({ connection, preset, busy, workspace, onSave, onCancel }: { preset?: ConnectionPreset; workspace: boolean; connection?: OutboundConnection; busy: boolean; onSave: (body: object) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(connection?.name ?? preset?.name ?? ''), [url, setUrl] = useState(connection?.url ?? preset?.url ?? ''), [auth, setAuth] = useState<'bearer' | 'none'>(connection?.auth_type ?? 'bearer'), [token, setToken] = useState('');
  const [kind, setKind] = useState<ConnectionKind>(connection?.kind ?? 'mcp');
  const directory = kind === 'people' || kind === 'channels';
  const endpointChanged = workspace && connection && url.trim() !== connection.url;
  const requiresToken = !directory && auth === 'bearer' && (!connection || connection.auth_type !== 'bearer' || endpointChanged);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = {
      ...(!connection && kind !== 'mcp' ? { kind } : {}),
      name: name.trim(), url: directory ? 'space:' + kind : url.trim(), auth_type: directory ? 'none' : auth,
      ...(!directory && auth === 'bearer' && token ? { token } : {}),
    };
    setToken('');
    await onSave(body);
  }
  return <form className="space-connection-editor" onSubmit={submit}>
    <h3>{connection ? `Edit ${connection.name}` : 'Add a connection'}</h3>
    <fieldset disabled={busy}>
      {workspace && !connection && <label className="space-connection-select">Connection type<Select aria-label="Connection type" value={kind} onChange={event => {
        const next = event.target.value as ConnectionKind;
        setKind(next); setToken('');
        if (!name.trim() || name === 'People directory' || name === 'Channel directory')
          setName(next === 'people' ? 'People directory' : next === 'channels' ? 'Channel directory' : '');
      }}><option value="mcp">MCP server</option><option value="people">Space people directory</option><option value="channels">Space channel directory</option><option value="knowledge">External knowledge plugin</option></Select></label>}
      <TextField label="Connection name" required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder={workspace ? "Team GitHub" : "GitHub personal"} />
      {!directory && <><TextField label="MCP endpoint" type="url" required maxLength={2000} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/mcp" hint="Public HTTPS only. Put credentials in the token field, never in the URL." />
      <label className="space-connection-select">Authentication<Select aria-label="Authentication" value={auth} onChange={event => { setAuth(event.target.value as 'bearer' | 'none'); setToken(''); }}><option value="bearer">Bearer token</option><option value="none">No authentication</option></Select></label>
      {auth === 'bearer' && <><TokenGuide endpoint={url} expanded={!!preset?.showGuide} /><TextField label="Bearer token" type="password" autoComplete="new-password" required={requiresToken} maxLength={4096} value={token} onChange={event => setToken(event.target.value)} hint={endpointChanged ? 'Enter a token for the new endpoint.' : connection?.auth_type === 'bearer' ? 'Leave blank to keep the saved token. Tokens are never shown again.' : 'Stored securely and sent only to this MCP server.'} /></>}</>}
    </fieldset>
    {connection && !directory && <p className="space-connections-hint">Changing the endpoint or credentials clears discovered tools and agent grants. Test the connection and grant access again afterward.</p>}
    <div className="space-connections-actions"><Button disabled={busy} onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || (!directory && !url.trim()) || (requiresToken && !token)}>Save connection</Button></div>
  </form>;
}

function GrantEditor({ connection, agents, busy, workspace, onPrevious, onNext, onSave, onCancel }: { onPrevious?: () => void; onNext?: () => void; workspace: boolean; connection: OutboundConnection; agents: OutboundAgent[]; busy: boolean; onSave: (agent: string, tools: string[]) => Promise<void>; onCancel: () => void }) {
  const [agent, setAgent] = useState(agents[0]?.id ?? '');
  const savedTools = connection.grants.find(grant => grant.installation_id === agent)?.tools ?? [];
  const [tools, setTools] = useState(savedTools);
  const selected = agents.find(item => item.id === agent);
  const removeOnly = workspace && selected?.can_grant === false;
  const selectedTools = removeOnly ? tools.filter(name => savedTools.includes(name)) : tools;
  const canSave = !busy && !!selected && (!removeOnly || selectedTools.length < savedTools.length);
  return <form className="space-connection-editor" onSubmit={event => { event.preventDefault(); if (canSave) void onSave(agent, selectedTools); }}>
    <h3>Agent access · {connection.name}</h3>
    <p className="space-connections-hint">Selected tools can act with this account’s permissions. Only grant tools you want this agent to use.</p>
    {(onPrevious || onNext) && <div className="space-connections-actions">
      {onPrevious && <Button size="sm" disabled={busy} onClick={onPrevious}>Previous agents</Button>}
      {onNext && <Button size="sm" disabled={busy} onClick={onNext}>Next agents</Button>}
    </div>}
    {!agents.length ? <p>{workspace ? 'Connect an agent to this workspace first.' : 'Connect one of your agents to a workspace first.'}</p> : <fieldset disabled={busy}>
      <label className="space-connection-select">Agent<Select aria-label="Agent" value={agent} onChange={event => { setAgent(event.target.value); setTools(connection.grants.find(grant => grant.installation_id === event.target.value)?.tools ?? []); }}>{agents.map(item => <option key={item.id} value={item.id}>{item.name} · {item.workspace_name}{workspace && item.can_grant === false && ' · Unavailable'}</option>)}</Select></label>
      {removeOnly && <p className="space-connections-hint">This agent is unavailable. You can remove its existing tool access.</p>}
      {!connection.tools.length && <p>Test the connection to discover available tools.</p>}
      {connection.tools.map(tool => <label className="space-connection-tool" key={tool.name}><input type="checkbox" checked={selectedTools.includes(tool.name)} disabled={removeOnly && !savedTools.includes(tool.name)} onChange={event => setTools(old => event.target.checked ? [...old, tool.name] : old.filter(name => name !== tool.name))} /><span><strong>{tool.name}</strong>{tool.description && <small>{tool.description}</small>}</span></label>)}
    </fieldset>}
    <div className="space-connections-actions"><Button disabled={busy} onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" disabled={!canSave}>Save access</Button></div>
  </form>;
}
