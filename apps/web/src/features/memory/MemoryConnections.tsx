import { useEffect, useRef, useState } from 'react';
import { Select, Button, LoadingStatus, ListRowSkeleton, toast } from '@space/ui/primitives';
import { Reveal } from '@space/ui/motion';
import type { MemoryConnection, AgentMemoryPermission, AgentMemoryAccess } from '@space/contracts';
import { request } from '../../shared/api/request.js';

export function MemoryConnections({ channel, enabled }: { channel: string; enabled: boolean }) {
  const [items, setItems] = useState<MemoryConnection[]>([]), [loaded, setLoaded] = useState(false);
  const [name, setName] = useState(''), [access, setAccess] = useState<MemoryConnection['access']>('read');
  const [agents, setAgents] = useState<AgentMemoryPermission[]>([]), [installation, setInstallation] = useState(''), [notice, setNotice] = useState('');
  const [issued, setIssued] = useState<{ connection: MemoryConnection; token: string }>();
  const [action, setAction] = useState<'create' | 'update' | null>(null), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const busy = action !== null;
  const [agentsPending,setAgentsPending] = useState(true);
  const [listError,setListError] = useState(''), [agentError,setAgentError] = useState('');
  const denied = useRef(false);
  // The initial list can arrive after a key was created and revoked locally.
  const revokedWhileLoading = useRef<Set<string> | null>(new Set());
  const active = useRef(false), pending = useRef(false);
  const currentEnabled = useRef(enabled); currentEnabled.current = enabled;
  const path = `/channels/${channel}/memory/connections`;
  function failure(error: unknown, report = setError) {
    const code = error instanceof Error ? error.message : 'Unable to update MCP connections';
    if (['unauthorized', 'not_found', 'channel_management_forbidden'].includes(code)) { denied.current = true; setIssued(undefined); setItems([]); setAgents([]); setLoaded(false); }
    report(code.replaceAll('_', ' '));
  }
  useEffect(() => {
    active.current = true;
    let current = true;
    void request<{ items: MemoryConnection[] }>(path).then(connections => {
      if (!current || denied.current) return;
      const existing = connections.items.filter(item => !revokedWhileLoading.current?.has(item.id));
      setItems(created => {
        const ids = new Set(created.map(item => item.id));
        return [...existing.filter(item => !ids.has(item.id)), ...created];
      });
      setLoaded(true);
    }).catch(reason => { if (current) failure(reason, setListError); })
      .finally(() => { if (current) revokedWhileLoading.current = null; });
    void request<{ items: AgentMemoryPermission[] }>(`/channels/${channel}/memory/agents`).then(permissions => {
      if (current && !denied.current) setAgents(permissions.items);
    }).catch(reason => { if (current) failure(reason, setAgentError); })
      .finally(() => { if (current) setAgentsPending(false); });
    return () => { current = false; active.current = false; };
  }, [path]);
  useEffect(() => { if (!enabled) setIssued(undefined); }, [enabled]);
  async function run(work: () => Promise<void>, action: 'create' | 'update' = 'update') {
    if (pending.current) return;
    pending.current = true; setAction(action); setError(''); setNotice('');
    try { await work(); }
    catch (error) { if (active.current) failure(error); }
    finally { pending.current = false; if (active.current) setAction(null); }
  }
  const selectedAgent = agents.find(agent => agent.id === installation);
  const config = issued ? JSON.stringify({ mcpServers: { 'space-memory': { url: `${window.location.origin}/mcp/memory`, headers: { Authorization: `Bearer ${issued.token}` } } } }, null, 2) : '';
  return <section className="channel-memory-connections" aria-label="Agent memory MCP connections"><strong>Connect an agent or Navigator</strong>
    <p>Use MCP tools to read channel conversations, search memory, and save knowledge extracted by your agent. Every key is limited to this channel.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {agentError && <p role="alert">{agentError}</p>}
    {agentsPending && !denied.current && <LoadingStatus>Loading agent permissions…</LoadingStatus>}
    {agents.length > 0 && <section aria-label="Installed agent memory permissions"><strong>Installed agents</strong>
      <p>Choose which agents may receive shared knowledge with their tasks. Agents also need permission to work in this channel. Removing access blocks future retrieval; it cannot erase context already delivered to an agent.</p>
      {agents.map(agent => <label key={agent.id}>Memory access for {agent.name}<Select aria-label={`Memory access for ${agent.name}`} value={agent.access} disabled={busy} onChange={event => {
        const next = event.target.value as AgentMemoryAccess;
        void run(async () => {
          await request(`/channels/${channel}/memory/agents/${agent.id}`, { access: next });
          if (active.current) { setAgents(items => items.map(item => item.id === agent.id ? { ...item, access: next } : item)); setNotice('Memory permission updated.');
            if (installation === agent.id) { setAccess('read'); setIssued(undefined); }
          }
        });
      }}><option value="none">No memory access</option><option value="read" disabled={!enabled}>Read memory</option><option value="contribute" disabled={!enabled}>Read and contribute knowledge</option></Select></label>)}
    </section>}
    {enabled && !denied.current && <form onSubmit={event => { event.preventDefault(); if (denied.current || !name.trim()) return; void run(async () => {
      const created = await request<{ connection: MemoryConnection; token: string }>(path, { name, access, ...(installation ? { installation_id: installation } : {}) });
      if (active.current && !denied.current) { setItems(previous => [...previous.filter(item => item.id !== created.connection.id), created.connection]); if (currentEnabled.current) setIssued(created); setName(''); setCopied(false); }
    }, 'create'); }}><label>Bind key to installation<Select aria-label="Bind key to installation" value={installation} disabled={busy} onChange={event => {
      const id = event.target.value; setInstallation(id); setAccess('read'); setIssued(undefined);
      const agent = agents.find(item => item.id === id); if (agent) setName(agent.name);
    }}><option value="">External agent or Navigator</option>{agents.filter(agent => agent.access !== 'none').map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select></label>
    <label>Agent or Navigator name<input required maxLength={100} value={name} disabled={action === 'create'} placeholder="e.g. Navigator" onChange={event => setName(event.target.value)} /></label>
      <label>MCP access<Select aria-label="MCP access" value={access} disabled={busy} onChange={event => setAccess(event.target.value as MemoryConnection['access'])}><option value="read">Read memory and channel conversations</option>{(!installation || selectedAgent?.access === 'contribute') && <option value="contribute">Read and add source-backed knowledge</option>}{!installation && <option value="write">Read conversations, read and write memory</option>}</Select></label>
      <Button type="submit" disabled={busy || !name.trim() || (!!installation && (!selectedAgent || selectedAgent.access === 'none'))} loading={action === 'create'}>Create MCP key</Button>
    </form>}
    {!enabled && <small>Memory is disabled. Existing keys cannot use tools; you can still revoke them below.</small>}
    <Reveal open={Boolean(issued) && enabled} immediateExit>{issued && <div className="channel-memory-issued"><strong>Connection key created</strong><p>This key is shown only once. Copy the configuration to your MCP client and keep it private.</p><label>MCP client configuration<textarea readOnly value={config} spellCheck={false} /></label>
      <div className="channel-memory-actions"><Button onClick={() => { void navigator.clipboard.writeText(config).then(() => { if (active.current) setCopied(true); }).catch(() => { if (active.current) setError('Select and copy the configuration manually.'); }); }}>{copied ? 'Configuration copied' : 'Copy MCP configuration'}</Button><Button onClick={() => setIssued(undefined)}>Hide key</Button></div>
    </div>}</Reveal>
    {listError && <p role="alert">{listError}</p>}
    {loaded && !items.length && <small>No MCP connections yet.</small>}
    <ul>{items.map(item => <li key={item.id}><div><strong>{item.name}</strong><small>{item.access === 'write' ? 'Read and write memory' : item.access === 'contribute' ? 'Read and contribute knowledge' : 'Read memory'} · Can read channel conversations</small></div><Button size="sm" disabled={busy} aria-label={`Revoke ${item.name}`} onClick={() => void run(async () => {
      await request(`${path}/${item.id}/revoke`, {});
      if (active.current) {
        toast.success(`Memory key “${item.name}” revoked`);
        revokedWhileLoading.current?.add(item.id);
        setItems(previous => previous.filter(connection => connection.id !== item.id)); setIssued(previous => previous?.connection.id === item.id ? undefined : previous); }
    })}>Revoke</Button></li>)}</ul>
    {!loaded && !listError && !denied.current && <ListRowSkeleton label="Loading MCP connections…"/>}
  </section>;
}
