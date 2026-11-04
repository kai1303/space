import { useEffect, useRef, useState } from 'react';
import { Button, Reveal } from '@space/ui';
import type { MemoryConnection, AgentMemoryPermission, AgentMemoryAccess } from '@space/contracts';
import { request } from './chat-client.js';

export function MemoryConnections({ channel, enabled }: { channel: string; enabled: boolean }) {
  const [items, setItems] = useState<MemoryConnection[]>([]), [loaded, setLoaded] = useState(false);
  const [name, setName] = useState(''), [access, setAccess] = useState<MemoryConnection['access']>('read');
  const [agents, setAgents] = useState<AgentMemoryPermission[]>([]), [installation, setInstallation] = useState(''), [notice, setNotice] = useState('');
  const [issued, setIssued] = useState<{ connection: MemoryConnection; token: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const active = useRef(false), pending = useRef(false);
  const currentEnabled = useRef(enabled); currentEnabled.current = enabled;
  const path = `/channels/${channel}/memory/connections`;
  function failure(error: unknown) {
    const code = error instanceof Error ? error.message : 'Unable to update MCP connections';
    if (['unauthorized', 'not_found', 'channel_management_forbidden'].includes(code)) { setIssued(undefined); setItems([]); setAgents([]); setLoaded(false); }
    setError(code.replaceAll('_', ' '));
  }
  useEffect(() => {
    active.current = true;
    let current = true;
    void Promise.all([request<{ items: MemoryConnection[] }>(path), request<{ items: AgentMemoryPermission[] }>(`/channels/${channel}/memory/agents`)]).then(([connections, permissions]) => {
      if (current) { setItems(connections.items); setAgents(permissions.items); setLoaded(true); }
    }).catch(error => { if (current) failure(error); });
    return () => { current = false; active.current = false; };
  }, [path]);
  useEffect(() => { if (!enabled) setIssued(undefined); }, [enabled]);
  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (error) { if (active.current) failure(error); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const selectedAgent = agents.find(agent => agent.id === installation);
  const config = issued ? JSON.stringify({ mcpServers: { 'space-memory': { url: `${window.location.origin}/mcp/memory`, headers: { Authorization: `Bearer ${issued.token}` } } } }, null, 2) : '';
  return <section className="channel-memory-connections" aria-label="Agent memory MCP connections"><strong>Connect an agent or Navigator</strong>
    <p>Use MCP tools to read channel conversations, search memory, and save knowledge extracted by your agent. Every key is limited to this channel.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {agents.length > 0 && <section aria-label="Installed agent memory permissions"><strong>Installed agents</strong>
      <p>Choose which agents may receive shared knowledge with their tasks. Agents also need permission to work in this channel. Removing access blocks future retrieval; it cannot erase context already delivered to an agent.</p>
      {agents.map(agent => <label key={agent.id}>Memory access for {agent.name}<select value={agent.access} disabled={busy} onChange={event => {
        const next = event.target.value as AgentMemoryAccess;
        void run(async () => {
          await request(`/channels/${channel}/memory/agents/${agent.id}`, { access: next });
          if (active.current) { setAgents(items => items.map(item => item.id === agent.id ? { ...item, access: next } : item)); setNotice('Memory permission updated.');
            if (installation === agent.id) { setAccess('read'); setIssued(undefined); }
          }
        });
      }}><option value="none">No memory access</option><option value="read" disabled={!enabled}>Read memory</option><option value="contribute" disabled={!enabled}>Read and contribute knowledge</option></select></label>)}
    </section>}
    {!loaded && !error && <p role="status">Loading MCP connections…</p>}
    {enabled && <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const created = await request<{ connection: MemoryConnection; token: string }>(path, { name, access, ...(installation ? { installation_id: installation } : {}) });
      if (active.current) { setItems(previous => [...previous, created.connection]); if (currentEnabled.current) setIssued(created); setName(''); setCopied(false); }
    }); }}><label>Bind key to installation<select value={installation} disabled={busy} onChange={event => {
      const id = event.target.value; setInstallation(id); setAccess('read'); setIssued(undefined);
      const agent = agents.find(item => item.id === id); if (agent) setName(agent.name);
    }}><option value="">External agent or Navigator</option>{agents.filter(agent => agent.access !== 'none').map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
    <label>Agent or Navigator name<input required maxLength={100} value={name} disabled={busy} placeholder="e.g. Navigator" onChange={event => setName(event.target.value)} /></label>
      <label>MCP access<select value={access} disabled={busy} onChange={event => setAccess(event.target.value as MemoryConnection['access'])}><option value="read">Read memory and channel conversations</option>{(!installation || selectedAgent?.access === 'contribute') && <option value="contribute">Read and add source-backed knowledge</option>}{!installation && <option value="write">Read conversations, read and write memory</option>}</select></label>
      <Button type="submit" disabled={!name.trim() || (!!installation && (!selectedAgent || selectedAgent.access === 'none'))} loading={busy}>Create MCP key</Button>
    </form>}
    {!enabled && <small>Memory is disabled. Existing keys cannot use tools; you can still revoke them below.</small>}
    <Reveal open={Boolean(issued) && enabled} immediateExit>{issued && <div className="channel-memory-issued"><strong>Connection key created</strong><p>This key is shown only once. Copy the configuration to your MCP client and keep it private.</p><label>MCP client configuration<textarea readOnly value={config} spellCheck={false} /></label>
      <div className="channel-memory-actions"><Button onClick={() => { void navigator.clipboard.writeText(config).then(() => { if (active.current) setCopied(true); }).catch(() => { if (active.current) setError('Select and copy the configuration manually.'); }); }}>{copied ? 'Configuration copied' : 'Copy MCP configuration'}</Button><Button onClick={() => setIssued(undefined)}>Hide key</Button></div>
    </div>}</Reveal>
    {loaded && !items.length && <small>No MCP connections yet.</small>}
    <ul>{items.map(item => <li key={item.id}><div><strong>{item.name}</strong><small>{item.access === 'write' ? 'Read and write memory' : item.access === 'contribute' ? 'Read and contribute knowledge' : 'Read memory'} · Can read channel conversations</small></div><Button size="sm" disabled={busy} aria-label={`Revoke ${item.name}`} onClick={() => void run(async () => {
      await request(`${path}/${item.id}/revoke`, {});
      if (active.current) { setItems(previous => previous.filter(connection => connection.id !== item.id)); setIssued(previous => previous?.connection.id === item.id ? undefined : previous); }
    })}>Revoke</Button></li>)}</ul>
  </section>;
}
