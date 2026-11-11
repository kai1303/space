import { useEffect, useState } from 'react';
import { Button, Dialog } from '@space/ui/primitives';
import { MagnifyingGlass, Robot } from '@phosphor-icons/react';
import type { ChannelAgent, NavigatorCandidate } from '@space/contracts';
import { request } from '../../shared/api/request.js';

function useChannelList<T>(path: string, actor: string, revision = 0) {
  const [data, setData] = useState<T>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void request<T>(path, undefined, undefined, 'POST', controller.signal, actor)
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message.replaceAll('_', ' ')); });
    return () => controller.abort();
  }, [path, actor, revision, attempt]);
  return { data, error, retry: () => setAttempt(n => n + 1) };
}
function ListError({ error, retry }: { error: string; retry: () => void }) {
  return <p role="alert">{error} <Button size="sm" onClick={retry}>Retry</Button></p>;
}
function AgentIcon() {
  return <span className="space-channel-app-icon"><Robot size={20}/></span>;
}
function useConnectedAgents(channel: string, actor: string, revision: number) {
  const list = useChannelList<{ candidates: NavigatorCandidate[] }>(`/channels/${channel}/navigator`, actor, revision);
  const connected = new Map(list.data?.candidates.map(item => [item.installation_id, item.name]));
  return { ...list, connected };
}
export function ChannelAgents({ channel, actor, revision, onAdd }: { channel: string; actor: string; revision: number; onAdd: () => void }) {
  const { data, error, retry, connected } = useConnectedAgents(channel, actor, revision);
  return <div className="space-channel-card"><section>
    <div className="space-channel-field-heading"><h3>Agents &amp; apps in this channel</h3>
      {connected.size > 0 && <button className="space-channel-link" onClick={onAdd}>Add more</button>}
    </div>
    {error && <ListError error={error} retry={retry}/>}
    {!data && !error && <p role="status">Loading agents and apps…</p>}
    {data && (connected.size ? <ul className="space-channel-app-list">{[...connected].map(([id, label]) =>
      <li key={id}><AgentIcon/><strong>{label}</strong></li>)}</ul>
      : <><p>No agents or apps have been added to this channel.</p><Button onClick={onAdd}>Add Agent or App</Button></>)}
  </section></div>;
}

export function ChannelAgentPicker({ channel, name, actor, revision, onAdded, onConnect, onClose }: { channel: string; name: string; actor: string; revision: number; onAdded: () => void; onConnect: () => void; onClose: () => void }) {
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [grantError, setGrantError] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const { data, error, retry } = useChannelList<ChannelAgent[]>(`/channels/${channel}/agents`, actor);
  const shared = useConnectedAgents(channel, actor, revision);
  const search = query.trim().toLowerCase();
  const matches = (label: string) => label.toLowerCase().includes(search);
  const choices = (data ?? []).flatMap(agent => agent.inherits_owner_access ? [] : agent.skills.map(skill => ({
    id: agent.id, skill, label: agent.skills.length === 1 ? agent.name : `${agent.name} · ${skill}`,
    added: agent.granted_skills.includes(skill) || added.includes(agent.id + ':' + skill),
  })));
  const available = choices.filter(item => !item.added);
  const visibleChoices = available.filter(item => matches(item.label));
  const connected = [...shared.connected].filter(([, label]) => matches(label));
  const loaded = Boolean(data && shared.data && !error && !shared.error);
  async function add(id: string, skill: string) {
    setBusy(true); setGrantError('');
    try {
      await request(`/agents/connections/${id}/channels/${channel}`, { enabled: true, skill }, undefined, 'POST', undefined, actor);
      setAdded(current => [...current, id + ':' + skill]); onAdded();
    } catch (reason) { setGrantError(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Could not add agent'); }
    finally { setBusy(false); }
  }
  return <Dialog open title="Add agents & apps" onClose={onClose}>
    <div className="space-channel-app-picker"><p>Choose what to add to <strong>#{name}</strong>.</p>
      <label className="space-channel-search"><MagnifyingGlass size={18}/><input type="search" aria-label="Search agents and apps" placeholder="Search agents and apps" value={query} onChange={event => setQuery(event.target.value)}/></label>
      {error && <ListError error={error} retry={retry}/>}
      {shared.error && <ListError error={shared.error} retry={shared.retry}/>}
      {!loaded && !error && !shared.error && <p role="status">Loading agents and apps…</p>}
      {grantError && <p role="alert">{grantError}</p>}
      {connected.length > 0 && <section><h3>Already in #{name}</h3>
        <ul className="space-channel-app-list">{connected.map(([id, label]) =>
          <li key={id}><AgentIcon/><strong>{label}</strong></li>)}</ul>
      </section>}
      {visibleChoices.length > 0 && <section><h3>Available to add</h3>
        <ul className="space-channel-app-list">{visibleChoices.map(item => <li key={item.id + ':' + item.skill}>
          <AgentIcon/><strong>{item.label}</strong>
          <Button size="sm" disabled={busy} aria-label={`Add ${item.label}`} onClick={() => void add(item.id, item.skill)}>Add</Button>
        </li>)}</ul>
      </section>}
      {loaded && search && !visibleChoices.length && !connected.length && <p role="status">No matches.</p>}
      {loaded && !available.length && <div className="space-channel-connect-agent">
        <p>No more agents are available to add from this workspace.</p>
        <Button onClick={onConnect}>Connect a new agent</Button>
      </div>}

    </div>
  </Dialog>;
}
