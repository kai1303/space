import { SessionProjectPicker, type SessionProject } from './SessionProjectPicker.js';
import { codeArtifacts, CodeChannelArtifacts, CodeChannelContext } from './CodeChannelArtifacts.js';
import { SessionAgentHandoff } from './SessionAgentHandoff.js';
import { SessionTeam } from './SessionTeam.js';
import { SessionTitle } from '@space/ui/agents';
import { SessionQueue, SteeringReceipt, FollowUpMenu, useFollowUpPreference, type QueueAction } from './SessionQueue.js';
import type { Attachment } from '@space/ui/rich-text';
import type { UploadDrafts } from '../composer/useAttachmentUploads.js';
import { messageContent } from '../composer/message-sender.js';
import { RenameSessionDialog } from './RenameSessionDialog.js';
import { useMemberProfile } from '../profile/MemberProfile.js';
import {ToolApprovals} from './ToolApprovals.js';
import { ConversationHeading, ConversationDateDivider, useMessageArrivals } from '@space/ui/conversation';
import { ComposerSendError } from '@space/ui/composer';
import { SidekickContextSection } from './SidekickContextSection.js';
import {useDestinationPresence} from '../../shared/ui/useDestinationPresence.js';
import { AgentSessionComposer } from './AgentSessionComposer.js';
import {ConversationComposer,ConversationHeader,ConversationMessage,ConversationIntroduction} from '../chat/ThreadConversation.js';
import {MessageTimeline} from '../chat/MessageTimeline.js';
import {ConversationSkeleton} from '../chat/ConversationSkeleton.js';
import {useStarredChannels} from '../channels/useStarredChannels.js';
import {useAgentSessionHistory} from './useAgentSessionHistory.js';
import {useCallback,useEffect,useId,useMemo,useRef,useState,type FormEvent} from 'react';
import {conversationPath,isLocalAgentSkill} from '@space/contracts';
import type {AgentModel,GoalAction,CodexSettings,ChannelAgent,AgentSessionDetail,AgentSessionSummary,AgentSessionOutputs,NavigatorCandidate,RichDocument,Task,ChatEvent,ChatMessage,MentionReference,SessionInput} from '@space/contracts';
import { Select, Button, Tabs, Avatar, Dialog, Menu, IconButton } from '@space/ui/primitives';
import {Code,Stack,ArrowBendUpRight,ListBullets,Plus,Robot,Info,Stop,Paperclip,ChatCircle,Browser,GitDiff,DotsThree,Star,PencilSimple} from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { type MessageAttempt } from '../composer/message-sender.js';
import {subscribeUpdates} from '../../shared/realtime/live-updates.js';
import {ResultActions,TaskPreview,TaskFiles,TaskChanges} from './AgentTaskWorkspace.js';
import {useMentionSearch,MentionDetails} from '../mentions/Mentions.js';
import {AgentActivityIndicator} from './AgentActivityIndicator.js';
import './agent-sessions.css';

type DeliveryMode='messages'|'queue'|'steer';
const denied=(error:unknown)=>error instanceof Error&&['unauthorized','forbidden','not_found'].includes(error.message);
const errorText=(error:unknown)=>error instanceof Error?error.message.replaceAll('_',' '):'Unable to update the session';
const busy=(task?:Task)=>!!task&&['awaiting_approval','queued','running'].includes(task.status);

// Older browser messages stored the generated page header as a separate, unformatted operation.
function requestForDisplay(task:Task, browserSession:boolean) {
 const document=task.request_document;
 const header=document?.ops[0];
 if (browserSession && !task.browser_url && document && header && !header.attributes &&
     /^Browser page: https?:\/\/[^\s]+\n\n$/.test(header.insert) && task.goal.startsWith(header.insert)) {
  return {text:task.goal.slice(header.insert.length),document:{ops:document.ops.slice(1)}};
 }
 return {text:task.goal,document};
}

export function AgentSessions({primary,agentName,initialArtifact,artifactRequest,browserPage,uploads,drafts:externalDrafts,onDraftChange:externalDraftChange,attempt:externalAttempt,acknowledged:externalAcknowledged,onAccepted,thread,channel,viewerId,onAccessLost,initialSessionId,onOpenSession,archived=false,channelName,onBack,onClose}: {
 primary?:boolean;agentName?:string;artifactRequest?:number;initialArtifact?:NonNullable<import('@space/contracts').SessionReport['artifact']>;browserPage?:string;uploads?:UploadDrafts;acknowledged?:Record<string,RichDocument>;onAccepted?:(key:string,document:RichDocument,files:Attachment[])=>void;
 drafts?:Record<string,RichDocument>;onDraftChange?:(key:string,document:RichDocument)=>void;attempt?:(key:string)=>MessageAttempt;
 thread:string;channel:string;viewerId:string;onAccessLost:()=>void;initialSessionId?:string;onOpenSession?:(id:string)=>void;archived?:boolean;channelName?:string;onBack?:()=>void;onClose?:()=>void;
}) {
 const present=useDestinationPresence();
 const [sessions,setSessions]=useState<AgentSessionSummary[]>([]);
 const [detail,setDetail]=useState<AgentSessionDetail>();
 const picker=!!onOpenSession,selected=initialSessionId;
 const [creating,setCreating]=useState(false),[title,setTitle]=useState(''),[agent,setAgent]=useState('');
 const [catalog,setCatalog]=useState<NavigatorCandidate[]>([]),[local,setLocal]=useState<ChannelAgent[]>([]);
 const [error,setError]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[revision,setRevision]=useState(0),[revoked,setRevoked]=useState(false),[loadAttempt,setLoadAttempt]=useState(0);
 const drafts=useRef<Record<string,RichDocument>>({}),attempts=useRef(new Map<string,MessageAttempt>());
 const [acknowledged,setAcknowledged]=useState<Record<string,RichDocument>>({});
 const [project,setProject]=useState<SessionProject>(), [choosing,setChoosing]=useState(false);
 const candidate=catalog.find(item=>item.installation_id+'|'+item.skill===agent);
 const selectedProject=candidate && project?.installation===candidate.installation_id ? project : undefined;
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
     picker?request<{items:AgentSessionSummary[]}>(`/threads/${thread}/agent-sessions`):request<AgentSessionDetail>(`/agent-sessions/${selected}`).then(detail=>{if(detail.session.id!==selected||!Array.isArray(detail.turns))throw new Error('Could not load this session');if(active)setDetail(detail);return {items:[detail.session]};}),
     picker?request<{candidates:NavigatorCandidate[]}>(`/channels/${channel}/navigator`):Promise.resolve({candidates:[]}),
     picker?request<typeof local>(`/channels/${channel}/agents`):Promise.resolve([]),
    ]);
    if(!active)return;
    if(!Array.isArray(list.items)||!Array.isArray(available.candidates)||!Array.isArray(owned))throw new Error('Could not load agent sessions');
    setSessions(list.items);const choices=available.candidates.filter(item=>item.persistent_sessions === true);setCatalog(choices);setLocal(owned);setAgent(current=>choices.some(item=>`${item.installation_id}|${item.skill}`===current)?current:choices[0]?`${choices[0].installation_id}|${choices[0].skill}`:'');
    setError('');
   }catch(reason){if(active){if(denied(reason))revoke();else setError(errorText(reason));}}
   finally{if(active)setLoading(false);}
  };
  const stop=subscribeUpdates('thread',thread,read,revoke);
  return()=>{active=false;stop();};
 },[thread,channel,revoke,picker,selected,loadAttempt]);
 const refresh=()=>setRevision(value=>value+1);
 async function enable(id:string,skill:string){
  setSaving(true);setError('');
  try{await request(`/agents/connections/${id}/channels/${channel}`,{enabled:true,skill});const available=await request<{candidates:NavigatorCandidate[]}>(`/channels/${channel}/navigator`);if(alive.current){setCatalog(available.candidates.filter(item=>item.persistent_sessions === true));const chosen=available.candidates.find(item=>item.installation_id===id&&item.skill===skill&&item.persistent_sessions);setAgent(chosen?`${chosen.installation_id}|${chosen.skill}`:'');setLocal(items=>items.map(item=>item.id===id?{...item,enabled_in_channel:true,granted_skills:[...new Set([...item.granted_skills,skill])]}:item));}}
  catch(reason){if(denied(reason))revoke();else setError(errorText(reason));}
  finally{if(alive.current)setSaving(false);}
 }
 async function create(event:FormEvent){
  event.preventDefault();if(choosing || saving)return;setSaving(true);setError('');
  const [installation_id,skill]=agent.split('|');
  const body=JSON.stringify({title:title.trim(),installation_id,skill,...(selectedProject && {project_token:selectedProject.project_token})});
  if(creation.current?.body!==body)creation.current={body,id:selectedProject?.session ?? crypto.randomUUID()};
  try{const session=await request<AgentSessionSummary>(`/threads/${thread}/agent-sessions`,{...JSON.parse(body),client_session_id:creation.current.id});
   if(!alive.current||!present.current)return;setSessions(items=>[session,...items.filter(item=>item.id!==session.id)]);setCreating(false);setProject(undefined);setTitle('');creation.current=undefined;onOpenSession?.(session.id);
  }catch(reason){if(denied(reason))revoke();else setError(errorText(reason));}
  finally{if(alive.current)setSaving(false);}
 }
 async function send(id:string,text:string,document:RichDocument,files:Attachment[],mode:DeliveryMode,execution?:string,settings?:CodexSettings){
  const payload={
   ...messageContent(text,document,files),
   ...(browserPage ? {browser_url:browserPage} : {}),
   ...(mode==='steer' ? {execution_id:execution} : settings ? {codex_settings:settings} : {}),
  };
  const body=JSON.stringify([mode,payload]);
  let state=externalAttempt?.(draftKey(id))??attempts.current.get(id);
  if(!state){state={};attempts.current.set(id,state);}
  if(state.current?.content!==body)state.current={content:body,id:crypto.randomUUID()};
  const attempt=state.current;
  if(mode==='steer' && files.length) throw new ComposerSendError('Steering accepts text. Queue the message to include files.');
  let accepted:{id:string;state?:string};
  try { accepted=await request<{id:string;state?:string}>(`/agent-sessions/${id}/${mode}`,payload,attempt.id);
    if(mode==='steer' && accepted.state==='blocked') {state.current=undefined;throw new ComposerSendError('The turn is no longer accepting instructions. Your draft is saved.');}
  }
  catch(reason) { if(denied(reason))revoke(); if(reason instanceof Error && ['agent_busy','session_busy','agent_capacity','agent_unavailable','agent_start_failed'].includes(reason.message)){
    if(state.current===attempt)state.current=undefined;
    const messages:Record<string,string>={session_busy:'This session is already running. Your draft is saved.',agent_busy:'This session is already running. Your draft is saved.',agent_capacity:'The connector is at capacity. Send again when a session finishes.',agent_unavailable:'Your local connector is unavailable. Reconnect it and send again.',agent_start_failed:'Codex could not start this turn. Your draft is saved.'};
    throw new ComposerSendError(messages[reason.message]);
   } if(reason instanceof ComposerSendError) throw reason;
   throw new ComposerSendError(errorText(reason)); }
  if(state.current===attempt)state.current=undefined;
  if(!revokedRef.current&&JSON.stringify(getDraft(id))===JSON.stringify(document))saveDraft(id,{ops:[]});
  if(!revokedRef.current)onAccepted?.(draftKey(id),document,files);
  if(!alive.current)return accepted;
  setAcknowledged(previous=>({...previous,[id]:document}));refresh();return accepted;
 }
 if(revoked)return <p role="alert">This conversation is no longer available.</p>;
 const current=sessions.find(item=>item.id===selected);
 return <div className={`agent-sessions${picker?' agent-sessions-picker':''}`}>
  {picker&&<div className="agent-sessions-bar"><strong><Robot size={17}/>Agent Sessions</strong><Button size="sm" disabled={archived} onClick={()=>setCreating(true)}><Plus size={15}/>New agent session</Button></div>}
  {!picker&&!current&&<ConversationHeader primary={primary} title={agentName ?? "Agent session"} channel={channelName} icon={<Robot size={20}/>} onBack={onBack} onClose={onClose}/>}
  {error&&<p role="alert" className="agent-sessions-error">{error} <Button size="sm" disabled={loading} onClick={()=>{setError('');setLoading(true);setLoadAttempt(value=>value+1);}}>{picker?'Retry loading sessions':'Retry loading messages'}</Button></p>}
  {loading&&(picker?<p role="status" className="agent-sessions-empty">Loading sessions…</p>:!current&&<div className="chat-timeline-shell"><div className="chat-timeline chat-timeline--virtual" aria-busy="true"><p className="sp-sr-only" role="status" aria-label="Loading messages">Loading messages…</p><ConversationSkeleton/></div></div>)}
  {primary && selected && loading && !current && !archived && <ConversationComposer primary conversationKey={draftKey(selected)}
    channel="agent session" placeholder={`Message ${agentName ?? 'agent'}`} controls={{}} sendDisabled
    maxLength={4000} draftValue={getDraft(selected) ?? null} attachments={uploads?.drafts[draftKey(selected)] ?? []}
    onDraftChange={doc => saveDraft(selected, doc)} onSend={() => {}}/>}
  {picker&&<nav aria-label="Sessions in this thread" className="agent-sessions-list">{sessions.map(session=><button key={session.id} type="button" aria-label={session.title} onClick={()=>onOpenSession?.(session.id)}><span><SessionTitle title={session.title}/></span><small>{session.agent_name} · {session.state==='ended'?'Ended':`${session.turn_count} ${session.turn_count===1?'turn':'turns'}`}</small></button>)}</nav>}
  {picker&&creating&&<form className="agent-session-create" onSubmit={create}><h3>New agent session</h3><label>Session name<input required maxLength={120} value={title} onChange={event=>setTitle(event.target.value)} placeholder="What are we working on?"/></label><label>Agent<Select aria-label="Agent" value={agent} disabled={saving} onChange={event=>{setProject(undefined);setAgent(event.target.value);}}>{catalog.map(item=><option key={`${item.installation_id}|${item.skill}`} value={`${item.installation_id}|${item.skill}`}>{item.name} · {item.skill}</option>)}</Select></label>
   {candidate && (candidate.project_picker || selectedProject) && <SessionProjectPicker key={candidate.installation_id} installation={candidate.installation_id}
     viewer={viewerId} project={selectedProject} disabled={saving} onChange={setProject} onBusy={setChoosing}/>}
   {!catalog.length&&<p>No session-capable agent is available in this conversation.</p>}{local.filter(item=>item.persistent_sessions&&!item.inherits_owner_access).flatMap(item=>item.skills.filter(skill=>!item.granted_skills.includes(skill)).map(skill=><Button key={`${item.id}|${skill}`} size="sm" disabled={saving} onClick={()=>void enable(item.id,skill)}>Enable {item.name}{item.skills.length>1?` · ${skill}`:''} in this channel</Button>))}<div><Button type="submit" disabled={saving||choosing||!title.trim()||!agent}>Start session</Button><Button type="button" variant="ghost" disabled={saving} onClick={()=>{setProject(undefined);setCreating(false);}}>Cancel</Button></div></form>}
  {!picker&&current&&detail?.session.id===current.id&&<SessionConversation primary={primary} artifactRequest={artifactRequest} initialArtifact={initialArtifact} key={current.id} initial={detail} session={current} channel={channel} channelName={channelName} onBack={onBack} onClose={onClose} viewerId={viewerId} revision={revision} draft={getDraft(current.id)} acknowledged={externalAcknowledged?.[draftKey(current.id)]??acknowledged[current.id]} onDraftChange={document=>saveDraft(current.id,document)} uploads={uploads} onSend={(text,document,files,mode,execution,settings)=>send(current.id,text,document,files,mode,execution,settings)} onAccessLost={revoke} archived={archived}/>}
  {picker&&!loading&&!creating&&!sessions.length&&<p className="agent-sessions-empty">No agent sessions yet.</p>}
  {!picker&&!loading&&!current&&!error&&<p role="alert" className="agent-sessions-empty">This session is unavailable.</p>}
 </div>;
}
function SessionConversation({primary,initialArtifact,artifactRequest,uploads,initial,session,channel,channelName,onBack,onClose,viewerId,revision,draft,acknowledged,onDraftChange,onSend,onAccessLost,archived}: {
 primary?:boolean;artifactRequest?:number;initialArtifact?:NonNullable<import('@space/contracts').SessionReport['artifact']>;uploads?:UploadDrafts;initial:AgentSessionDetail;session:AgentSessionSummary;channel:string;channelName?:string;onBack?:()=>void;onClose?:()=>void;viewerId:string;revision:number;draft?:RichDocument;acknowledged?:RichDocument;onDraftChange:(document:RichDocument)=>void;onSend:(text:string,document:RichDocument,files:Attachment[],mode:DeliveryMode,execution?:string,settings?:CodexSettings)=>Promise<{id:string}>;onAccessLost:()=>void;archived:boolean;
}) {
 const starred=useStarredChannels(session.workspace_id,session.id,viewerId,'starred-sessions');
 const searchMentions=useMentionSearch(channel);
 const findReferences=useCallback(async(query:string)=>{const result=await searchMentions(query);return {...result,items:result.items.filter(item=>item.kind!=='broadcast').map(item=>({...item,detail:`${item.detail||'Member'} · Reference only`}))};},[searchMentions]);
 const [submittedTask,setSubmittedTask]=useState<string>();
 const [error,setError]=useState(''),[tab,setTab]=useState<string>('messages'),[pending,setPending]=useState(false);

 const [refreshing,setRefreshing]=useState(false),[detailsOpen,setDetailsOpen]=useState(false);
 const profiles = useMemberProfile();
 const [selectedMention,setSelectedMention]=useState<MentionReference>();
 const alive=useRef(true),pinned=useRef(true);
 const viewsId=useId();
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const lost=useRef(onAccessLost);lost.current=onAccessLost;
 const history=useAgentSessionHistory(initial,pinned,reason=>{if(denied(reason))lost.current();else setError(errorText(reason));});
 const {data,latestVersion,loading,load}=history;
 const refresh=async()=>{setError('');setRefreshing(true);try{await load('latest');}finally{if(alive.current)setRefreshing(false);}};
 const lastRevision=useRef(revision);
 useEffect(()=>{if(lastRevision.current!==revision){lastRevision.current=revision;void refresh();}},[revision]);
 const turns=data.turns,latestTurn=history.latest.turns.at(-1),latest=latestTurn?.task,activeSession=history.latest.session;
 const codeChannel=activeSession.managed && !history.latest.context;
 const [artifactOpen,setArtifactOpen]=useState(Boolean(initialArtifact));
 const [artifact,setArtifact]=useState<string>(initialArtifact ?? '');
 const artifactButton=useRef<HTMLButtonElement>(null);
 function closeArtifacts() { setArtifactOpen(false); artifactButton.current?.focus(); }
 function showArtifact(id:string) { setTab('messages'); setArtifact(id); setArtifactOpen(true); }
 const [ending,setEnding] = useState(false);
 const [models,setModels] = useState<AgentModel[]>([]);
 useEffect(()=>{
   if (!isLocalAgentSkill(activeSession.skill)) return;
   const controller = new AbortController();
   const refreshModels = async () => {
     try {
       const catalog = await request<AgentModel[]>(`/agent-sessions/${activeSession.id}/models`,undefined,undefined,undefined,controller.signal);
       if (!controller.signal.aborted) setModels(Array.isArray(catalog) ? catalog : []);
     } catch { if (!controller.signal.aborted) setModels([]); }
   };
   const unsubscribe = subscribeUpdates('workspace',activeSession.workspace_id,refreshModels,()=>{controller.abort();setModels([]);});
   return () => {controller.abort();unsubscribe();};
 },[activeSession.id,activeSession.skill,activeSession.workspace_id]);
 const [preference,setPreference]=useFollowUpPreference();
 const [draftExecution,setDraftExecution]=useState<string>();
 const inputs=history.latest.inputs??[];
 const queue=inputs.filter(input=>input.kind==='queue');
 const canSteer=latest?.status==='running' && !!latest.active_execution_id && viewerId===activeSession.owner_id && activeSession.supports_steering === true;
 const staleSteer = !!draftExecution && (!canSteer || draftExecution !== latest?.active_execution_id);
 const mode:DeliveryMode=canSteer ? preference : busy(latest)||queue.length ? 'queue' : 'messages';
 const sendDisabled=staleSteer || Boolean(submittedTask&&!history.latest.turns.some(turn=>turn.task.id===submittedTask));
 const outputs=useMemo<AgentSessionOutputs>(() => {
   if (history.latest.outputs) return history.latest.outputs;
   const files = new Map<string, AgentSessionOutputs['files'][number]>(), changes = new Map<string, AgentSessionOutputs['changes'][number]>();
   let preview: AgentSessionOutputs['preview'], actions: AgentSessionOutputs['actions'], context: AgentSessionOutputs['context'], views: AgentSessionOutputs['views'];
   for (const turn of turns) {
     const output = turn.response?.outputs;
     if (output?.preview) preview = output.preview;
     if (output?.actions) actions = output.actions;
     if (output?.views) views = output.views;
     if (output?.context) context = output.context;
     for (const file of output?.files ?? []) files.set(file.path, file);
     for (const change of output?.changes ?? []) changes.set(change.path, change);
   }
   return {preview, actions, views, context, files: [...files.values()], changes: [...changes.values()]};
 }, [turns, history.latest.outputs]);
 const artifacts=useMemo(()=>codeArtifacts(outputs),[outputs]);
 async function submitReview(text:string, key:string) {
   try {
     await request(`/agent-sessions/${session.id}/queue`, {text}, key, 'POST', undefined, viewerId);
     pinned.current=true; setTab('messages'); if(codeChannel) closeArtifacts(); await refresh();
   } catch (cause) {
     if (denied(cause)) lost.current();
     throw new Error(errorText(cause));
   }
 }
 const reviewAllowed = activeSession.managed && activeSession.state === 'active' && !archived;
 const [openedChanges, setOpenedChanges] = useState(initialArtifact === 'changes');
 useEffect(() => {
   if (!initialArtifact) return;
   if(codeChannel) {showArtifact(initialArtifact); return;}
   if (initialArtifact === 'changes') setOpenedChanges(true);
   setTab(initialArtifact);
 }, [initialArtifact,artifactRequest,codeChannel]);
 async function action(path:string,body:object={},method:'POST'|'PATCH'='POST',key?:string){setPending(true);setError('');try{await request(path,body,key,method);if(alive.current){await refresh();}return true;}catch(reason){if(denied(reason)){lost.current();}else if(alive.current)setError(errorText(reason));return false;}finally{if(alive.current)setPending(false);}}
 const [renaming,setRenaming]=useState(false);
 const manage=viewerId===activeSession.owner_id||viewerId===activeSession.created_by;
 const rows=turns.flatMap((turn,index)=>{
  const base={channel_id:channel,thread_id:session.origin_thread_id,task_id:turn.task.id,client_message_id:null,created_at:turn.created_at??session.created_at};
  const requestContent=requestForDisplay(turn.task,Boolean(data.context?.browser_url));
  const requestRow={turn,request:true,showMessage:true,notice:null,message:{...base,id:`${turn.task.id}:request`,sequence:String(index*2+1),...requestContent,attachments:turn.task.attachments,author:{kind:'human' as const,id:turn.task.requester_id,name:turn.requester_name}}};
  const {task,response}=turn;
  const hasContent=response?.messages.some(message=>message.text.trim())||response?.tools.length||response?.components.length;
  const notice=task.status==='rejected'?'Request declined':task.status==='failed'
   ?turn.detail==='session_stopped'?'Turn stopped':turn.detail==='local_execution_interrupted'?'Turn interrupted':'Turn failed'
   :null;
  const replyText=task.result??(notice?'':turn.detail);
  const pendingReply=task.status==='queued'||task.status==='running';
  // Older connectors can stream plain text without a structured response.
  const hasReply=hasContent||(!response||!pendingReply)&&replyText?.trim();
  if(!hasReply&&(pendingReply||task.status==='completed'))return [requestRow];
  return [
   requestRow,
   {turn,request:false,showMessage:!notice||Boolean(hasReply),notice,message:{...base,id:`${turn.task.id}:response`,sequence:String(index*2+2),text:replyText||'',agent_response:turn.response,author:{kind:'agent' as const,id:session.installation_id,name:session.agent_name}}},
  ];
 });
 const arrivals=useMessageArrivals(rows.map(row=>row.message),!loading&&tab==='messages'?session.id:null);
 const events:ChatEvent[]=rows.map(row=>({type:'message.created',channel_id:channel,thread_id:session.origin_thread_id,sequence:row.message.sequence,occurred_at:row.message.created_at,payload:row.message as ChatMessage}));

 const uploadKey=`session:${channel}:${session.id}`;
 async function queueAction(item:SessionInput,operation:QueueAction,value?:string){
   const base=`/agent-sessions/${session.id}`,path=`${base}/queue/${item.id}`;
   if(operation==='move') return action(path,{move_to:value},'PATCH');
   if(operation==='edit') return action(path,{text:value,previous_text:item.text},'PATCH');
   if(operation==='steer') return action(base+'/steer',{text:item.text,document:item.document??undefined,browser_url:item.browser_url??undefined,execution_id:latest?.active_execution_id,source_input_id:item.id},'POST',crypto.randomUUID());
   return action(path+'/'+operation);
 }
 async function submit(text:string,document:RichDocument,files:Attachment[],delivery:DeliveryMode,settings?:CodexSettings) {
   pinned.current=true;
   const result=await onSend(text,document,files,delivery,latest?.active_execution_id??undefined,settings);
   setDraftExecution(undefined);
   if(delivery==='messages')setSubmittedTask(result.id);else await refresh();
 }
 const goalAttempt=useRef<{body:string;key:string} | undefined>(undefined);
 async function sendGoal(goal:GoalAction, settings?:CodexSettings) {
   const running=busy(latest);
   if (running && !(canSteer && latest?.goal_action)) throw new ComposerSendError('Wait for this turn to finish before changing the goal.');
   const text=goal.kind==='set' ? goal.objective : '/goal '+goal.kind;
   const payload=running ? {text,goal_action:goal,execution_id:latest!.active_execution_id} : {text,goal_action:goal,codex_settings:settings};
   const body=JSON.stringify(payload);
   if (goalAttempt.current?.body!==body) goalAttempt.current={body,key:crypto.randomUUID()};
   try {
     const result=await request<{id:string;state?:string}>(`/agent-sessions/${session.id}/${running?'steer':'messages'}`,payload,goalAttempt.current.key);
     if (running && result.state!=='sent') {
       if (result.state==='blocked') goalAttempt.current=undefined;
       throw new ComposerSendError('Goal delivery was not confirmed. Check the session before trying again.');
     }
     goalAttempt.current=undefined;
     pinned.current=true;
     if (!running) setSubmittedTask(result.id);
     await refresh();
   } catch(reason) {
     if (denied(reason)) lost.current();
     throw new ComposerSendError(errorText(reason));
   }
 }
 const stopTurn=manage && busy(latest) ? <Button size="sm" disabled={pending} onClick={()=>void action(`/agent-sessions/${session.id}/stop`)}><Stop size={14}/>Stop</Button> : null;
 const footer=activeSession.state==='ended'?<div className="agent-session-ended"><strong>Session ended</strong>
  {history.latest.final_summary && <p>{history.latest.final_summary.excerpt}</p>}
  {manage && session.managed && !archived && <Button size="sm" disabled={pending} onClick={()=>void action(`/agent-sessions/${session.id}/reopen`)}>Reopen session</Button>}</div>:!session.managed?<p className="agent-session-notice">Start a new session to continue this earlier run.</p>:!archived?<>
  {staleSteer && <div className="agent-session-system-notice" role="status">The turn you were steering has ended. <Button size="sm" onClick={()=>setDraftExecution(undefined)}>Use draft as follow-up</Button></div>}
  <AgentSessionComposer primary={primary} conversationKey={uploadKey} models={models} startingGoal={busy(latest) && latest?.goal_action?.kind==='set' ? latest.goal_action.objective : undefined} sessionGoal={history.latest.session_goal} onGoalAction={viewerId===activeSession.owner_id && activeSession.supports_steering ? sendGoal : undefined} initialSettings={initial.turns.at(-1)?.task.codex_settings} typingIndicator={<>
    <ResultActions actions={outputs.actions}/><div className="agent-session-activity"><AgentActivityIndicator name={session.agent_name} turn={latestTurn}/>{codeChannel && stopTurn}</div><SessionQueue items={queue} canManage={item => viewerId === item.actor_id || viewerId === activeSession.owner_id}
    pending={pending} onAction={queueAction} canSteer={canSteer} paused={activeSession.queue_paused}
    onResume={manage?()=>void action(`/agent-sessions/${session.id}/queue/resume`):undefined} mode={preference} onModeChange={canSteer?setPreference:undefined}/>
    </>} submitLabel={mode==='messages'?undefined:mode==='queue'?'Queue':'Steer'}
    submitIcon={mode==='messages'?undefined:mode==='queue'?<ListBullets size={18}/>:<ArrowBendUpRight size={18}/>}
    controls={{ attachmentsEnabled: !!uploads?.enabled, findMentions: findReferences,
      submitAccessory: canSteer && <span className="agent-followup-menu" title="Follow-up behavior"><FollowUpMenu mode={preference} change={setPreference}/></span>,
    }}
    onAlternateSend={canSteer?(text,doc,files,options)=>submit(text,doc,files,mode==='steer'?'queue':'steer',options?.codex_settings):undefined} workspace={session.workspace_id} skill={session.skill} channel="agent session" placeholder={`Message ${session.agent_name}`} sendDisabled={sendDisabled} maxLength={4000} attachments={uploads?.drafts[uploadKey]??[]} onAttachmentsChange={files=>uploads?.change(uploadKey,channel,files)} onRetryAttachment={id=>uploads?.retry(uploadKey,channel,id)} draftValue={draft ?? null} acknowledgedDocument={acknowledged} onDraftChange={doc=>{
      if (!doc.ops.some(op=>op.insert.trim())) setDraftExecution(undefined);
      else if (mode==='steer' && !draftExecution) setDraftExecution(latest?.active_execution_id??undefined);
      onDraftChange(doc);
    }} onSend={(text,doc,files,options)=>submit(text,doc,files,mode,options?.codex_settings)}/></>:null;
 return <div className={codeChannel ? "agent-session code-channel" : "agent-session"} aria-label={`Agent session ${session.title}`}>
  <ConversationHeader primary={primary} title="Agent session" topic={!codeChannel && session.managed&&<div className="agent-session-header-title">
    <span title={session.title}><SessionTitle title={session.title}/></span>
    {manage&&<IconButton label="Rename session" onClick={()=>setRenaming(true)}><PencilSimple size={15}/></IconButton>}
  </div>} backLabel={data?.context?"Back to my sidekick":undefined} heading={<ConversationHeading title={codeChannel ? activeSession.title : session.agent_name} label={`Conversation details for ${codeChannel ? activeSession.title : session.agent_name}`} onClick={()=>!codeChannel && profiles ? profiles.open({kind:'agent',id:session.installation_id}) : setDetailsOpen(true)} leading={session.managed&&<IconButton label={starred.active?'Unstar conversation':'Star conversation'} aria-pressed={starred.active} aria-disabled={starred.busy||undefined} onClick={()=>void starred.toggle(session.id,{id:session.id,name:session.title,kind:'agent_session',private:false,working:latest?.status==='running',can_rename:manage,session:{id:session.id,agent_name:session.agent_name,origin_thread_id:session.origin_thread_id,channel_id:channel,channel_archived:archived,code_channel:codeChannel}}).catch(reason=>setError(errorText(reason)))}><Star size={19} weight={starred.active?'fill':'regular'}/></IconButton>} icon={codeChannel ? <Code className="code-channel-icon" size={20}/> : <Avatar name={session.agent_name} initials={session.agent_name.slice(0,2).toUpperCase()} tone="green"/>}/>} channel={channelName} icon={<Robot size={20}/>} onBack={onBack} onClose={onClose} actions={<>{codeChannel && <button type="button" className="code-channel-artifacts-toggle" ref={artifactButton} aria-expanded={artifactOpen}
    onClick={()=>artifactOpen ? closeArtifacts() : showArtifact(artifact)}><Stack size={16}/>Artifacts <span>{artifacts.length}</span></button>}{!codeChannel && stopTurn}<Menu label="More conversation actions" floating trigger={<DotsThree size={22} weight="bold"/>} items={[{label:"Conversation details",onSelect:()=>setDetailsOpen(true)},...(profiles?[{label:"View full profile",onSelect:()=>profiles.open({kind:'agent',id:session.installation_id})}]:[]),...(codeChannel ? [
    ...(outputs.files.length ? [{label:'Browse files',onSelect:()=>showArtifact('files')}] : []),
    ...(manage ? [{label:'Rename session',onSelect:()=>setRenaming(true)}] : [])
   ] : [{label:"Browse files",onSelect:()=>setTab("files")}]),...(manage && session.managed && activeSession.state==='active' ? [{label:"End session for everyone",onSelect:()=>setEnding(true)}] : []),...(onClose?[{label:"Close agent session",separatorBefore:true,onSelect:onClose}]:[])]}/></>}/>
  <Tabs className="agent-session-tabs" label="Session views" value={tab} onChange={value => {if(artifactOpen) setArtifactOpen(false); if(value==='changes') setOpenedChanges(true);setTab(value);}} items={[
   {id:'messages',label:'Messages',icon:<ChatCircle size={15}/>},
   ...(session.managed && !data.context?[{id:'team',label:'Team',icon:<ChatCircle size={15}/>}]:[]),
   {id:'preview',label:'Preview',icon:<Browser size={15}/>},
   {id:'files',label:`Files ${outputs.files.length}`,icon:<Paperclip size={15}/>},
   {id:'changes',label:`Changes ${outputs.changes.length}`,icon:<GitDiff size={15}/>},
  ].map(item=>({...item,panelId:`${viewsId}-${item.id}`}))}/>
  {codeChannel && <CodeChannelContext context={outputs.context}/>}

  {error&&<p role="alert" className="agent-sessions-error">{error} <Button size="sm" variant="ghost" disabled={refreshing||!!loading} onClick={()=>void refresh()}>Retry</Button></p>}
  <ToolApprovals audience={history.latest.audience} items={history.latest.tool_approvals??[]} canDecide={viewerId===activeSession.owner_id} onResolved={refresh}/><div className="agent-session-body" data-artifacts-open={codeChannel && artifactOpen || undefined}><div className="agent-session-conversation" role="tabpanel" aria-label="Messages" id={`${viewsId}-messages`} hidden={tab!=='messages'}><MessageTimeline endPadding={5} header={!data.next_cursor&&<><ConversationIntroduction title={codeChannel ? activeSession.title : session.agent_name} icon={<Avatar name={session.agent_name} initials={session.agent_name.slice(0,2).toUpperCase()} size="lg" tone="green"/>}>{codeChannel ? <>{session.agent_name} was invited to this agent session. {conversationPath(channel,session.origin_thread_id) && <a href={conversationPath(channel,session.origin_thread_id)}>View original conversation</a>}</> : <>This is the beginning of your conversation with {session.agent_name}.</>}</ConversationIntroduction>{data.context&&<><SidekickContextSection context={data.context}/><div className="sidekick-conversation-divider" role="separator" aria-label="Agent conversation"><span>Conversation with {session.agent_name}</span></div></>}</>} label="Session conversation" role="log" items={events} page={{has_older:!!data.next_cursor,has_newer:data.has_newer}} loading={loading} latestVersion={latestVersion} load={load} pinned={pinned} hidden={tab!=='messages'} render={(_event,index)=>{
   const row=rows[index]!,turn=row.turn;
   return <div id={`chat-message-${row.message.id}`} tabIndex={-1} className="chat-message-anchor"><ConversationDateDivider date={row.message.created_at} previous={rows[index-1]?.message.created_at}/>{row.showMessage&&<ConversationMessage message={row.message as ChatMessage} previous={rows[index-1]?.message} viewerId={viewerId} arrival={arrivals.has(row.message.id)} onMentionClick={setSelectedMention} showAgentActivity={false} streaming={!row.request&&busy(turn.task)} actions={{copyMessage:()=>navigator.clipboard.writeText(row.message.text)}} body={!row.request&&turn.task.status==='awaiting_approval'?<div className="agent-session-approval"><p>Waiting for {session.agent_name}’s owner to approve this request.</p>{viewerId===session.owner_id&&<><Button size="sm" disabled={pending} onClick={()=>void action(`/tasks/${turn.task.id}/approve`)}>Approve request</Button><Button size="sm" variant="ghost" disabled={pending} onClick={()=>void action(`/tasks/${turn.task.id}/reject`)}>Decline</Button></>}</div>:undefined}/>}
    {row.request && turn.steering?.map((item,index) => {
      if (item.state !== 'sent') return <SteeringReceipt key={item.id} item={item}/>;
      const message:ChatMessage = {
        id:item.id, channel_id:channel, thread_id:session.origin_thread_id, task_id:turn.task.id,
        client_message_id:null, sequence:row.message.sequence, text:item.text,document:item.document, created_at:item.created_at ?? row.message.created_at,
        author:{kind:'human',id:item.actor_id,name:item.actor_name ?? (item.actor_id===viewerId?'You':'Member')},
      };
      const previous=turn.steering?.[index-1];
      return <ConversationMessage key={item.id} message={message} viewerId={viewerId}
        previous={previous?.state==='sent'?{created_at:previous.created_at??row.message.created_at,author:{kind:'human',id:previous.actor_id,name:previous.actor_name??'Member'}}:index===0?row.message:undefined}
        actions={{copyMessage:()=>navigator.clipboard.writeText(item.text)}}/>;
    })}
    {row.notice&&<div role="status" className="sp-message agent-session-turn-notice"><Info size={16} aria-hidden="true"/><span><strong>Space</strong> · {row.notice}</span></div>}
   </div>;
  }}/>{codeChannel && activeSession.state==='ended' && <ResultActions actions={outputs.actions}/>}{footer}
  </div>{tab==='team' && <div id={viewsId+'-team'} className="session-team-panel" role="tabpanel" aria-label="Team"><SessionAgentHandoff session={activeSession} channel={channel} viewer={viewerId} writable={reviewAllowed} turns={turns} related={history.latest.related_agents??[]} refresh={refresh}/><SessionTeam key={session.id+viewerId} id={session.id} viewer={viewerId} outputs={outputs}/></div>}{(tab==='preview'||tab==='files')&&<div className="agent-session-output-view" role="tabpanel" id={`${viewsId}-${tab}`} aria-label={tab==='preview'?'Preview':'Files'} tabIndex={0}>
   <div className="agent-session-output">{tab==='preview'?<TaskPreview preview={outputs.preview}/>:<TaskFiles files={outputs.files}/>}</div>
  </div>}
  {openedChanges&&<div hidden={tab!=='changes'} className="agent-session-output-view" role="tabpanel" id={`${viewsId}-changes`} aria-label="Changes" tabIndex={0}>
    <div className="agent-session-output"><ResultActions actions={outputs.actions}/><TaskChanges changes={outputs.changes} baseBranch={outputs.context?.base_branch} headBranch={outputs.context?.head_branch} onReview={reviewAllowed?submitReview:undefined}/></div>
  </div>}
  {codeChannel && <CodeChannelArtifacts session={session.id} thread={session.origin_thread_id} viewer={viewerId} outputs={outputs} items={artifacts} open={artifactOpen} selected={artifact} onSelect={setArtifact}
    onClose={closeArtifacts} onReview={reviewAllowed?submitReview:undefined}/>}</div>
  {ending && <Dialog open title="End this session?" description="This stops the active turn, cancels queued requests and keeps the conversation and results available for review." onClose={()=>setEnding(false)} onBeforeClose={()=>!pending}>
    <Button variant="ghost" disabled={pending} onClick={()=>setEnding(false)}>Cancel</Button>
    <Button disabled={pending} onClick={()=>{void action(`/agent-sessions/${session.id}/end`).then(ok=>{if(ok)setEnding(false);});}}>End session</Button>
  </Dialog>}
  {renaming&&manage&&<RenameSessionDialog id={session.id} title={session.title} workspace={session.workspace_id}
    thread={session.origin_thread_id} viewerId={viewerId} onClose={()=>setRenaming(false)}/>}
  <Dialog open={detailsOpen} title="Conversation details" onClose={()=>setDetailsOpen(false)}><div className="agent-session-details"><h3>{session.title}</h3><p>{session.agent_name}</p><p>{activeSession.state==='ended'?'Ended':'Active'} · {activeSession.turn_count} turns</p>{channelName&&<p>From #{channelName}</p>}<p>Started {new Date(session.created_at).toLocaleString()}</p></div></Dialog>
  {selectedMention&&<MentionDetails channel={channel} mention={selectedMention} onClose={()=>setSelectedMention(undefined)}/>}
 </div>;
}
