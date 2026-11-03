import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Reveal } from '@space/ui';
import { Sparkle } from '@phosphor-icons/react';
import type { AgentInstallation, NavigatorCandidate } from '@space/contracts';
import { request } from './chat-client.js';
const errorText = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to request an agent';
type LocalAgent = { id: string; name: string; enabled_in_channel: boolean };

export function AgentRequest({ workspace, channel, thread, agents, onCandidates }: {
  workspace: string; channel: string; thread: string; agents: AgentInstallation[];
  onCandidates: (candidates: NavigatorCandidate[]) => void;
}) {
  const [open, setOpen] = useState(false), [loaded, setLoaded] = useState(false);
  const id = useId(), generation = useRef(0);
  const [available, setAvailable] = useState(agents), [local, setLocal] = useState<LocalAgent[]>([]), [candidates, setCandidates] = useState<NavigatorCandidate[]>([]);
  const [selection, setSelection] = useState(''), [goal, setGoal] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined);
  async function refresh(version: number) {
    const [installations, owned, catalog] = await Promise.all([
      request<AgentInstallation[]>(`/agents/installations?workspace_id=${workspace}`),
      request<LocalAgent[]>(`/channels/${channel}/local-codex`),
      request<{ candidates: NavigatorCandidate[] }>(`/channels/${channel}/navigator`),
    ]);
    if (version !== generation.current) return;
    if (!Array.isArray(catalog.candidates) || !Array.isArray(installations) || !Array.isArray(owned)) throw new Error('Unable to load agents');
    setAvailable(installations); setLocal(owned); setCandidates(catalog.candidates); onCandidates(catalog.candidates); setLoaded(true);
  }
  useEffect(() => {
    const version = ++generation.current;
    if (open) {
      setLoaded(false); setBusy(false); setError('');
      void refresh(version).catch(cause => { if (version === generation.current) { setError(errorText(cause)); setLoaded(true); } });
    }
    return () => { generation.current++; };
  }, [open, workspace, channel]);
  const choices = available.filter(agent => agent.enabled && agent.capabilities.skills.length && (agent.connector_id !== 'codex.local' || candidates.some(candidate => candidate.installation_id === agent.id)));
  async function enable(agent: LocalAgent, enabled: boolean) {
    const version = generation.current;
    setBusy(true); setError('');
    try {
      await request(`/agents/connections/${agent.id}/channels/${channel}`, { enabled });
      await refresh(version);
      if (!enabled && selection.startsWith(`${agent.id}|`)) setSelection('');
    } catch (cause) { if (version === generation.current) setError(errorText(cause)); }
    finally { if (version === generation.current) setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const [installation_id, skill] = selection.split('|');
    const body = { workspace_id: workspace, thread_id: thread, installation_id, skill, goal };
    const fingerprint = JSON.stringify(body);
    if (attempt.current?.body !== fingerprint) attempt.current = { body: fingerprint, key: crypto.randomUUID() };
    const version = generation.current;
    try { await request('/tasks', body, attempt.current.key); if (version === generation.current) { attempt.current = undefined; setGoal(''); } }
    catch (cause) { if (version === generation.current) setError(errorText(cause)); }
    finally { if (version === generation.current) setBusy(false); }
  }
  return <section className="chat-agent-request"><button type="button" className="chat-agent-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><Sparkle size={16} /> Ask an agent</button><Reveal open={open} id={id}>
    {!loaded && <p role="status">Loading agents…</p>}
    {error && <p role="alert">{error}</p>}
    {local.map(agent => <div key={agent.id}><small>{agent.name} {agent.enabled_in_channel ? 'can receive approved tasks in this channel.' : 'is paired. Enable it to receive approved tasks in this channel.'}</small><Button size="sm" variant="ghost" disabled={busy} aria-label={`${agent.enabled_in_channel ? 'Disable' : 'Enable'} ${agent.name} in this channel`} onClick={() => void enable(agent, !agent.enabled_in_channel)}>{agent.enabled_in_channel ? 'Disable in this channel' : 'Enable in this channel'}</Button></div>)}
    {loaded && choices.length > 0 ? <form onSubmit={submit}>
      <label>Agent and skill<select required value={selection} onChange={event => setSelection(event.target.value)}><option value="">Choose a skill</option>{choices.flatMap(agent => agent.capabilities.skills.map(skill => <option key={`${agent.id}|${skill}`} value={`${agent.id}|${skill}`}>{candidates.find(candidate => candidate.installation_id === agent.id)?.name ?? agent.connector_id} · {skill}</option>))}</select></label>
      <label>What should the agent do?<textarea required maxLength={4000} value={goal} onChange={event => setGoal(event.target.value)} /></label><small>The agent owner must approve this task before it runs.</small>
      <Button size="sm" type="submit" loading={busy}>Request task</Button>
    </form> : loaded && !local.length && !error && <p>No agents are available in this channel.</p>}
  </Reveal></section>;
}
