import { conversationPath, sessionPath } from '@space/contracts';
import { usePublishedPath } from '../../shared/ui/conversation-location.js';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { SidekickAgent, SidekickSession, SidekickSource } from '@space/contracts';
import { Button, Select } from '@space/ui/primitives';
import { Robot } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { errorText } from '../../shared/api/error-text.js';
import { ConversationHeader } from '../chat/ThreadConversation.js';
import { AgentSessions } from './AgentSessions.js';
import './sidekick.css';

type DraftProps = Pick<ComponentProps<typeof AgentSessions>, 'uploads'|'drafts'|'onDraftChange'|'attempt'|'acknowledged'|'onAccepted'>;
type Page = { items: SidekickSession[]; next_cursor: string | null };
export function Sidekick({ workspace, viewerId, source, onClose, ...draftProps }: DraftProps & { workspace: string; viewerId: string; source?: SidekickSource; onClose: () => void }) {
  const [agents,setAgents]=useState<SidekickAgent[]>([]),[choice,setChoice]=useState('');
  const [page,setPage]=useState<Page>({items:[],next_cursor:null}),[selected,setSelected]=useState<SidekickSession>();
  usePublishedPath(selected ? sessionPath(selected.id) : source ? conversationPath(source.channel_id) : null);
  const [creating,setCreating]=useState(!!source),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const generation=useRef(0);
  const autoStarted=useRef(false);
  const alive=useRef(true),attempt=useRef<{fingerprint:string;id:string}|undefined>(undefined),drafts=useRef({});
  const sourceKey=JSON.stringify(source);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{generation.current++;setBusy(false);setCreating(!!source);setSelected(undefined);attempt.current=undefined;autoStarted.current=false;setError('');},[sourceKey]);
  useEffect(()=>{
    let active=true;setLoading(true);
    void Promise.all([request<SidekickAgent[]>(`/workspaces/${workspace}/sidekick-agents`),request<Page>(`/workspaces/${workspace}/sidekick-sessions`)]).then(([available,list])=>{
      if(!active)return;
      const owned=available.filter(agent=>agent.owner_id===viewerId&&agent.enabled&&agent.capabilities.persistent_sessions&&agent.capabilities.skills.length);
      setAgents(owned);setPage(list);setChoice(current=>owned.some(agent=>agent.capabilities.skills.some(skill=>`${agent.id}|${skill}`===current))?current:owned[0]?`${owned[0].id}|${owned[0].capabilities.skills[0]}`:'');setError('');
    }).catch(reason=>{if(active)setError(errorText(reason));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[workspace,viewerId,retry]);
  async function start() {
    if(busy||!source||!choice)return;
    const [installation_id,skill]=choice.split('|'),fingerprint=JSON.stringify({installation_id,skill,source});
    if(attempt.current?.fingerprint!==fingerprint)attempt.current={fingerprint,id:crypto.randomUUID()};
    const version=generation.current;
    setBusy(true);setError('');
    try {
      const session=await request<SidekickSession>(`/workspaces/${workspace}/sidekick-sessions`,{installation_id,skill,source,client_session_id:attempt.current.id});
      if(!alive.current||version!==generation.current)return;
      setPage(current=>({...current,items:[session,...current.items.filter(item=>item.id!==session.id)]}));setSelected(session);setCreating(false);
    } catch(reason) { if(alive.current&&version===generation.current)setError(reason instanceof Error&&reason.message==='sidekick_context_too_large'?'This conversation is too large to attach. Select fewer messages (up to 50).':errorText(reason)); }
    finally { if(alive.current&&version===generation.current)setBusy(false); }
  }
  useEffect(()=>{
    if(loading||busy||error||!creating||!source||!choice||autoStarted.current||agents.length!==1||agents[0]!.capabilities.skills.length!==1)return;
    autoStarted.current=true;
    void start();
  },[loading,busy,error,creating,sourceKey,choice,agents]);
  async function older() {
    if(!page.next_cursor||busy)return;setBusy(true);setError('');
    try {const next=await request<Page>(`/workspaces/${workspace}/sidekick-sessions?before=${page.next_cursor}`);if(alive.current)setPage(current=>({items:[...current.items,...next.items],next_cursor:next.next_cursor}));}
    catch(reason){if(alive.current)setError(errorText(reason));}finally{if(alive.current)setBusy(false);}
  }
  if(selected)return <div className="sidekick"><AgentSessions key={selected.id} drafts={drafts.current} {...draftProps} thread={selected.origin_thread_id} channel={selected.channel_id} viewerId={viewerId} initialSessionId={selected.id} onBack={()=>{setSelected(undefined);setRetry(value=>value+1);}} onClose={onClose} onAccessLost={()=>{const key=`session:${selected.channel_id}:${selected.id}`;if(draftProps.drafts)delete draftProps.drafts[key];draftProps.onDraftChange?.(key,{ops:[]});setSelected(undefined);setPage({items:[],next_cursor:null});setError('This private discussion is no longer available.');}}/></div>;
  return <div className="sidekick"><ConversationHeader title="My sidekick" icon={<Robot size={20}/>} onClose={onClose}/><div className="sidekick-content">
    <p>Discuss privately with your connected agent. Nothing is posted back to the original conversation.</p>
    {error&&<p role="alert">{error} <Button size="sm" onClick={()=>setRetry(value=>value+1)}>Reload</Button></p>}
    {loading?<p role="status">Loading your agents…</p>:creating&&source?<form onSubmit={event=>{event.preventDefault();void start();}}>
      <h3>Discuss with agent</h3><p>{source.thread_id?'The whole thread':`${source.message_ids?.length} selected ${source.message_ids?.length===1?'message':'messages'}`} will be attached as a saved copy. Later replies won’t be added automatically.</p>
      <label>Connected agent<Select aria-label="Connected agent" value={choice} disabled={busy} onChange={event=>setChoice(event.target.value)}>{agents.flatMap(agent=>agent.capabilities.skills.map(skill=><option key={`${agent.id}|${skill}`} value={`${agent.id}|${skill}`}>{agent.name}{agent.capabilities.skills.length>1?` · ${skill}`:''}</option>))}</Select></label>
      {!agents.length&&<p>Connect a session-capable agent in Apps &amp; agents to start a private discussion.</p>}
      <Button type="submit" disabled={busy||!choice}>{busy?'Opening discussion…':'Start private discussion'}</Button>
      <Button variant="ghost" disabled={busy} onClick={()=>setCreating(false)}>Cancel</Button>
    </form>:<p>Select messages or open a thread and choose “Discuss with agent” to start a new discussion.</p>}
    <h3>Your discussions</h3><nav aria-label="Private agent discussions">{page.items.map(session=><button type="button" key={session.id} onClick={()=>setSelected(session)}><strong>{session.title}</strong><small>{session.agent_name} · {session.state==='ended'?'Ended':`${session.turn_count} turns`}</small></button>)}</nav>
    {!loading&&!page.items.length&&<p>No private discussions yet.</p>}{page.next_cursor&&<Button disabled={busy} onClick={()=>void older()}>Load older discussions</Button>}
  </div></div>;
}
