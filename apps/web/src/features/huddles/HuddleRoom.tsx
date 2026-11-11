// The live huddle panel. Loaded only once someone joins, so LiveKit stays out of the first page load.
import {useRef,useState} from 'react';
import {ConnectionState,Track,type Room} from 'livekit-client';
import {RoomContext,RoomAudioRenderer,StartAudio,ParticipantTile,useTracks,useLocalParticipant,useConnectionState,useMediaDeviceSelect} from '@livekit/components-react';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {Headphones,Microphone,MicrophoneSlash,VideoCamera,VideoCameraSlash,MonitorArrowUp,PhoneDisconnect,CaretDown,CaretUp,GearSix} from '@phosphor-icons/react';
import {Button,IconButton,Select} from '@space/ui/primitives';
import type {Huddle} from '@space/contracts';

export type HuddleSession={room:Room;huddle:Huddle};

function Device({kind,label}:{kind:MediaDeviceKind;label:string}) {
 const [error,setError]=useState('');
 const {devices,activeDeviceId,setActiveMediaDevice}=useMediaDeviceSelect({kind,requestPermissions:false,onError:()=>setError('Unable to use this device.')});
 return <label>{label}<Select aria-label={label} value={activeDeviceId} onChange={e=>{setError('');void setActiveMediaDevice(e.target.value).catch(()=>setError('Unable to use this device.'));}}>
  <option value="">System default</option>{devices.map((d,i)=><option key={d.deviceId} value={d.deviceId}>{d.label||`${label} ${i+1}`}</option>)}
 </Select>{error&&<span role="alert">{error}</span>}</label>;
}
function HuddlePanel({session,leave,error}:{session:HuddleSession;leave:()=>void;error:string}) {
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

export default function HuddleRoom({session,leave,error}:{session:HuddleSession;leave:()=>void;error:string}) {
 return <RoomContext.Provider value={session.room}><HuddlePanel session={session} leave={leave} error={error}/></RoomContext.Provider>;
}
