import {useContext,useEffect,useRef,useState} from 'react';
import {motion,useReducedMotion} from 'motion/react';
import {Reveal,motionTransition} from '@space/ui/motion';
import {Avatar,Button,Dialog,IconButton,Spinner,LoadingStatus,ListRowSkeleton} from '@space/ui/primitives';
import {ChatsCircle,Check,Hash,Headphones,Microphone,Monitor,Plus,UserPlus,VideoCameraSlash,X} from '@phosphor-icons/react';
import type {ChannelMember,DirectMessageSummary,Huddle,Page} from '@space/contracts';
import {WorkspaceInvitations} from '../workspace/invitations/WorkspaceInvitations.js';
import {request} from '../../shared/api/request.js';
import {subscribeUpdates} from '../../shared/realtime/live-updates.js';
import {HuddleContext,type HuddleTarget} from './Huddles.js';

type Directory={active:Page<Huddle>;recent:Huddle[];channels:HuddleTarget[]};
const empty:Directory={active:{items:[],next_cursor:null},recent:[],channels:[]};

type HuddleInviteProps = {workspace:string;viewer?:string;room?:Huddle;onStart?:(target:HuddleTarget)=>void;onClose:()=>void};
export function HuddleInvite(props:HuddleInviteProps) {
 return <InvitePicker key={JSON.stringify([props.workspace,props.viewer,props.room?.id])} {...props}/>;
}
function InvitePicker({workspace,viewer,room,onStart,onClose}:HuddleInviteProps) {
 const reduced=useReducedMotion();
 const [open,setOpen]=useState(true);
 const [query,setQuery]=useState(''),[page,setPage]=useState<{query:string;items:ChannelMember[]}>(),[selected,setSelected]=useState<ChannelMember>();
 const [pendingSearch,setPendingSearch]=useState(true);
 const [searchError,setSearchError]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
 const nextTarget=useRef<HuddleTarget|null>(null);
 const opening=useRef(false),submission=useRef<AbortController|null>(null);
 useEffect(()=>()=>submission.current?.abort(),[]);
 useEffect(()=>{
  const controller=new AbortController();
  setPendingSearch(true);setSearchError('');
  const timer=setTimeout(()=>{
   const params=new URLSearchParams({q:query,limit:'30'});
   const url=room?`/huddles/${room.id}/people?${params}`:`/workspaces/${workspace}/direct-message-people?${params}`;
   void request<Page<ChannelMember>>(url,undefined,undefined,'POST',controller.signal)
    .then(result=>{
     if(controller.signal.aborted)return;
     const items=result.items.filter(person=>person.id!==viewer);
     setPage({query,items});setSelected(prev=>items.find(person=>person.id===prev?.id));
    })
    .catch(()=>{if(!controller.signal.aborted){setPage(undefined);setSelected(undefined);setSearchError('Could not load teammates.');}})
    .finally(()=>{if(!controller.signal.aborted)setPendingSearch(false);});
  },query?150:0);
  return ()=>{clearTimeout(timer);controller.abort();};
 },[workspace,query,viewer,retry,room?.id]);
 const searching=!searchError && (pendingSearch || page?.query!==query);
 const people=page?.items.filter(person=>!searching || person.name.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
 async function start(){
  if(!selected||opening.current)return;
  const controller=new AbortController();submission.current=controller;opening.current=true;setBusy(true);setError('');
  try{
   if(room){
    await request('/huddles/'+room.id+'/invite',{user_id:selected.id},undefined,'POST',controller.signal);
    if(!controller.signal.aborted)setOpen(false);
    return;
   }
   const dm=await request<DirectMessageSummary>(`/workspaces/${workspace}/direct-messages`,{user_id:selected.id},undefined,'POST',controller.signal);
   if(!controller.signal.aborted){nextTarget.current={id:dm.id,name:dm.name,direct:true};setOpen(false);}
  }catch{if(!controller.signal.aborted)setError(room?'Could not invite this teammate. Try again.':'Could not open this conversation. Try again.');}
  finally{if(!controller.signal.aborted){opening.current=false;setBusy(false);}}
 }
 return <Dialog open={open} title="Invite someone to your huddle" onBeforeClose={()=>{submission.current?.abort();return true;}} onClose={()=>{if(nextTarget.current&&onStart)onStart(nextTarget.current);else onClose();}}>
  <div className="huddle-picker"><p>{room?'Choose a channel member to invite to this huddle.':'Choose a teammate. They’ll receive an invitation when you start the huddle.'}</p>
   <input autoFocus type="search" aria-label="Find someone to invite" placeholder="Find someone to invite…" value={query} maxLength={100} disabled={busy} onChange={e=>{setQuery(e.target.value);setSelected(undefined);setSearchError('');setError('');}}/>
   <div className="huddle-picker-options" role="group" aria-label="Teammates">{people.map(person=><button type="button" key={person.id} aria-pressed={selected?.id===person.id} disabled={busy} onClick={()=>setSelected(person)}>
    <Avatar name={person.name} initials={person.name.slice(0,1)} image={person.image} size="sm"/><span>{person.name}</span>{selected?.id===person.id&&<motion.span className="huddle-picker-check" initial={reduced?false:{opacity:0,scale:.85}} animate={{opacity:1,scale:1}} transition={motionTransition(reduced,.12)}><Check size={16}/></motion.span>}</button>)}
    {searching && (!page && !query ? <ListRowSkeleton label="Loading teammates…"/> : <LoadingStatus>Searching teammates…</LoadingStatus>)}
    {!searching&&!searchError&&!people.length&&<p>No teammates found</p>}
   </div>{searchError&&<p role="alert">{searchError} <button onClick={()=>setRetry(n=>n+1)}>Retry</button></p>}
   {error&&<p role="alert">{error}</p>}
   <footer><Button onClick={()=>{submission.current?.abort();setOpen(false);}}>Cancel</Button><Button variant="primary" disabled={!selected||busy} loading={busy} onClick={()=>void start()}>{room?'Invite':'Start a Huddle'}</Button></footer>
  </div>
 </Dialog>;
}

function HuddleArtwork(){
 return <div className="huddle-art" aria-hidden="true"><div className="huddle-art-title"><Hash size={15}/><i/></div>
  <div className="huddle-art-stage"><span>👩🏾‍💻</span><span>🧑🏻‍🦱</span><span>👨🏽‍💻</span></div>
  <div className="huddle-art-controls"><Microphone/><VideoCameraSlash/><Monitor/><i/></div></div>;
}

export function Huddles({workspace,viewer,onOpenChannel,onOpenThread}:{workspace:string;viewer?:string;onOpenChannel:(id:string)=>void;
 onOpenThread?:(item:{channel_id:string;thread_id?:string})=>void}) {
 const context=useContext(HuddleContext);
 const reduced=useReducedMotion();
 const [directory,setDirectory]=useState<Directory | null>(null),[pending,setPending]=useState<'directory' | 'more' | null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const data = directory ?? empty;
 const [picker,setPicker]=useState(false),[coworkers,setCoworkers]=useState(false);
 const welcomeKey='space:huddles:welcome:'+workspace+':'+(viewer??'');
 const [welcome,setWelcome]=useState(()=>{try{return !localStorage.getItem(welcomeKey);}catch{return true;}});
 const more=useRef<()=>void>(()=>{});
 useEffect(()=>{
  if(!context?.enabled)return;
  let alive=true,version=0,cursor:string|null=null,paging=false;
  const read=async(after?:string)=>{
   const run=++version;
   setPending(after ? 'more' : 'directory');
   setError('');
   try{
    const base=`/workspaces/${workspace}/huddles`;
    if(after){
     const page=await request<Page<Huddle>>(base+'?after='+encodeURIComponent(after));
     if(alive&&run===version){cursor=page.next_cursor;setDirectory(old=>old && ({...old,active:{...page,items:[...old.active.items,...page.items]}}));}
    }else{
     const value=await request<Directory>(base+'/directory');
     if(alive&&run===version){cursor=value.active.next_cursor;setDirectory(value);}
    }
   }catch{if(alive&&run===version){setDirectory(null);cursor=null;setError('Could not load huddles.');}}
   finally{if(alive&&run===version){paging=false;setPending(null);}}
  };
  more.current=()=>{if(cursor&&!paging){paging=true;void read(cursor);}};
  const stop=subscribeUpdates('workspace',workspace,()=>read(),()=>{alive=false;cursor=null;setDirectory(null);setPicker(false);setPending(null);setError('You no longer have access to this workspace.');});
  return ()=>{alive=false;stop();};
 },[workspace,context?.enabled,retry]);
 const blocked=!context?.enabled||!!context?.busy||!!context?.session;
 function openHistory(h:Huddle){if(onOpenThread)onOpenThread({channel_id:h.channel_id,thread_id:h.thread_id??undefined});else onOpenChannel(h.channel_id);}
 function roomRow(h:Huddle){
  const direct=h.channel_kind==='direct',active=h.state!=='ended',name=(direct?'':'#')+h.channel_name;
  return <motion.article layout={reduced?false:"position"} initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={motionTransition(reduced)} className="huddle-row" key={h.id}><span className={'huddle-row-icon'+(active?' is-active':'')}><Headphones size={20}/></span>
   <div className="huddle-row-label"><button onClick={()=>openHistory(h)}>{name}</button><small>{active?'Huddle is open':new Date(h.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</small></div>
   {active?<Button size="sm" disabled={blocked} onClick={()=>context?.open({id:h.channel_id,name:h.channel_name,direct,huddleId:h.id})}>{context?.session?.huddle.id===h.id?'In huddle':'Join huddle'}</Button>:h.thread_id&&<Button size="sm" onClick={()=>openHistory(h)}><ChatsCircle size={16}/>Open thread</Button>}</motion.article>;
 }
 return <main className="huddles-page" aria-label="Huddles"><header><h1>Huddles</h1>{(context?.enabled || context?.loading) && <Button size="sm" disabled={blocked} onClick={()=>setPicker(true)}><Plus size={15}/>New Huddle</Button>}</header>
 {!context?.loading && !context?.enabled?<div className="huddles-empty"><Headphones size={44}/><h2>Huddles need a media connection</h2><p>Ask your server administrator to configure LiveKit to enable audio, video, and screen sharing.</p></div>:<>
 <div className="huddle-scroll"><Reveal open={welcome}><section className="huddle-welcome"><div className="huddle-welcome-inner"><div><h2>Instantly connect over audio or video</h2><p>Talk with your teammates, share your screen, and keep the conversation going in a thread.</p><Button variant="primary" disabled={blocked} onClick={()=>setPicker(true)}><Headphones size={17}/>Start a Huddle</Button></div><HuddleArtwork/></div><IconButton label="Dismiss huddles introduction" onClick={()=>{setWelcome(false);try{localStorage.setItem(welcomeKey,'1');}catch{}}}><X size={18}/></IconButton></section></Reveal>
 <div className="huddle-directory-body">{error&&<p role="alert">{error} <Button size="sm" onClick={()=>setRetry(n=>n+1)}>Try again</Button></p>}
 {!directory && !error && <p className="huddle-directory-status" role="status">
   <Spinner/>{context?.loading ? 'Checking huddle availability…' : 'Loading huddles…'}
 </p>}
 {!!data.active.items.length&&<section><h2>Active huddles</h2><div className="huddle-rows">{data.active.items.map(roomRow)}</div>{data.active.next_cursor&&<Button disabled={pending === 'directory'} loading={pending === 'more'} onClick={()=>more.current()}>Load more huddles</Button>}</section>}
 {!!data.recent.length&&<section><h2>Recent huddles</h2><div className="huddle-rows">{data.recent.map(roomRow)}</div></section>}
 {directory&&!data.recent.length&&!error&&<article className="huddle-team-card"><div aria-hidden="true"><span>👋</span><UserPlus size={38}/></div><footer><div><strong>Invite teammates</strong><small>Add teammates to huddle 1:1</small></div><Button size="sm" onClick={()=>setCoworkers(true)}>Add coworkers</Button></footer></article>}
 {!!data.channels.length&&<section><h2>Channels <span>— talk with your team</span></h2><div className="huddle-rows">{data.channels.map(channel=><motion.button initial="idle" animate="idle" whileHover="engaged" whileFocus="engaged" className="huddle-row huddle-suggestion" key={channel.id} disabled={blocked} onClick={()=>context?.open(channel)}><span className="huddle-row-icon"><Hash size={20}/></span><strong>#{channel.name}</strong><motion.span className="huddle-row-action" variants={{idle:{opacity:0},engaged:{opacity:1}}} transition={motionTransition(reduced,.12)}>Start Huddle</motion.span></motion.button>)}</div></section>}
 </div></div>{coworkers&&<WorkspaceInvitations workspace={workspace} onClose={()=>setCoworkers(false)}/>}
 {picker&&<HuddleInvite workspace={workspace} viewer={viewer} onClose={()=>setPicker(false)} onStart={target=>{setPicker(false);context.open(target);}}/>}</>}
 </main>;
}
