import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {Room,RoomEvent,ConnectionState,Track} from 'livekit-client';
import {RoomContext,RoomAudioRenderer,StartAudio,ParticipantTile,useTracks,useLocalParticipant,useConnectionState,useMediaDeviceSelect} from '@livekit/components-react';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {Headphones,Microphone,MicrophoneSlash,VideoCamera,VideoCameraSlash,MonitorArrowUp,PhoneDisconnect,CaretDown,CaretUp,GearSix} from '@phosphor-icons/react';
import {Button,Dialog,IconButton,Select} from '@space/ui/primitives';
import {parseConversationPath} from '@space/contracts';
import type {Huddle,HuddleAdmission,Page} from '@space/contracts';
import {request} from '../../shared/api/request.js';
import {subscribeUpdates,invalidateUpdates} from '../../shared/realtime/live-updates.js';
import './huddles.css';
import {useCallingState} from '../calling/Calling.js';

type Target={id:string;name:string};
type Session={room:Room;huddle:Huddle};
type HuddleContextValue={enabled:boolean;loading:boolean;session:Session|null;busy:boolean;open:(channel:Target)=>void};
const HuddleContext=createContext<HuddleContextValue|null>(null);
const errorText=(error:unknown)=>{
 const code=error instanceof Error?error.message:'';
 if(['not_found','unauthorized','forbidden'].includes(code))return 'You no longer have access to this channel.';
 if(code==='huddle_ended')return 'This huddle has ended. You can start a new one.';
 if(code==='huddles_unavailable')return 'Huddles are not configured for this server yet.';
 return 'Could not connect to the huddle. Check your connection and try again.';
};

export function HuddleProvider({children}:{children:ReactNode}) {
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
      if (!channel.joined || channel.archived_at || channel.kind === 'direct') { setError('This channel is unavailable for huddles.'); return; }
      setTarget({id:channel.id,name:channel.name});
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
 const join=async()=>{
  if(!target||joining.current)return;
  joining.current=true;setBusy(true);setError('');const attempt=++generation.current;
  const next=new Room({adaptiveStream:true,dynacast:true,videoCaptureDefaults:{resolution:{width:1280,height:720,frameRate:24}},publishDefaults:{simulcast:true}});
  room.current=next;
  try{
   const admission=await request<HuddleAdmission>(`/channels/${target.id}/huddle/join`,{});
   if(attempt!==generation.current)return;
   await next.connect(admission.url,admission.token);
   if(attempt!==generation.current){await next.disconnect(true);return;}
   next.once(RoomEvent.Disconnected,()=>{if(room.current===next){leave();setError('You have left the huddle.');}});
   setSession({room:next,huddle:admission.huddle});setTarget(null);
   if(microphone){try{await next.localParticipant.setMicrophoneEnabled(true);}catch{if(attempt===generation.current)setError('Microphone unavailable. You joined muted; check your browser permissions.');}}
   if(attempt!==generation.current){await next.disconnect(true);return;}
   void invalidateUpdates('channel',admission.huddle.channel_id);void invalidateUpdates('workspace',admission.huddle.workspace_id);
  }catch(e){if(attempt===generation.current){room.current=null;await next.disconnect(true);setSession(null);setError(errorText(e));}}
  finally{if(attempt===generation.current){joining.current=false;setBusy(false);}}
 };
 const open=(channel:Target)=>{if(session||joining.current)return;if(call?.busy||call?.preview||(call?.call&&call.call.state!=='ended')){setError('Finish your direct call before joining a huddle.');return;}setError('');setMicrophone(true);setTarget(channel);};
 return <HuddleContext.Provider value={{enabled,loading,session,busy,open}}>{children}
  <Dialog open={!!target} title={`Join huddle${target?` in #${target.name}`:''}`}
   onBeforeClose={()=>{leave();setTarget(null);setError('');return true;}}
   onClose={()=>{if(target){leave();setTarget(null);setError('');}}}>
   <div className="huddle-prejoin"><Headphones size={42}/><p>Talk with your channel. Your camera starts off.</p>
    <label><input type="checkbox" checked={microphone} disabled={busy} onChange={e=>setMicrophone(e.target.checked)}/> Turn on my microphone when I join</label>
    <p className="huddle-hint">Up to 12 people · audio, video, and screen sharing</p>
    {error&&<p role="alert">{error}</p>}<Button variant="primary" loading={busy} onClick={()=>void join()}>Join huddle</Button>
   </div>
  </Dialog>
  {session&&<RoomContext.Provider value={session.room}><HuddlePanel session={session} leave={leave} error={error}/></RoomContext.Provider>}
  {!session&&!target&&error&&<div className="huddle-notice" role="status">{error}<Button size="sm" onClick={()=>setError('')}>Dismiss</Button></div>}
 </HuddleContext.Provider>;
}

export function HuddleButton({channel,name,disabled=false}:{channel:string;name:string;disabled?:boolean}) {
 const context=useContext(HuddleContext),[active,setActive]=useState<Huddle|null>(null);
 useEffect(()=>{
  if(!context?.enabled||disabled)return;
  let alive=true;
  const stop=subscribeUpdates('channel',channel,async()=>{try{const h=await request<Huddle|null>(`/channels/${channel}/huddle`);if(alive)setActive(h);}catch{if(alive)setActive(null);}});
  return()=>{alive=false;stop();};
 },[channel,context?.enabled,disabled]);
 if(!context?.enabled)return null;
 const joined=context.session?.huddle.channel_id===channel;
 return <Button size="sm" disabled={disabled||context.busy||!!context.session} onClick={()=>context.open({id:channel,name})}>
  <Headphones size={18}/>{joined?'In huddle':active?'Join huddle':'Start huddle'}
 </Button>;
}

function Device({kind,label}:{kind:MediaDeviceKind;label:string}) {
 const [error,setError]=useState('');
 const {devices,activeDeviceId,setActiveMediaDevice}=useMediaDeviceSelect({kind,requestPermissions:false,onError:()=>setError('Unable to use this device.')});
 return <label>{label}<Select aria-label={label} value={activeDeviceId} onChange={e=>{setError('');void setActiveMediaDevice(e.target.value).catch(()=>setError('Unable to use this device.'));}}>
  <option value="">System default</option>{devices.map((d,i)=><option key={d.deviceId} value={d.deviceId}>{d.label||`${label} ${i+1}`}</option>)}
 </Select>{error&&<span role="alert">{error}</span>}</label>;
}
function HuddlePanel({session,leave,error}:{session:Session;leave:()=>void;error:string}) {
 const [minimized,setMinimized]=useState(false),[settings,setSettings]=useState(false),[failure,setFailure]=useState(''),[busy,setBusy]=useState(false);
 const changing=useRef(false),reduce=useReducedMotion(),state=useConnectionState();
 const {localParticipant:p,isMicrophoneEnabled:mic,isCameraEnabled:camera,isScreenShareEnabled:screen}=useLocalParticipant();
 const tracks=useTracks([{source:Track.Source.Camera,withPlaceholder:true},{source:Track.Source.ScreenShare,withPlaceholder:false}]);
 const action=async(fn:()=>Promise<unknown>)=>{if(changing.current)return;changing.current=true;setBusy(true);setFailure('');try{await fn();}catch{setFailure('Could not enable that device. Check browser permissions and try again.');}finally{changing.current=false;setBusy(false);}};
 const offline=state!==ConnectionState.Connected;
 return <motion.section className={`huddle-panel${minimized?' huddle-panel--small':''}`} aria-label="Channel huddle"
  initial={reduce?false:{opacity:0,y:16}} animate={{opacity:1,y:0}} transition={{duration:reduce?0:0.18}}>
  <RoomAudioRenderer/><StartAudio label="Enable huddle audio"/>
  <header><Headphones size={22}/><div><strong>#{session.huddle.channel_name}</strong><p role="status">{offline?'Reconnecting…':`${session.room.remoteParticipants.size+1} in this huddle`}</p></div>
   <IconButton label={minimized?'Expand huddle':'Minimize huddle'} onClick={()=>setMinimized(!minimized)}>{minimized?<CaretUp size={20}/>:<CaretDown size={20}/>}</IconButton></header>
  {(error||failure)&&<p role="alert" className="huddle-error">{failure||error}</p>}
  <AnimatePresence initial={false}>{!minimized&&<motion.div key="media" initial={reduce?false:{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={{duration:reduce?0:0.12}}>
   <div className="huddle-grid">{tracks.map(t=><ParticipantTile key={`${t.participant.identity}:${t.source}`} trackRef={t}/>)}</div>
   {settings&&<div className="huddle-devices"><Device kind="audioinput" label="Microphone"/><Device kind="videoinput" label="Camera"/><Device kind="audiooutput" label="Speaker"/></div>}
  </motion.div>}</AnimatePresence>
  <div className="huddle-controls">
   <IconButton label={mic?'Mute microphone':'Unmute microphone'} aria-pressed={mic} disabled={busy||offline} onClick={()=>void action(()=>p.setMicrophoneEnabled(!mic))}>{mic?<Microphone size={21}/>:<MicrophoneSlash size={21}/>}</IconButton>
   <IconButton label={camera?'Turn camera off':'Turn camera on'} aria-pressed={camera} disabled={busy||offline} onClick={()=>void action(()=>p.setCameraEnabled(!camera))}>{camera?<VideoCamera size={21}/>:<VideoCameraSlash size={21}/>}</IconButton>
   <IconButton label={screen?'Stop screen sharing':'Share screen'} aria-pressed={screen} disabled={busy||offline} onClick={()=>void action(()=>p.setScreenShareEnabled(!screen,{audio:true}))}><MonitorArrowUp size={21}/></IconButton>
   <IconButton label="Huddle device settings" aria-pressed={settings} onClick={()=>{setSettings(!settings);setMinimized(false);}}><GearSix size={21}/></IconButton>
   <Button className="huddle-leave" size="sm" onClick={leave}><PhoneDisconnect size={20}/>Leave</Button>
  </div>
 </motion.section>;
}

export function Huddles({workspace,onOpenChannel}:{workspace:string;onOpenChannel:(id:string)=>void}) {
 const context=useContext(HuddleContext),[rooms,setRooms]=useState<Huddle[]>([]),[next,setNext]=useState<string|null>(null);
 const [error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0);
 const more=useRef<()=>Promise<void>>(async()=>{});
 useEffect(()=>{
  if(!context?.enabled){setLoading(false);return;}
  let alive=true,version=0,cursor:string|null=null;
  const read=async(after?:string)=>{const run=++version;setLoading(true);try{
   const page=await request<Page<Huddle>>(`/workspaces/${workspace}/huddles${after?`?after=${after}`:''}`);
   if(alive&&run===version){cursor=page.next_cursor;setRooms(old=>after?[...old,...page.items]:page.items);setNext(page.next_cursor);setError('');}
  }catch(e){if(alive&&run===version){setRooms([]);setNext(null);setError(errorText(e));}}finally{if(alive&&run===version)setLoading(false);}};
  more.current=()=>cursor?read(cursor):Promise.resolve();
  const stop=subscribeUpdates('workspace',workspace,()=>read(),()=>{alive=false;version++;setRooms([]);setNext(null);setLoading(false);setError('You no longer have access to this workspace.');});
  return()=>{alive=false;stop();};
 },[workspace,context?.enabled,retry]);
 // Load additional pages only on demand; realtime invalidation refreshes the first page.
 const loadMore=()=>{if(!loading)void more.current();};
 return <section className="huddles-page"><header><Headphones size={26}/><h1>Huddles</h1></header>
  <p>Drop into a conversation with your channel. Keep talking as you move around Space.</p>
  {context?.loading?<p role="status">Loading huddles…</p>:!context?.enabled?<div className="huddles-empty"><Headphones size={44}/><h2>Huddles need a media connection</h2><p>Ask your server administrator to configure LiveKit to enable channel audio, video, and screen sharing.</p></div>:<>
   {error&&<p role="alert">{error} <Button onClick={()=>setRetry(x=>x+1)}>Try again</Button></p>}
   {loading&&!rooms.length?<p role="status">Loading active huddles…</p>:rooms.length?<div className="huddle-list">{rooms.map(h=><article key={h.id}><Headphones size={28}/><div><button className="huddle-channel-link" onClick={()=>onOpenChannel(h.channel_id)}>#{h.channel_name}</button><p>{h.state==='starting'?'Starting…':'Huddle is open'}</p></div><HuddleButton channel={h.channel_id} name={h.channel_name}/></article>)}</div>:!error&&<div className="huddles-empty"><Headphones size={44}/><h2>A little conversation goes a long way</h2><p>No active huddles yet. Open a channel and choose <strong>Start huddle</strong> to bring people together.</p></div>}
   {next&&<Button loading={loading} onClick={()=>void loadMore()}>Load more huddles</Button>}
  </>}
 </section>;
}
