import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { OutboundAgent, OutboundCall, OutboundConnection } from '@space/contracts';
import { Button, Dialog, Select, TextField } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import './connections.css';

const statusText = { untested: 'Not tested', ready: 'Ready', error: 'Needs attention' };
const callStatus = { pending: 'Pending', succeeded: 'Succeeded', failed: 'Failed', uncertain: 'Uncertain' };
// Only local messages are rendered: a remote failure can contain credentials or tool data.
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (['revision_conflict', 'conflict', 'stale_revision'].includes(code)) return 'This connection changed. Refresh and review the latest settings before saving again.';
  if (code === 'invalid_mcp_url') return 'Use a public HTTPS MCP endpoint without credentials, a query, or a fragment.';
  if (code === 'invalid_mcp_token') return 'Enter a valid bearer token.';
  if (['unauthorized', 'forbidden', 'not_found'].includes(code)) return 'This connection is no longer available to your account. Refresh to continue.';
  return 'Could not complete the request. Check the connection settings and try again.';
}

export function Connections({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [items, setItems] = useState<OutboundConnection[]>([]), [agents, setAgents] = useState<OutboundAgent[]>([]), [calls, setCalls] = useState<OutboundCall[]>([]);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [revoked, setRevoked] = useState(false);
  const [editing, setEditing] = useState<OutboundConnection | 'new' | null>(null), [access, setAccess] = useState<string | null>(null), [deleting, setDeleting] = useState<string | null>(null);
  const active = useRef(true), generation = useRef(0);
  async function refresh() {
    const attempt = ++generation.current;
    try {
      const [connections, available, history] = await Promise.all([
        request<{ items: OutboundConnection[] }>('/me/connections'),
        request<{ items: OutboundAgent[] }>('/me/connection-agents'),
        request<{ items: OutboundCall[] }>('/me/connection-calls'),
      ]);
      if (active.current && attempt === generation.current) { setItems(connections.items); setAgents(available.items); setCalls(history.items); setLoaded(true); }
    } catch (e) { if (active.current && attempt === generation.current) { setError(failure(e)); setLoaded(true); } }
  }
  useEffect(() => {
    active.current = true;
    const stop = subscribeUpdates('actor', userId, refresh, () => {
      active.current = false; generation.current++; setItems([]); setAgents([]); setCalls([]); setEditing(null); setAccess(null); setDeleting(null); setRevoked(true); setLoaded(true); setBusy(false);
      setError('Your access changed. Close Connections and sign in again.');
    });
    return () => { active.current = false; generation.current++; stop(); };
  }, [userId]);
  async function mutate(path: string, body: object, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST') {
    if (busy || !active.current) return false;
    setBusy(true); setError(''); generation.current++;
    try {
      await request(path, body, undefined, method);
      if (!active.current) return false;
      await refresh();
      return true;
    } catch (e) { if (active.current) setError(failure(e)); return false; }
    finally { if (active.current) setBusy(false); }
  }
  const selected = items.find(item => item.id === access);
  return <Dialog open title="Connections" description="Your accounts and the tools your agents can use." onClose={onClose} onBeforeClose={() => !busy}>
    <div className="space-connections">
      <p className="space-connections-hint">Connect a remote MCP server using Streamable HTTP over public HTTPS, with a bearer token or no authentication. OAuth and local stdio servers are not supported.</p>
      <p className="space-connections-hint">Connections belong to you. Add separate connections for multiple accounts, then choose tools for each of your agents. New tools are never granted automatically.</p>
      {error && <p role="alert" className="space-connections-error">{error}</p>}
      {!revoked && <div className="space-connections-actions"><Button variant="primary" disabled={busy || !loaded} onClick={() => { setEditing('new'); setAccess(null); setDeleting(null); setError(''); }}>Add connection</Button><Button disabled={busy} onClick={() => { setError(''); void refresh(); }}>Refresh</Button></div>}
      {!loaded ? <p role="status">Loading connections…</p> : !revoked && !items.length && <p>No connections yet. Add an account to get started.</p>}
      {editing && <ConnectionEditor key={editing === 'new' ? 'new' : editing.id} connection={editing === 'new' ? undefined : editing} busy={busy} onCancel={() => setEditing(null)} onSave={async body => {
        const saved = await mutate(editing === 'new' ? '/me/connections' : `/me/connections/${editing.id}`, editing === 'new' ? body : { revision: editing.revision, ...body }, editing === 'new' ? 'POST' : 'PATCH');
        if (saved && active.current) setEditing(null);
      }} />}
      <div className="space-connections-list">{items.map(item => <section className="space-connection" aria-label={item.name} key={item.id}>
        <div className="space-connection-heading"><h3>{item.name}</h3><span>{item.enabled ? 'Enabled' : 'Disabled'}</span></div>
        <p className="space-connection-url">{item.url}</p>
        <p className="space-connections-hint">{item.auth_type === 'bearer' ? 'Bearer token saved' : 'No authentication'} · Last observed: {statusText[item.status]} · {item.tools.length} tools</p>
        <div className="space-connections-actions">
          <Button size="sm" disabled={busy} onClick={() => { setEditing(item); setAccess(null); setDeleting(null); setError(''); }}>Edit</Button>
          <Button size="sm" disabled={busy} onClick={() => void mutate(`/me/connections/${item.id}/discover`, { revision: item.revision })}>Test connection</Button>
          <Button size="sm" disabled={busy} onClick={() => { setAccess(item.id); setEditing(null); setDeleting(null); setError(''); }}>Agent access</Button>
          <Button size="sm" disabled={busy} onClick={() => void mutate(`/me/connections/${item.id}`, { revision: item.revision, enabled: !item.enabled }, 'PATCH')}>{item.enabled ? 'Disable' : 'Enable'}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDeleting(item.id); setEditing(null); setAccess(null); }}>Delete</Button>
        </div>
        {deleting === item.id && <div className="space-connection-confirm"><p>Delete {item.name}? Its saved credentials and agent access will be removed.</p><div className="space-connections-actions"><Button disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button><Button disabled={busy} onClick={async () => { if (await mutate(`/me/connections/${item.id}`, { revision: item.revision }, 'DELETE')) setDeleting(null); }}>Delete connection</Button></div></div>}
      </section>)}</div>
      {selected && <GrantEditor key={`${selected.id}:${selected.revision}`} connection={selected} agents={agents} busy={busy} onSave={async (installation_id, tools) => { if (await mutate(`/me/connections/${selected.id}/grants`, { revision: selected.revision, installation_id, tools }, 'PUT')) setAccess(null); }} onCancel={() => setAccess(null)} />}
      <p className="space-connections-hint">Test connection discovers the server’s current tools. Status shows the last observed result, not a continuous health check.</p>
      <section className="space-connection-history" aria-label="Recent tool calls"><h3>Recent tool calls</h3>
        {!calls.length ? <p className="space-connections-hint">No tool calls yet.</p> : <ul>{calls.map(call => <li key={call.id}><div><strong>{call.tool_name}</strong><span>{callStatus[call.status]}</span></div><p>{call.connection_name} · {call.agent_name}</p><small><time dateTime={call.created_at}>{new Date(call.created_at).toLocaleString()}</time>{call.duration_ms !== null && ` · ${call.duration_ms} ms`}</small>{call.status === 'uncertain' && <p className="space-connections-hint">The remote action may have completed. Check the service before trying it again.</p>}</li>)}</ul>}
      </section>
    </div>
  </Dialog>;
}

function ConnectionEditor({ connection, busy, onSave, onCancel }: { connection?: OutboundConnection; busy: boolean; onSave: (body: object) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(connection?.name ?? ''), [url, setUrl] = useState(connection?.url ?? ''), [auth, setAuth] = useState<'bearer' | 'none'>(connection?.auth_type ?? 'bearer'), [token, setToken] = useState('');
  const requiresToken = auth === 'bearer' && (!connection || connection.auth_type !== 'bearer');
  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = { name: name.trim(), url: url.trim(), auth_type: auth, ...(auth === 'bearer' && token ? { token } : {}) };
    setToken('');
    await onSave(body);
  }
  return <form className="space-connection-editor" onSubmit={submit}>
    <h3>{connection ? `Edit ${connection.name}` : 'Add a connection'}</h3>
    <fieldset disabled={busy}>
      <TextField label="Connection name" required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="GitHub personal" />
      <TextField label="MCP endpoint" type="url" required maxLength={2000} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/mcp" hint="Public HTTPS only. Put credentials in the token field, never in the URL." />
      <label className="space-connection-select">Authentication<Select aria-label="Authentication" value={auth} onChange={event => { setAuth(event.target.value as 'bearer' | 'none'); setToken(''); }}><option value="bearer">Bearer token</option><option value="none">No authentication</option></Select></label>
      {auth === 'bearer' && <TextField label="Bearer token" type="password" autoComplete="new-password" required={requiresToken} maxLength={4096} value={token} onChange={event => setToken(event.target.value)} hint={connection?.auth_type === 'bearer' ? 'Leave blank to keep the saved token. Tokens are never shown again.' : 'Stored securely and sent only to this MCP server.'} />}
    </fieldset>
    {connection && <p className="space-connections-hint">Changing the endpoint or credentials clears discovered tools and agent grants. Test the connection and grant access again afterward.</p>}
    <div className="space-connections-actions"><Button disabled={busy} onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !url.trim() || (requiresToken && !token)}>Save connection</Button></div>
  </form>;
}

function GrantEditor({ connection, agents, busy, onSave, onCancel }: { connection: OutboundConnection; agents: OutboundAgent[]; busy: boolean; onSave: (agent: string, tools: string[]) => Promise<void>; onCancel: () => void }) {
  const [agent, setAgent] = useState(agents[0]?.id ?? '');
  const [tools, setTools] = useState(connection.grants.find(grant => grant.installation_id === agent)?.tools ?? []);
  return <form className="space-connection-editor" onSubmit={event => { event.preventDefault(); if (agents.some(item => item.id === agent)) void onSave(agent, tools); }}>
    <h3>Agent access · {connection.name}</h3>
    <p className="space-connections-hint">Selected tools can act with this account’s permissions. Only grant tools you want this agent to use.</p>
    {!agents.length ? <p>Connect one of your agents to a workspace first.</p> : <fieldset disabled={busy}>
      <label className="space-connection-select">Agent<Select aria-label="Agent" value={agent} onChange={event => { setAgent(event.target.value); setTools(connection.grants.find(grant => grant.installation_id === event.target.value)?.tools ?? []); }}>{agents.map(item => <option key={item.id} value={item.id}>{item.name} · {item.workspace_name}</option>)}</Select></label>
      {!connection.tools.length && <p>Test the connection to discover available tools.</p>}
      {connection.tools.map(tool => <label className="space-connection-tool" key={tool.name}><input type="checkbox" checked={tools.includes(tool.name)} onChange={event => setTools(old => event.target.checked ? [...old, tool.name] : old.filter(name => name !== tool.name))} /><span><strong>{tool.name}</strong>{tool.description && <small>{tool.description}</small>}</span></label>)}
    </fieldset>}
    <div className="space-connections-actions"><Button disabled={busy} onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" disabled={busy || !agents.some(item => item.id === agent)}>Save access</Button></div>
  </form>;
}
