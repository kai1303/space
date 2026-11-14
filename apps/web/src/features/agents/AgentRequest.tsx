import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Select, Button, LoadingStatus } from '@space/ui/primitives';
import { Reveal } from '@space/ui/motion';
import { Sparkle } from '@phosphor-icons/react';
import type { AgentInstallation, ChannelAgent, NavigatorCandidate } from '@space/contracts';
import { request } from '../../shared/api/request.js';
const errorText = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to request an agent';
type LocalAgent = ChannelAgent;

export function AgentRequest({ workspace, channel, thread, agents, onCandidates }: {
  workspace: string; channel: string; thread: string; agents: AgentInstallation[];
  onCandidates: (candidates: NavigatorCandidate[]) => void;
}) {
  const [open, setOpen] = useState(false), [loaded, setLoaded] = useState(false);
  const [localReady,setLocalReady]=useState(false);
  const id = useId(), generation = useRef(0);
  const [available, setAvailable] = useState(agents), [local, setLocal] = useState<LocalAgent[]>([]), [candidates, setCandidates] = useState<NavigatorCandidate[]>([]);
  const [selection, setSelection] = useState(''), [goal, setGoal] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined);
  async function refresh(version: number) {
    await Promise.all([
      request<LocalAgent[]>(`/channels/${channel}/agents`).then(owned=>{
        if(version!==generation.current)return;
        if(!Array.isArray(owned))throw new Error('Unable to load agents');
        setLocal(owned);setLocalReady(true);
      }),
      Promise.all([
        request<AgentInstallation[]>(`/agents/installations?workspace_id=${workspace}`),
        request<{candidates: NavigatorCandidate[]}>(`/channels/${channel}/navigator`),
      ]).then(([installations,catalog])=>{
        if(version!==generation.current)return;
        if(!Array.isArray(installations)||!Array.isArray(catalog.candidates))throw new Error('Unable to load agents');
        setAvailable(installations);setCandidates(catalog.candidates);onCandidates(catalog.candidates);setLoaded(true);
      }),
    ]);
  }
  useEffect(() => {
    const version = ++generation.current;
    if (open) {
      setLoaded(false); setLocalReady(false); setLocal([]); setCandidates([]); setSelection(''); setBusy(false); setError('');
      void refresh(version).catch(cause => { if (version === generation.current) { setError(errorText(cause)); } });
    }
    return () => { generation.current++; };
  }, [open, workspace, channel]);
  const choices = available.filter(agent => agent.enabled).map(agent => ({ ...agent, capabilities: { ...agent.capabilities, skills: agent.capabilities.skills.filter(skill => candidates.some(candidate => candidate.installation_id === agent.id && candidate.skill === skill)) } })).filter(agent => agent.capabilities.skills.length);
  async function enable(agent: LocalAgent, skill: string, enabled: boolean) {
    const version = generation.current;
    setBusy(true); setError('');
    try {
      await request(`/agents/connections/${agent.id}/channels/${channel}`, { enabled, skill });
      await refresh(version);
      if (!enabled && selection === `${agent.id}|${skill}`) setSelection('');
    } catch (cause) { if (version === generation.current) setError(errorText(cause)); }
    finally { if (version === generation.current) setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selection || !goal.trim() || !choices.some(agent=>agent.capabilities.skills.some(skill=>agent.id+'|'+skill===selection))) return;
    setBusy(true); setError('');
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
    {!localReady && !error && <LoadingStatus>Loading channel agents…</LoadingStatus>}
    {error && <p role="alert">{error}</p>}
    {local.filter(agent => agent.inherits_owner_access).map(agent => <p key={agent.id}><small>{agent.name} inherits your conversation access.</small></p>)}
    {local.filter(agent => !agent.inherits_owner_access).flatMap(agent => agent.skills.map(skill => {
      const enabled = agent.granted_skills.includes(skill), label = agent.skills.length === 1 ? agent.name : `${agent.name} · ${skill}`;
      return <div key={`${agent.id}|${skill}`}><small>{label} {enabled ? 'can receive approved tasks in this channel.' : 'is available. Enable it to receive approved tasks in this channel.'}</small><Button size="sm" variant="ghost" disabled={busy} aria-label={`${enabled ? 'Disable' : 'Enable'} ${label} in this channel`} onClick={() => void enable(agent, skill, !enabled)}>{enabled ? 'Disable in this channel' : 'Enable in this channel'}</Button></div>;
    }))}
    {(!loaded || choices.length > 0 || goal) ? <form onSubmit={submit}>
      <label>Agent and skill<Select aria-label="Agent and skill" required disabled={!choices.length || busy} value={selection} onChange={event => setSelection(event.target.value)}><option value="">{!loaded && !error ? 'Loading skills…' : 'Choose a skill'}</option>{choices.flatMap(agent => agent.capabilities.skills.map(skill => <option key={`${agent.id}|${skill}`} value={`${agent.id}|${skill}`}>{candidates.find(candidate => candidate.installation_id === agent.id)?.name ?? agent.connector_id} · {skill}</option>))}</Select></label>
      <label>What should the agent do?<textarea required maxLength={4000} value={goal} onChange={event => setGoal(event.target.value)} /></label><small>The agent owner must approve this task before it runs.</small>
      <Button size="sm" type="submit" disabled={!choices.length || !selection || !goal.trim()} loading={busy}>Request task</Button>
    </form> : loaded && localReady && !local.length && !error && <p>No agents are available in this channel.</p>}
  </Reveal></section>;
}
