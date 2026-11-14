import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Dialog, Select } from '@space/ui/primitives';
import type { AgentSessionReference, AgentSessionSummary, ChannelSummary, MessagePage, NavigatorCandidate, Page } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { errorText } from '../../shared/api/error-text.js';
import { useDestinationPresence } from '../../shared/ui/useDestinationPresence.js';

type Props = {workspace:string; viewer:string; onClose:()=>void; onCreated:(session:AgentSessionReference)=>void};
type Source = {id:string; text:string};

export function NewCodeChannel({workspace,viewer,onClose,onCreated}:Props) {
  const [query,setQuery] = useState(''), [channel,setChannel] = useState(''), [thread,setThread] = useState('');
  const [channels,setChannels] = useState<ChannelSummary[]>([]), [channelError,setChannelError] = useState('');
  const [source,setSource] = useState<{channel:string;agents:NavigatorCandidate[];threads:Source[];error:string}>();
  const [agent,setAgent] = useState(''), [title,setTitle] = useState('');
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [retry,setRetry] = useState(0);
  const attempt = useRef<{body:string;session:string;thread:string} | undefined>(undefined);
  const submitting = useRef(false);
  const present = useDestinationPresence();

  useEffect(()=>{
    const controller = new AbortController();
    setChannelError(''); setChannels([]);
    const timer = setTimeout(async()=>{
      const params = new URLSearchParams({directory:'1',membership:'joined',sort:'name',limit:'50',q:query.trim()});
      try {
        const page = await request<Page<ChannelSummary>>(`/workspaces/${workspace}/channels?${params}`,undefined,undefined,'POST',controller.signal,viewer);
        if (!controller.signal.aborted) setChannels(page.items.filter(item=>item.joined&&!item.archived_at));
      } catch (cause) { if (!controller.signal.aborted) setChannelError(errorText(cause)); }
    },query ? 180 : 0);
    return ()=>{controller.abort();clearTimeout(timer);};
  },[workspace,viewer,query,retry]);

  useEffect(()=>{
    if (!channel) return;
    const controller = new AbortController(), {signal} = controller;
    void Promise.all([
      request<{candidates:NavigatorCandidate[]}>(`/channels/${channel}/navigator`,undefined,undefined,'POST',signal,viewer),
      request<MessagePage>(`/channels/${channel}/messages?limit=50`,undefined,undefined,'POST',signal,viewer),
    ]).then(([catalog,page])=>{
      if (signal.aborted) return;
      const agents = catalog.candidates.filter(item=>item.persistent_sessions);
      const threads = page.messages.filter(item=>!item.deleted_at && !item.channel_broadcast_sequence && item.text.trim())
        .reverse().map(item=>({id:item.thread_id,text:item.text.trim().slice(0,100)}));
      setSource({channel,agents,threads,error:''});
      const first = agents[0]; setAgent(first ? first.installation_id+'|'+first.skill : '');
    }).catch(cause=>{if (!signal.aborted) setSource({channel,agents:[],threads:[],error:errorText(cause)});});
    return ()=>controller.abort();
  },[channel,viewer,retry]);

  function selectChannel(value:string) { setChannel(value); setThread(''); setAgent(''); setSource(undefined); setError(''); }
  const current = channel && source?.channel===channel ? source : undefined;
  const candidate = current?.agents.find(item=>item.installation_id+'|'+item.skill===agent);
  async function create(event:FormEvent) {
    event.preventDefault();
    if (!candidate || !title.trim() || submitting.current) return;
    const fields = {installation_id:candidate.installation_id,skill:candidate.skill,title:title.trim()};
    const body = JSON.stringify({channel,thread,...fields});
    if (attempt.current?.body!==body) attempt.current = {body,session:crypto.randomUUID(),thread:crypto.randomUUID()};
    const ids = attempt.current;
    submitting.current = true; setBusy(true); setError('');
    try {
      const session = await request<AgentSessionSummary>(thread ? `/threads/${thread}/agent-sessions` : `/channels/${channel}/agent-sessions`,
        {...fields,client_session_id:ids.session,...(thread ? {} : {client_thread_id:ids.thread})},undefined,'POST',undefined,viewer);
      if (present.current) onCreated({...session,channel_id:channel,channel_archived:false});
    } catch (cause) { if (present.current) setError(errorText(cause)); }
    finally { submitting.current=false; if (present.current) setBusy(false); }
  }
  return <Dialog open title="New code channel" description="Choose where to work and which agent to work with." onClose={onClose} onBeforeClose={()=>!submitting.current}>
    <form className="code-channel-create" onSubmit={create}>
      <label>Channel name<input required autoFocus maxLength={160} value={title} disabled={busy} placeholder="e.g. Fix checkout" onChange={e=>setTitle(e.target.value)}/></label>
      <label>Find a source channel<input type="search" value={query} maxLength={100} disabled={busy} placeholder="Search your channels" onChange={e=>{setQuery(e.target.value);selectChannel('');}}/></label>
      <label>Source channel<Select aria-label="Source channel" required value={channel} disabled={busy} onChange={e=>selectChannel(e.target.value)}>
        <option value="">Choose a channel</option>{channels.map(item=><option key={item.id} value={item.id}>#{item.name}</option>)}
      </Select></label>
      {current && !current.error && <>
        <label>Source conversation<Select aria-label="Source conversation" value={thread} onChange={e=>setThread(e.target.value)} disabled={busy}>
          <option value="">Start fresh in this channel</option>{current.threads.map(item=><option value={item.id} key={item.id}>{item.text}</option>)}
        </Select></label>
        <label>Agent<Select aria-label="Agent" value={agent} onChange={e=>setAgent(e.target.value)} disabled={busy||!current.agents.length}>
          {!current.agents.length && <option value="">No eligible agents in this channel</option>}
          {current.agents.map(item=>{const key=item.installation_id+'|'+item.skill;return <option value={key} key={key}>{item.name} · {item.skill}</option>;})}
        </Select></label>
      </>}
      {channel && !current && <p role="status">Loading agents and conversations…</p>}
      {(channelError || current?.error) && <p role="alert">{channelError || current?.error} <Button size="sm" type="button" onClick={()=>setRetry(n=>n+1)}>Retry</Button></p>}
      {error && <p role="alert">{error}</p>}
      <footer><Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={!title.trim() || !candidate || busy || !!channelError}>Create code channel</Button></footer>
    </form>
  </Dialog>;
}
