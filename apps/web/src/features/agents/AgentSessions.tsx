import { SidekickContextCard } from './SidekickContextCard.js';
import {useDestinationPresence} from '../../shared/ui/useDestinationPresence.js';
import {ConversationHeader,ConversationComposer,ConversationMessage,ConversationReplyDivider} from '../chat/ThreadConversation.js';
import {MessageTimeline} from '../chat/MessageTimeline.js';
import {useCallback,useEffect,useId,useMemo,useRef,useState,type FormEvent} from 'react';
import type {ChannelAgent,AgentSessionDetail,AgentSessionSummary,AgentSessionTurn,AgentSessionOutputs,NavigatorCandidate,RichDocument,Task,ChatEvent,ChatMessage} from '@space/contracts';
import { Select, Button, IconButton, SidePanel, Tabs } from '@space/ui/primitives';
import {AnimatePresence} from 'motion/react';
import {SidebarSimple,Plus,Robot,Stop,X} from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { type MessageAttempt } from '../composer/message-sender.js';
import {subscribeUpdates} from '../../shared/realtime/live-updates.js';
import {TaskPreview,TaskFiles,TaskChanges} from './AgentTaskWorkspace.js';
import {useMentionSearch} from '../mentions/Mentions.js';
import {AgentActivityIndicator} from './AgentActivityIndicator.js';
import './agent-sessions.css';

const denied=(error:unknown)=>error instanceof Error&&['unauthorized','forbidden','not_found'].includes(error.message);
const errorText=(error:unknown)=>error instanceof Error?error.message.replaceAll('_',' '):'Unable to update the session';
const busy=(task?:Task)=>!!task&&['awaiting_approval','queued','running'].includes(task.status);
const status=(task?:Task)=>!task?'Ready':({awaiting_approval:'Waiting for approval',queued:'Queued',running:'Working',completed:'Ready',failed:'Turn failed',rejected:'Request declined'}[task.status]);

export function AgentSessions({drafts:externalDrafts,onDraftChange:externalDraftChange,attempt:externalAttempt,acknowledged:externalAcknowledged,onAccepted,thread,channel,viewerId,onAccessLost,initialSessionId,onOpenSession,archived=false,channelName,onBack,onClose}: {
 acknowledged?:Record<string,RichDocument>;onAccepted?:(key:string,document:RichDocument)=>void;
 drafts?:Record<string,RichDocument>;onDraftChange?:(key:string,document:RichDocument)=>void;attempt?:(key:string)=>MessageAttempt;
 thread:string;channel:string;viewerId:string;onAccessLost:()=>void;initialSessionId?:string;onOpenSession?:(id:string)=>void;archived?:boolean;channelName?:string;onBack?:()=>void;onClose?:()=>void;
}) {
 const present=useDestinationPresence();
 const [sessions,setSessions]=useState<AgentSessionSummary[]>([]);
 const picker=!!onOpenSession,selected=initialSessionId;
 const [creating,setCreating]=useState(false),[title,setTitle]=useState(''),[agent,setAgent]=useState('');
 const [catalog,setCatalog]=useState<NavigatorCandidate[]>([]),[local,setLocal]=useState<ChannelAgent[]>([]);
 const [error,setError]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[revision,setRevision]=useState(0),[revoked,setRevoked]=useState(false);
 const drafts=useRef<Record<string,RichDocument>>({}),attempts=useRef(new Map<string,MessageAttempt>());
 const [acknowledged,setAcknowledged]=useState<Record<string,RichDocument>>({});
 const creation=useRef<{body:string;id:string}|undefined>(undefined);
 const lost=useRef(onAccessLost);lost.current=onAccessLost;
 const revokedRef=useRef(false);
 const draftKey=(id:string)=>`session:${channel}:${id}`;
 const getDraft=(id:string)=>externalDrafts?.[draftKey(id)]??drafts.current[id];
 const saveDraft=(id:string,document:RichDocument)=>{drafts.current[id]=document;if(externalDrafts)externalDrafts[draftKey(id)]=document;externalDraftChange?.(draftKey(id),document);};
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const revoke=useCallback(()=>{if(!alive.current)return;revokedRef.current=true;setRevoked(true);setSessions([]);drafts.current={};attempts.current.clear();setAcknowledged({});lost.current();},[]);
 useEffect(()=>{
  let active=true;
  const read=async()=>{
   try{
    const [list,available,owned]=await Promise.all([
     picker?request<{items:AgentSessionSummary[]}>(`/threads/${thread}/agent-sessions`):request<AgentSessionDetail>(`/agent-sessions/${selected}`).then(detail=>({items:[detail.session]})),
     picker?request<{candidates:NavigatorCandidate[]}>(`/channels/${channel}/navigator`):Promise.resolve({candidates:[]}),
     picker?request<typeof local>(`/channels/${channel}/agents`):Promise.resolve([]),
    ]);
    if(!active)return;
    if(!Array.isArray(list.items)||!Array.isArray(available.candidates)||!Array.isArray(owned))throw new Error('Could not load agent sessions');
    setSessions(list.items);const choices=available.candidates.filter(item=>item.persistent_sessions === true);setCatalog(choices);setLocal(owned);setAgent(current=>choices.some(item=>`${item.installation_id}|${item.skill}`===current)?current:choices[0]?`${choices[0].installation_id}|${choices[0].skill}`:'');
    setError('');setRevision(value=>value+1);
   }catch(reason){if(active){if(denied(reason))revoke();else setError(errorText(reason));}}
   finally{if(active)setLoading(false);}
  };
  const stop=subscribeUpdates('thread',thread,read,revoke);
  return()=>{active=false;stop();};
 },[thread,channel,revoke,picker,selected]);
 const refresh=()=>setRevision(value=>value+1);
 async function enable(id:string,skill:string){
  setSaving(true);setError('');
  try{await request(`/agents/connections/${id}/channels/${channel}`,{enabled:true,skill});const available=await request<{candidates:NavigatorCandidate[]}>(`/channels/${channel}/navigator`);if(alive.current){setCatalog(available.candidates.filter(item=>item.persistent_sessions === true));const chosen=available.candidates.find(item=>item.installation_id===id&&item.skill===skill&&item.persistent_sessions);setAgent(chosen?`${chosen.installation_id}|${chosen.skill}`:'');setLocal(items=>items.map(item=>item.id===id?{...item,enabled_in_channel:true,granted_skills:[...new Set([...item.granted_skills,skill])]}:item));}}
  catch(reason){if(denied(reason))revoke();else setError(errorText(reason));}
  finally{if(alive.current)setSaving(false);}
 }
 async function create(event:FormEvent){
  event.preventDefault();setSaving(true);setError('');
  const [installation_id,skill]=agent.split('|');
  const body=JSON.stringify({title:title.trim(),installation_id,skill});
  if(creation.current?.body!==body)creation.current={body,id:crypto.randomUUID()};
  try{const session=await request<AgentSessionSummary>(`/threads/${thread}/agent-sessions`,{...JSON.parse(body),client_session_id:creation.current.id});
   if(!alive.current||!present.current)return;setSessions(items=>[session,...items.filter(item=>item.id!==session.id)]);setCreating(false);setTitle('');creation.current=undefined;onOpenSession?.(session.id);
  }catch(reason){if(denied(reason))revoke();else setError(errorText(reason));}
  finally{if(alive.current)setSaving(false);}
 }
 async function send(id:string,text:string,document:RichDocument){
  const body=JSON.stringify({text,document});
  let state=externalAttempt?.(draftKey(id))??attempts.current.get(id);
  if(!state){state={};attempts.current.set(id,state);}
  if(state.current?.content!==body)state.current={content:body,id:crypto.randomUUID()};
  const attempt=state.current;
  let accepted:Task;
  try { accepted=await request<Task>(`/agent-sessions/${id}/messages`,{text,document},attempt.id); }
  catch(reason) { if(denied(reason))revoke(); throw reason; }
  if(state.current===attempt)state.current=undefined;
  if(!revokedRef.current&&JSON.stringify(getDraft(id))===JSON.stringify(document))saveDraft(id,{ops:[]});
  if(!revokedRef.current)onAccepted?.(draftKey(id),document);
  if(!alive.current)return accepted;
  setAcknowledged(previous=>({...previous,[id]:document}));refresh();return accepted;
 }
 if(revoked)return <p role="alert">This conversation is no longer available.</p>;
 const current=sessions.find(item=>item.id===selected);
 return <div className={`agent-sessions${picker?' agent-sessions-picker':''}`}>
  {picker&&<div className="agent-sessions-bar"><strong><Robot size={17}/>Agent sessions</strong><Button size="sm" disabled={archived} onClick={()=>setCreating(true)}><Plus size={15}/>New agent session</Button></div>}
  {!picker&&!current&&<ConversationHeader title="Agent session" channel={channelName} icon={<Robot size={20}/>} onBack={onBack} onClose={onClose}/>}
  {error&&<p role="alert" className="agent-sessions-error">{error}</p>}
  {loading&&<p role="status" className="agent-sessions-empty">Loading sessions…</p>}
  {picker&&<nav aria-label="Sessions in this thread" className="agent-sessions-list">{sessions.map(session=><button key={session.id} type="button" aria-label={session.title} onClick={()=>onOpenSession?.(session.id)}><span>{session.title}</span><small>{session.agent_name} · {session.state==='ended'?'Ended':`${session.turn_count} ${session.turn_count===1?'turn':'turns'}`}</small></button>)}</nav>}
  {picker&&creating&&<form className="agent-session-create" onSubmit={create}><h3>New agent session</h3><label>Session name<input required maxLength={120} value={title} onChange={event=>setTitle(event.target.value)} placeholder="What are we working on?"/></label><label>Agent<Select aria-label="Agent" value={agent} onChange={event=>setAgent(event.target.value)}>{catalog.map(item=><option key={`${item.installation_id}|${item.skill}`} value={`${item.installation_id}|${item.skill}`}>{item.name} · {item.skill}</option>)}</Select></label>{!catalog.length&&<p>No session-capable agent is available in this conversation.</p>}{local.filter(item=>item.persistent_sessions&&!item.inherits_owner_access).flatMap(item=>item.skills.filter(skill=>!item.granted_skills.includes(skill)).map(skill=><Button key={`${item.id}|${skill}`} size="sm" disabled={saving} onClick={()=>void enable(item.id,skill)}>Enable {item.name}{item.skills.length>1?` · ${skill}`:''} in this channel</Button>))}<div><Button type="submit" disabled={saving||!title.trim()||!agent}>Start session</Button><Button variant="ghost" onClick={()=>setCreating(false)}>Cancel</Button></div></form>}
  {!picker&&current&&<SessionConversation key={current.id} session={current} channel={channel} channelName={channelName} onBack={onBack} onClose={onClose} viewerId={viewerId} revision={revision} draft={getDraft(current.id)} acknowledged={externalAcknowledged?.[draftKey(current.id)]??acknowledged[current.id]} onDraftChange={document=>saveDraft(current.id,document)} onSend={(text,document)=>send(current.id,text,document)} onAccessLost={revoke} archived={archived}/>}
  {picker&&!loading&&!creating&&!sessions.length&&<p className="agent-sessions-empty">No agent sessions yet.</p>}
  {!picker&&!loading&&!current&&<p role="alert" className="agent-sessions-empty">This session is unavailable.</p>}
 </div>;
}
function SessionConversation({session,channel,channelName,onBack,onClose,viewerId,revision,draft,acknowledged,onDraftChange,onSend,onAccessLost,archived}: {
 session:AgentSessionSummary;channel:string;channelName?:string;onBack?:()=>void;onClose?:()=>void;viewerId:string;revision:number;draft?:RichDocument;acknowledged?:RichDocument;onDraftChange:(document:RichDocument)=>void;onSend:(text:string,document:RichDocument)=>Promise<Task>;onAccessLost:()=>void;archived:boolean;
}) {
 const searchMentions=useMentionSearch(channel);
 const findReferences=useCallback(async(query:string)=>{const result=await searchMentions(query);return {...result,items:result.items.filter(item=>item.kind!=='broadcast').map(item=>({...item,detail:`${item.detail||'Member'} · Reference only`}))};},[searchMentions]);
 const [submittedTask,setSubmittedTask]=useState<string>();
 const [latestVersion,setLatestVersion]=useState(0),[loadingOlder,setLoadingOlder]=useState(false);
 const [data,setData]=useState<AgentSessionDetail>(),[error,setError]=useState(''),[tab,setTab]=useState('preview'),[detailsOpen,setDetailsOpen]=useState(false),[pending,setPending]=useState(false),[retry,setRetry]=useState(0);
 const alive=useRef(true),pinned=useRef(true);
 const detailsId=useId(),detailsTrigger=useRef<HTMLSpanElement>(null),detailsClose=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(detailsOpen)detailsClose.current?.focus();},[detailsOpen]);
 const closeDetails=()=>{setDetailsOpen(false);detailsTrigger.current?.querySelector('button')?.focus();};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const lost=useRef(onAccessLost);lost.current=onAccessLost;
 useEffect(()=>{let active=true;void request<AgentSessionDetail>(`/agent-sessions/${session.id}`).then(result=>{
  if(!active)return;if(result.session.id!==session.id||!Array.isArray(result.turns))throw new Error('Could not load this session');
  setData(previous=>({...result,turns:previous?mergeTurns(previous.turns,result.turns):result.turns,next_cursor:previous?.turns.length&&previous.turns.length>result.turns.length?previous.next_cursor:result.next_cursor}));if(pinned.current)setLatestVersion(value=>value+1);setError('');
 }).catch(reason=>{if(active){if(denied(reason)){setData(undefined);lost.current();}else setError(errorText(reason));}});return()=>{active=false;};},[session.id,revision,retry]);
 const turns=data?.turns??[],latest=turns.at(-1)?.task,activeSession=data?.session??session;
 const sendDisabledReason=!data?'Loading session…':busy(latest)?`${status(latest)}. You can draft your next message while you wait.`:submittedTask&&!turns.some(turn=>turn.task.id===submittedTask)?'Updating session. You can draft your next message while you wait.':undefined;
 const outputs=useMemo(()=>{if(data?.outputs)return data.outputs;const files=new Map<string,AgentSessionOutputs['files'][number]>(),changes=new Map<string,AgentSessionOutputs['changes'][number]>();let preview:AgentSessionOutputs['preview'];for(const turn of turns){const output=turn.response?.outputs;if(output?.preview)preview=output.preview;for(const file of output?.files??[])files.set(file.path,file);for(const change of output?.changes??[])changes.set(change.path,change);}return{preview,files:[...files.values()],changes:[...changes.values()]};},[turns,data?.outputs]);
 async function action(path:string){setPending(true);setError('');try{await request(path,{});if(alive.current){setRetry(value=>value+1);}}catch(reason){if(denied(reason)){setData(undefined);lost.current();}else if(alive.current)setError(errorText(reason));}finally{if(alive.current)setPending(false);}}
 async function older(){if(!data?.next_cursor||loadingOlder)return;setLoadingOlder(true);try{const page=await request<AgentSessionDetail>(`/agent-sessions/${session.id}?before=${data.next_cursor}`);if(alive.current)setData(current=>current?{...current,turns:mergeTurns(page.turns,current.turns),next_cursor:page.next_cursor}:page);}catch(reason){if(denied(reason))lost.current();else if(alive.current)setError(errorText(reason));}finally{if(alive.current)setLoadingOlder(false);}}
 const manage=viewerId===activeSession.owner_id||viewerId===activeSession.created_by;
 const rows=turns.flatMap((turn,index)=>{
  const base={channel_id:channel,thread_id:session.origin_thread_id,task_id:turn.task.id,client_message_id:null,created_at:turn.created_at??session.created_at};
  return [
   {turn,request:true,message:{...base,id:`${turn.task.id}:request`,sequence:String(index*2+1),text:turn.task.goal,document:turn.task.request_document,author:{kind:'human' as const,id:turn.task.requester_id,name:turn.requester_name}}},
   {turn,request:false,message:{...base,id:`${turn.task.id}:response`,sequence:String(index*2+2),text:turn.task.result??(turn.detail==='session_stopped'?'This turn was stopped.':turn.detail||status(turn.task)),agent_response:turn.response,author:{kind:'agent' as const,id:session.installation_id,name:session.agent_name}}},
  ];
 });
 const events:ChatEvent[]=rows.map(row=>({type:'message.created',channel_id:channel,thread_id:session.origin_thread_id,sequence:row.message.sequence,occurred_at:row.message.created_at,payload:row.message as ChatMessage}));
 const sessionStatus=`${session.agent_name} ${activeSession.state==='ended'?'Ended':!data?'Loading…':turns.at(-1)?.detail==='session_stopped'?'Stopped':status(latest)}`;

 const footer=activeSession.state==='ended'?<p className="agent-session-notice">This session has ended. Its conversation and outputs are saved.</p>:!session.managed?<p className="agent-session-notice">Start a new session to continue this earlier run.</p>:!archived?<ConversationComposer typingIndicator={<AgentActivityIndicator name={session.agent_name} turn={turns.at(-1)}/>} channel="agent session" findMentions={findReferences} sendDisabledReason={sendDisabledReason} maxLength={4000} attachmentsEnabled={false} defaultValue={draft} acknowledgedDocument={acknowledged} onDraftChange={onDraftChange} onSend={async(text,document)=>{pinned.current=true;const task=await onSend(text,document);setSubmittedTask(task.id);}}/>:null;
 return <div className="agent-session" aria-label={`Agent session ${session.title}`}>
  <ConversationHeader title={data?.context?"My sidekick":"Agent session"} backLabel={data?.context?"Back to my sidekick":undefined} channel={channelName} icon={<Robot size={20}/>} status={sessionStatus} onBack={onBack} onClose={onClose} actions={<>{manage&&busy(latest)&&<Button size="sm" disabled={pending} onClick={()=>void action(`/agent-sessions/${session.id}/stop`)}><Stop size={14}/>Stop</Button>}<span ref={detailsTrigger}><IconButton label="Session details" aria-expanded={detailsOpen} aria-controls={detailsOpen?detailsId:undefined} onClick={()=>detailsOpen?closeDetails():setDetailsOpen(true)}><SidebarSimple size={20} weight={detailsOpen?'fill':'regular'}/></IconButton></span></>}/>
  {error&&<p role="alert" className="agent-sessions-error">{error} <Button size="sm" variant="ghost" onClick={()=>setRetry(value=>value+1)}>Retry</Button></p>}
  {data?.context&&<SidekickContextCard context={data.context}/>}
  <div className="agent-session-body"><div className="agent-session-conversation"><MessageTimeline label="Session conversation" role="log" items={events} page={data?{has_older:!!data.next_cursor,has_newer:false}:null} loading={!data?'latest':loadingOlder?'older':null} latestVersion={latestVersion} load={()=>older()} pinned={pinned} busy={!data} footer={footer} render={(_event,index)=>{
   const row=rows[index]!,turn=row.turn;
   return <><ConversationMessage message={row.message as ChatMessage} viewerId={viewerId} streaming={!row.request&&busy(turn.task)} actions={{copyMessage:()=>navigator.clipboard.writeText(row.message.text)}} body={!row.request&&turn.task.status==='awaiting_approval'?<div className="agent-session-approval"><p>Waiting for {session.agent_name}’s owner to approve this request.</p>{viewerId===session.owner_id&&<><Button size="sm" disabled={pending} onClick={()=>void action(`/tasks/${turn.task.id}/approve`)}>Approve request</Button><Button size="sm" variant="ghost" disabled={pending} onClick={()=>void action(`/tasks/${turn.task.id}/reject`)}>Decline</Button></>}</div>:undefined}>{!row.request&&turn.task.status==='failed'&&<p role="status">This turn stopped. You can send another message or start a new session.</p>}</ConversationMessage>{index===0&&<ConversationReplyDivider count={Math.max(0,rows.length-1)}/>}</>;
  }}>
   {!data&&!error&&<p role="status">Loading session…</p>}
   {data&&!turns.length&&<div className="agent-sessions-empty"><h3>Ready when you are</h3><p>Send a message to start working with {session.agent_name}.</p></div>}
  </MessageTimeline>
  </div><AnimatePresence>{detailsOpen&&<SidePanel key="details" role="region" className="agent-session-details" aria-label="Session details">
   <div id={detailsId} className="agent-session-details-inner" onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!(event.target as Element).closest('dialog')){event.preventDefault();event.stopPropagation();closeDetails();}}}>
    <header className="agent-session-details-header"><h3>Session details</h3><button ref={detailsClose} type="button" className="agent-workspace-close" aria-label="Close session details" onClick={closeDetails}><X size={20}/></button></header>
    <Tabs label="Session outputs" value={tab} onChange={setTab} items={[{id:'preview',label:'Preview'},{id:'files',label:`Files ${outputs.files.length}`},{id:'changes',label:`Changes ${outputs.changes.length}`}].map(item=>({...item,panelId:`${detailsId}-${item.id}`}))}/>
    <div className="agent-session-output" role="tabpanel" id={`${detailsId}-${tab}`} aria-label={tab==='preview'?'Preview':tab==='files'?'Files':'Changes'} tabIndex={0}>{tab==='preview'?<TaskPreview preview={outputs.preview}/>:tab==='files'?<TaskFiles files={outputs.files}/>:<TaskChanges changes={outputs.changes}/>}</div>
   </div>
  </SidePanel>}</AnimatePresence></div>
 </div>;
}
function mergeTurns(previous:AgentSessionTurn[],incoming:AgentSessionTurn[]){const items=new Map(previous.map(turn=>[turn.task.id,turn]));for(const turn of incoming)items.set(turn.task.id,turn);return [...items.values()];}
