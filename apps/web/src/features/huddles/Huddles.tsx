import {AnimatePresence,motion,useIsPresent,useReducedMotion} from 'motion/react';
import {surfaceMotion} from '@space/ui/motion';
import {createContext,lazy,Suspense,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import type {Room} from 'livekit-client';
import {CaretDown,Headphones,LinkSimple} from '@phosphor-icons/react';
import {Button,Dialog,Menu,toast} from '@space/ui/primitives';
import {conversationPath,parseConversationPath} from '@space/contracts';
import type {Huddle,HuddleAdmission} from '@space/contracts';
import {request} from '../../shared/api/request.js';
import {subscribeUpdates,invalidateUpdates} from '../../shared/realtime/live-updates.js';
import './huddles.css';
import {useCallingState} from '../calling/Calling.js';
import type {HuddleSession} from './HuddleRoom.js';

export type HuddleTarget={id:string;name:string;direct?:boolean;huddleId?:string};
type Target=HuddleTarget;
type Session=HuddleSession;
const HuddleRoom=lazy(()=>import('./HuddleRoom.js'));
type HuddleContextValue={enabled:boolean;loading:boolean;session:Session|null;busy:boolean;open:(channel:Target)=>void};
export const HuddleContext=createContext<HuddleContextValue|null>(null);
const errorText=(error:unknown)=>{
 const code=error instanceof Error?error.message:'';
 if(['not_found','unauthorized','forbidden'].includes(code))return 'You no longer have access to this channel.';
 if(code==='huddle_ended')return 'This huddle has ended. You can start a new one.';
 if(code==='huddles_unavailable')return 'Huddles are not configured for this server yet.';
 return 'Could not connect to the huddle. Check your connection and try again.';
};

function HuddleNotice({invitation,children}:{invitation?:boolean;children:ReactNode}) {
 const present=useIsPresent();
 const Tag=invitation?motion.aside:motion.div;
 return <Tag {...surfaceMotion(useReducedMotion())} className={invitation?'huddle-invitation':'huddle-notice'}
  role={invitation?'complementary':'status'} aria-label={invitation?'Huddle invitation':undefined}
  inert={!present} aria-hidden={!present||undefined}>{children}</Tag>;
}

export function HuddleProvider({children,actor,onOpenThread}:{children:ReactNode;actor?:string;onOpenThread?:(item:{channel_id:string;thread_id:string})=>void}) {
 const call=useCallingState();
 const [enabled,setEnabled]=useState(false),[loading,setLoading]=useState(true);
 const [linkedChannel] = useState(() => {
  if (new URLSearchParams(location.search).get('huddle') !== '1') return;
  try { return parseConversationPath(location.pathname).channel; } catch { return; }
 });
 const [target,setTarget]=useState<Target|null>(null),[session,setSession]=useState<Session|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[microphone,setMicrophone]=useState(true);
 const room=useRef<Room|null>(null),generation=useRef(0),joining=useRef(false);
 const leave=useCallback(()=>{generation.current++;joining.current=false;setBusy(false);setSession(null);
  const previous=room.current;room.current=null;if(previous)void previous.disconnect(true);
 },[]);
 useEffect(()=>{
  let alive=true;
  void request<{enabled:boolean}>('/huddles/config').then(c=>{if(alive)setEnabled(c.enabled);}).catch(()=>{}).finally(()=>{if(alive)setLoading(false);});
  const expired=()=>{leave();setTarget(null);};window.addEventListener('space:session-expired',expired);
  return()=>{alive=false;generation.current++;joining.current=false;void room.current?.disconnect(true);room.current=null;window.removeEventListener('space:session-expired',expired);};
 },[leave]);
 useEffect(() => {
  if (!linkedChannel || loading) return;
  if (!enabled) { setError('Huddles are not configured for this server yet.'); return; }
  const controller = new AbortController();
  void request<{id:string; name:string; joined:boolean; archived_at:string|null; kind?:string}>(`/channels/${linkedChannel}`,undefined,undefined,'POST',controller.signal)
    .then(channel => {
      if (controller.signal.aborted) return;
      if (!channel.joined || channel.archived_at) { setError('This channel is unavailable for huddles.'); return; }
      setTarget({id:channel.id,name:channel.name,direct:channel.kind==='direct'});
    }).catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); });
  return () => controller.abort();
 }, [linkedChannel,enabled,loading]);
 useEffect(()=>{if(call?.call?.state==='accepted'&&room.current){leave();setError('You left the huddle to take your direct call.');}},[call?.call?.state,leave]);
 useEffect(()=>{
  if(!session)return;
  let alive=true;
  const ended=()=>{if(alive){leave();setError('The huddle ended or channel access changed.');}};
  const stop=subscribeUpdates('channel',session.huddle.channel_id,async()=>{
   try{const current=await request<Huddle|null>(`/channels/${session.huddle.channel_id}/huddle`);if(alive&&current?.id!==session.huddle.id)ended();}
   catch(e){if(alive&&e instanceof Error&&['unauthorized','not_found','forbidden'].includes(e.message))ended();}
  },ended);
  return()=>{alive=false;stop();};
 },[session,leave]);
 const [invitations,setInvitations]=useState<Huddle[]>([]),[dismissed,setDismissed]=useState<string[]>([]);
 useEffect(()=>{
  if(!actor||!enabled)return;
  let active=true;
  const stop=subscribeUpdates('actor',actor,async()=>{
   try {
    const items=await request<Huddle[]>('/huddles/invitations');
    if(active){setInvitations(items);setDismissed(old=>old.filter(id=>items.some(h=>h.id===id)));}
   } catch {if(active)setInvitations([]);}
  },()=>setInvitations([]));
  return ()=>{active=false;stop();};
 },[actor,enabled]);
 const invitation=invitations.find(h=>!dismissed.includes(h.id));
 const join=async()=>{
  if(!target||joining.current)return;
  joining.current=true;setBusy(true);setError('');const attempt=++generation.current;
  // LiveKit is large, so it loads only when someone joins a huddle.
  let livekit:typeof import('livekit-client');
  try{livekit=await import('livekit-client');}
  catch(e){if(attempt===generation.current){joining.current=false;setBusy(false);setError(errorText(e));}return;}
  if(attempt!==generation.current)return;
  const {Room,RoomEvent}=livekit;
  const next=new Room({adaptiveStream:true,dynacast:true,videoCaptureDefaults:{resolution:{width:1280,height:720,frameRate:24}},publishDefaults:{simulcast:true}});
  room.current=next;
  try{
   const admission=await request<HuddleAdmission>(`/channels/${target.id}/huddle/join`,target.huddleId?{huddle_id:target.huddleId}:{});
   if(attempt!==generation.current)return;
   await next.connect(admission.url,admission.token);
   if(attempt!==generation.current){await next.disconnect(true);return;}
   next.once(RoomEvent.Disconnected,()=>{if(room.current===next){leave();setError('You have left the huddle.');}});
   setDismissed(old=>[...old,admission.huddle.id]);
   setSession({room:next,huddle:admission.huddle});setTarget(null);
   if(microphone){try{await next.localParticipant.setMicrophoneEnabled(true);}catch{if(attempt===generation.current)setError('Microphone unavailable. You joined muted; check your browser permissions.');}}
   if(attempt!==generation.current){await next.disconnect(true);return;}
   void invalidateUpdates('channel',admission.huddle.channel_id);void invalidateUpdates('workspace',admission.huddle.workspace_id);
  }catch(e){if(attempt===generation.current){room.current=null;await next.disconnect(true);setSession(null);setError(errorText(e));}}
  finally{if(attempt===generation.current){joining.current=false;setBusy(false);}}
 };
 const open=(channel:Target)=>{if(session||joining.current)return;if(call?.busy||call?.preview||(call?.call&&call.call.state!=='ended')){setError('Finish your direct call before joining a huddle.');return;}setError('');setMicrophone(true);setTarget(channel);};
 return <HuddleContext.Provider value={{enabled,loading,session,busy,open}}>{children}
  <Dialog open={!!target} title={`Join huddle${target?` ${target.direct?'with ':'in #'}${target.name}`:''}`}
   onBeforeClose={()=>{leave();setTarget(null);setError('');return true;}}
   onClose={()=>{if(target){leave();setTarget(null);setError('');}}}>
   <div className="huddle-prejoin"><Headphones size={42}/><p>Join with audio. Your camera starts off.</p>
    <label><input type="checkbox" checked={microphone} disabled={busy} onChange={e=>setMicrophone(e.target.checked)}/> Turn on my microphone when I join</label>
    <p className="huddle-hint">Up to 12 people · audio, video, and screen sharing</p>
    {error&&<p role="alert">{error}</p>}<Button variant="primary" loading={busy} onClick={()=>void join()}>Join huddle</Button>
   </div>
  </Dialog>
  {session&&<Suspense fallback={null}><HuddleRoom session={session} leave={leave} error={error} onOpenThread={onOpenThread}/></Suspense>}
  <AnimatePresence>{invitation&&!session&&!target&&!busy&&!call?.busy&&(!call?.call||call.call.state==='ended')&&<HuddleNotice key={invitation.id} invitation>
   <Headphones size={24}/><strong>{invitation.channel_kind==='direct'?invitation.channel_name+' invited you to a huddle':'You’re invited to a huddle in #'+invitation.channel_name}</strong>
   <Button variant="primary" size="sm" onClick={()=>open({id:invitation.channel_id,name:invitation.channel_name,direct:invitation.channel_kind==='direct',huddleId:invitation.id})}>Join</Button>
   <Button size="sm" onClick={()=>{
    setDismissed(old=>[...old,invitation.id]);
    void request('/huddles/invitations/'+invitation.id+'/dismiss',{}).catch(()=>{setDismissed(old=>old.filter(id=>id!==invitation.id));toast.error('Could not dismiss the invitation');});
   }}>Dismiss</Button></HuddleNotice>}
  {!session&&!target&&error&&<HuddleNotice key="notice">{error}<Button size="sm" onClick={()=>setError('')}>Dismiss</Button></HuddleNotice>}</AnimatePresence>
 </HuddleContext.Provider>;
}

export function HuddleButton({channel,name,direct=false,disabled=false}:{channel:string;name:string;direct?:boolean;disabled?:boolean}) {
 const context=useContext(HuddleContext),[active,setActive]=useState<Huddle|null>(null);
 useEffect(()=>{
  if(!context?.enabled||disabled)return;
  let alive=true;
  const stop=subscribeUpdates('channel',channel,async()=>{try{const h=await request<Huddle|null>(`/channels/${channel}/huddle`);if(alive)setActive(h);}catch{if(alive)setActive(null);}});
  return()=>{alive=false;stop();};
 },[channel,context?.enabled,disabled]);
 if(!context?.enabled)return null;
 const joined=context.session?.huddle.channel_id===channel;
 const label=joined?'In huddle':active?'Join huddle':'Start huddle';
 const path=conversationPath(channel);
 return <span className="huddle-header-button"><Button size="sm" aria-label={label} title={label} disabled={disabled||context.busy||!!context.session} onClick={()=>context.open({id:channel,name,direct,huddleId:active?.channel_id===channel?active.id:undefined})}>
  <Headphones size={18}/>{active&&<span>{joined?'In huddle':'Join'}</span>}
 </Button>{path&&<Menu floating label="Huddle options" trigger={<CaretDown size={12}/>} items={[{label:'Copy huddle link',icon:<LinkSimple size={16}/>,onSelect:()=>{
  void navigator.clipboard.writeText(new URL(path+'?huddle=1',location.origin).href).then(()=>toast.success('Huddle link copied'),()=>toast.error('Could not copy huddle link'));
 }}]}/>}</span>;
}

export {Huddles} from './HuddleDirectory.js';
