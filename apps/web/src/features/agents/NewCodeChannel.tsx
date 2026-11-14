import { SessionProjectPicker, type SessionProject } from './SessionProjectPicker.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Dialog, LoadingStatus, Select } from '@space/ui/primitives';
import type { AgentSessionReference, AgentSessionSummary, ChannelSummary, MessagePage, NavigatorCandidate, Page } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { errorText } from '../../shared/api/error-text.js';
import { useDestinationPresence } from '../../shared/ui/useDestinationPresence.js';

type Props = {workspace:string; viewer:string; onClose:()=>void; onCreated:(session:AgentSessionReference)=>void};
type Source = {id:string; text:string};

export function NewCodeChannel({workspace,viewer,onClose,onCreated}:Props) {
  const [query,setQuery] = useState(''), [channel,setChannel] = useState(''), [thread,setThread] = useState('');
  const [channels,setChannels] = useState<ChannelSummary[]>(), [channelError,setChannelError] = useState('');
  const [agents,setAgents] = useState<NavigatorCandidate[]>(), [agentError,setAgentError] = useState('');
  const [threads,setThreads] = useState<Source[]>(), [threadError,setThreadError] = useState('');
  const [agent,setAgent] = useState(''), [title,setTitle] = useState('');
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [channelRetry,retryChannels] = useState(0);
  const [agentRetry,retryAgents] = useState(0), [threadRetry,retryThreads] = useState(0);
  const [project,setProject] = useState<SessionProject>(), [choosing,setChoosing] = useState(false);
  const attempt = useRef<{body:string;session:string;thread:string} | undefined>(undefined);
  const submitting = useRef(false);
  const present = useDestinationPresence();

  useEffect(()=>{
    const controller = new AbortController();
    setChannelError(''); setChannels(undefined);
    const timer = setTimeout(async()=>{
      const params = new URLSearchParams({directory:'1',membership:'joined',sort:'name',limit:'50',q:query.trim()});
      try {
        const page = await request<Page<ChannelSummary>>(`/workspaces/${workspace}/channels?${params}`,undefined,undefined,'POST',controller.signal,viewer);
        if (!controller.signal.aborted) setChannels(page.items.filter(item=>item.joined&&!item.archived_at));
      } catch (cause) { if (!controller.signal.aborted) setChannelError(errorText(cause)); }
    },query ? 180 : 0);
    return ()=>{controller.abort();clearTimeout(timer);};
  },[workspace,viewer,query,channelRetry]);

  useEffect(()=>{
    if (!channel) return;
    const controller = new AbortController(), {signal} = controller;
    setAgentError('');
    void request<{candidates:NavigatorCandidate[]}>(`/channels/${channel}/navigator`,undefined,undefined,'POST',signal,viewer).then(catalog=>{
      if (signal.aborted) return;
      const eligible = catalog.candidates.filter(item=>item.persistent_sessions);
      setAgents(eligible);
      const keys = eligible.map(item=>item.installation_id+'|'+item.skill);
      setAgent(current=>keys.includes(current) ? current : keys[0] ?? '');
    }).catch(cause=>{if (!signal.aborted) { setAgents(undefined); setAgentError(errorText(cause)); }});
    return ()=>controller.abort();
  },[channel,viewer,agentRetry]);

  useEffect(()=>{
    if (!channel) return;
    const controller = new AbortController(), {signal} = controller;
    setThreadError('');
    void request<MessagePage>(`/channels/${channel}/messages?limit=50`,undefined,undefined,'POST',signal,viewer).then(page=>{
      if (signal.aborted) return;
      setThreads(page.messages.filter(item=>!item.deleted_at && !item.channel_broadcast_sequence && item.text.trim())
        .reverse().map(item=>({id:item.thread_id,text:item.text.trim().slice(0,100)})));
    }).catch(cause=>{if (!signal.aborted) { setThreads(undefined); setThread(''); setThreadError(errorText(cause)); }});
    return ()=>controller.abort();
  },[channel,viewer,threadRetry]);

  function selectChannel(value:string) { setProject(undefined); setChannel(value); setThread(''); setAgent(''); setThreads(undefined); setAgents(undefined); setThreadError(''); setAgentError(''); setError(''); }
  const candidate = agents?.find(item=>item.installation_id+'|'+item.skill===agent);
  const selected = candidate && project?.installation === candidate.installation_id ? project : undefined;
  async function create(event:FormEvent) {
    event.preventDefault();
    if (!candidate || !title.trim() || choosing || submitting.current) return;
    const fields = {...(selected && {project_token:selected.project_token}),installation_id:candidate.installation_id,skill:candidate.skill,title:title.trim()};
    const body = JSON.stringify({channel,thread,...fields});
    if (attempt.current?.body!==body) attempt.current = {body,session:selected?.session ?? crypto.randomUUID(),thread:crypto.randomUUID()};
    const ids = attempt.current;
    submitting.current = true; setBusy(true); setError('');
    try {
      const session = await request<AgentSessionSummary>(thread ? `/threads/${thread}/agent-sessions` : `/channels/${channel}/agent-sessions`,
        {...fields,client_session_id:ids.session,...(thread ? {} : {client_thread_id:ids.thread})},undefined,'POST',undefined,viewer);
      if (present.current) onCreated({...session,channel_id:channel,channel_archived:false});
    } catch (cause) { if (present.current) setError(errorText(cause)); }
    finally { submitting.current=false; if (present.current) setBusy(false); }
  }
  return <Dialog open title="New agent session" description="Choose where to work and which agent to work with." onClose={onClose} onBeforeClose={()=>!submitting.current}>
    <form className="code-channel-create" onSubmit={create}>
      <label>Session name<input required autoFocus maxLength={160} value={title} disabled={busy} placeholder="e.g. Fix checkout" onChange={e=>setTitle(e.target.value)}/></label>
      <label>Find a source channel<input type="search" value={query} maxLength={100} disabled={busy} placeholder="Search your channels" onChange={e=>{setQuery(e.target.value);selectChannel('');}}/></label>
      <label><span className="session-field-heading">Source channel{!channels && !channelError && <LoadingStatus>Loading channels…</LoadingStatus>}</span><Select aria-label="Source channel" required value={channel} disabled={busy||!channels} onChange={e=>selectChannel(e.target.value)}>
        <option value="">Choose a channel</option>{channels?.map(item=><option key={item.id} value={item.id}>#{item.name}</option>)}
      </Select></label>
      {channelError && <p role="alert">{channelError} <Button size="sm" onClick={()=>retryChannels(n=>n+1)}>Retry channels</Button></p>}
      {channel && <>
        <label><span className="session-field-heading">Source conversation{!threads && !threadError && <LoadingStatus>Loading conversations…</LoadingStatus>}</span><Select aria-label="Source conversation" value={thread} onChange={e=>setThread(e.target.value)} disabled={busy}>
          <option value="">Start fresh in this channel</option>{threads?.map(item=><option value={item.id} key={item.id}>{item.text}</option>)}
        </Select></label>
        {threadError && <p role="alert">{threadError} <Button size="sm" onClick={()=>retryThreads(n=>n+1)}>Retry conversations</Button></p>}
        <label><span className="session-field-heading">Agent{!agents && !agentError && <LoadingStatus>Loading agents…</LoadingStatus>}</span><Select aria-label="Agent" value={agent} onChange={e=>{setProject(undefined);setAgent(e.target.value);}} disabled={busy||!agents?.length}>
          {!agents?.length && <option value="">{agents ? 'No eligible agents in this channel' : agentError ? 'Agents unavailable' : 'Choose an agent'}</option>}
          {agents?.map(item=>{const key=item.installation_id+'|'+item.skill;return <option value={key} key={key}>{item.name} · {item.skill}</option>;})}
        </Select></label>
        {agentError && <p role="alert">{agentError} <Button size="sm" onClick={()=>retryAgents(n=>n+1)}>Retry agents</Button></p>}
        {(candidate?.project_picker || selected) && candidate && <SessionProjectPicker key={candidate.installation_id} installation={candidate.installation_id}
          viewer={viewer} project={selected} disabled={busy} onChange={setProject} onBusy={setChoosing}/>}
      </>}
      {error && <p role="alert">{error}</p>}
      <footer><Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" loading={busy} disabled={!title.trim() || !candidate || busy || choosing || !!channelError}>Create agent session</Button></footer>
    </form>
  </Dialog>;
}
