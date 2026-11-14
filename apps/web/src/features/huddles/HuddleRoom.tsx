// The live huddle panel. Loaded only once someone joins, so LiveKit stays out of the first page load.
import {useCallback,useEffect,useRef,useState} from 'react';
import {ConnectionState,Track,type Room} from 'livekit-client';
import {RoomContext,RoomAudioRenderer,StartAudio,ParticipantTile,useDataChannel,useTracks,useLocalParticipant,useConnectionState,useMediaDeviceSelect} from '@livekit/components-react';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {Headphones,Microphone,MicrophoneSlash,VideoCamera,VideoCameraSlash,MonitorArrowUp,PhoneDisconnect,CaretDown,CaretUp,ChatsCircle,UserPlus,Smiley,GearSix} from '@phosphor-icons/react';
import {Reveal,motionTransition,surfaceMotion} from '@space/ui/motion';
import {Button,IconButton,Menu,Select} from '@space/ui/primitives';
import {HuddleInvite} from './HuddleDirectory.js';
import type {Huddle} from '@space/contracts';

export type HuddleSession={room:Room;huddle:Huddle};

function Device({kind,label}:{kind:MediaDeviceKind;label:string}) {
 const [error,setError]=useState('');
 const {devices,activeDeviceId,setActiveMediaDevice}=useMediaDeviceSelect({kind,requestPermissions:false,onError:()=>setError('Unable to use this device.')});
 return <label>{label}<Select aria-label={label} value={activeDeviceId} onChange={e=>{setError('');void setActiveMediaDevice(e.target.value).catch(()=>setError('Unable to use this device.'));}}>
  <option value="">System default</option>{devices.map((d,i)=><option key={d.deviceId} value={d.deviceId}>{d.label||`${label} ${i+1}`}</option>)}
 </Select>{error&&<span role="alert">{error}</span>}</label>;
}
const reactions=[['👍','Thumbs up'],['👏','Clap'],['❤️','Heart'],['😂','Laugh'],['🎉','Celebrate'],['✋','Raise hand']] as const;

function HuddleReactions({offline}:{offline:boolean}) {
 const reduced=useReducedMotion();
 const [shown,setShown]=useState(''),[error,setError]=useState('');
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const show=useCallback((index:number,name?:string)=>{
  const reaction=reactions[index];
  if(!reaction)return;
  setShown(`${name??'A participant'} · ${reaction[0]}`);
  clearTimeout(timer.current);timer.current=setTimeout(()=>setShown(''),3000);
 },[]);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 const receive=useCallback((msg:{payload:Uint8Array;from?:{name?:string}})=>{
  if(msg.payload.length===1)show(msg.payload[0]!,msg.from?.name);
 },[show]);
 const {send,isSending}=useDataChannel('space.huddle.reaction',receive);
 const last=useRef(0);
 async function react(index:number){
  if(offline||isSending||Date.now()-last.current<500)return;
  last.current=Date.now();setError('');
  try{await send(Uint8Array.of(index),{reliable:false});show(index,'You');}catch{setError('Reaction could not be sent.');}
 }
 return <><Menu label="Reactions" floating trigger={<Smiley size={21}/>} items={reactions.map(([emoji,label],i)=>({label,icon:<span aria-hidden="true">{emoji}</span>,onSelect:()=>void react(i)}))}/>
  <AnimatePresence>{shown&&<motion.output key={shown} {...surfaceMotion(reduced)} className="huddle-reaction">{shown}</motion.output>}</AnimatePresence>{error&&<span role="alert">{error}</span>}</>;
}

type PanelProps={session:HuddleSession;leave:()=>void;error:string;onOpenThread?:(item:{channel_id:string;thread_id:string})=>void};
function HuddlePanel({session,leave,error,onOpenThread}:PanelProps) {
 const [minimized,setMinimized]=useState(false),[settings,setSettings]=useState(false),[failure,setFailure]=useState(''),[busy,setBusy]=useState(false);
 const [invite,setInvite]=useState(false);
 const changing=useRef(false),reduce=useReducedMotion(),state=useConnectionState();
 const {localParticipant:p,isMicrophoneEnabled:mic,isCameraEnabled:camera,isScreenShareEnabled:screen}=useLocalParticipant();
 const tracks=useTracks([{source:Track.Source.Camera,withPlaceholder:true},{source:Track.Source.ScreenShare,withPlaceholder:false}]);
 const action=async(fn:()=>Promise<unknown>)=>{if(changing.current)return;changing.current=true;setBusy(true);setFailure('');try{await fn();}catch{setFailure('Could not enable that device. Check browser permissions and try again.');}finally{changing.current=false;setBusy(false);}};
 const offline=state!==ConnectionState.Connected;
 return <motion.section layout={reduce?false:"position"} layoutDependency={minimized} className={`huddle-panel${minimized?' huddle-panel--small':''}`} aria-label="Channel huddle"
  initial={reduce?false:{opacity:0,y:16}} animate={{opacity:1,y:0}} transition={motionTransition(reduce)}>
  <RoomAudioRenderer/><StartAudio label="Enable huddle audio"/>
  <header><Headphones size={22}/><div><strong>{session.huddle.channel_kind==='direct'?'':'#'}{session.huddle.channel_name}</strong><p role="status">{offline?'Reconnecting…':`${session.room.remoteParticipants.size+1} in this huddle`}</p></div>
   <IconButton label={minimized?'Expand huddle':'Minimize huddle'} onClick={()=>setMinimized(!minimized)}>{minimized?<CaretUp size={20}/>:<CaretDown size={20}/>}</IconButton></header>
  {(error||failure)&&<p role="alert" className="huddle-error">{failure||error}</p>}
  <Reveal open={!minimized}>
   <div className="huddle-grid">{tracks.map(t=><ParticipantTile key={`${t.participant.identity}:${t.source}`} trackRef={t}/>)}</div>
   <Reveal open={settings}><div className="huddle-devices"><Device kind="audioinput" label="Microphone"/><Device kind="videoinput" label="Camera"/><Device kind="audiooutput" label="Speaker"/></div></Reveal>
  </Reveal>
  <div className="huddle-controls">
   <IconButton label={mic?'Mute microphone':'Unmute microphone'} aria-pressed={mic} disabled={busy||offline} onClick={()=>void action(()=>p.setMicrophoneEnabled(!mic))}>{mic?<Microphone size={21}/>:<MicrophoneSlash size={21}/>}</IconButton>
   <IconButton label={camera?'Turn camera off':'Turn camera on'} aria-pressed={camera} disabled={busy||offline} onClick={()=>void action(()=>p.setCameraEnabled(!camera))}>{camera?<VideoCamera size={21}/>:<VideoCameraSlash size={21}/>}</IconButton>
   <IconButton label={screen?'Stop screen sharing':'Share screen'} aria-pressed={screen} disabled={busy||offline} onClick={()=>void action(()=>p.setScreenShareEnabled(!screen,{audio:true}))}><MonitorArrowUp size={21}/></IconButton>
   {!minimized&&session.huddle.channel_kind!=='direct'&&<IconButton label="Invite people" disabled={offline} onClick={()=>setInvite(true)}><UserPlus size={21}/></IconButton>}
   <HuddleReactions offline={offline}/>
   {session.huddle.thread_id && onOpenThread && <IconButton label="Open huddle thread" onClick={()=>{setMinimized(true);onOpenThread({channel_id:session.huddle.channel_id,thread_id:session.huddle.thread_id!});}}><ChatsCircle size={21}/></IconButton>}
   <IconButton label="Huddle device settings" aria-pressed={settings} onClick={()=>{setSettings(!settings);setMinimized(false);}}><GearSix size={21}/></IconButton>
   <Button className="huddle-leave" size="sm" onClick={leave}><PhoneDisconnect size={20}/>Leave</Button>
  </div>
  {invite&&<HuddleInvite workspace={session.huddle.workspace_id} room={session.huddle} viewer={p.identity} onClose={()=>setInvite(false)}/>}
 </motion.section>;
}

export default function HuddleRoom({session,leave,error,onOpenThread}:PanelProps) {
 return <RoomContext.Provider value={session.room}><HuddlePanel session={session} leave={leave} error={error} onOpenThread={onOpenThread}/></RoomContext.Provider>;
}
