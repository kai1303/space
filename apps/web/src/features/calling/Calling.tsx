import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {Button,IconButton,Select} from '@space/ui/primitives';
import {Phone,PhoneDisconnect,VideoCamera,VideoCameraSlash,Microphone,MicrophoneSlash,X,CaretDown,CaretUp} from '@phosphor-icons/react';
import {CallController,emptyCallView,type CallView} from './controller.js';
import './calling.css';

const CallingContext=createContext<{controller:CallController|null;view:CallView}|null>(null);
export function useCallingState(){return useContext(CallingContext)?.view;}
export function CallingProvider({actor,children}:{actor:string;children:ReactNode}){
 const [controller,setController]=useState<CallController|null>(null),[view,setView]=useState(emptyCallView);
 useEffect(()=>{const next=new CallController(actor,setView);setController(next);return()=>next.dispose();},[actor]);
 return <CallingContext.Provider value={{controller,view}}>{children}{controller&&<CallPanel controller={controller} view={view}/>}</CallingContext.Provider>;
}
export function CallButtons({channel}:{channel:string}){
 const calling=useContext(CallingContext);if(!calling)return null;
 const {controller,view}=calling;
 const disabled=!view.online||view.busy||!!view.preview||!!(view.call&&view.call.state!=='ended');
 return <><IconButton label="Start voice call" disabled={disabled} onClick={()=>void controller?.start(channel,'audio')}><Phone size={20}/></IconButton><IconButton label="Start video call" disabled={disabled} onClick={()=>void controller?.start(channel,'video')}><VideoCamera size={21}/></IconButton></>;
}
function Media({stream,local=false,label}:{stream:MediaStream|null;local?:boolean;label:string}){
 const ref=useRef<HTMLVideoElement>(null),[blocked,setBlocked]=useState(false);
 useEffect(()=>{
  const element=ref.current;if(!element)return;
  let active=true;element.srcObject=stream;
  if(stream)void element.play().then(()=>{if(active)setBlocked(false);}).catch(()=>{if(active)setBlocked(true);});
  return()=>{active=false;element.srcObject=null;};
 },[stream]);
 return <div className={`call-media${local?' call-media--local':''}`}><video ref={ref} autoPlay playsInline muted={local} aria-label={label}/><span>{label}</span>{blocked&&!local&&<Button onClick={()=>void ref.current?.play().then(()=>setBlocked(false)).catch(()=>{})}>Play call audio</Button>}</div>;
}
function CallPanel({controller:c,view:v}:{controller:CallController;view:CallView}){
 const [minimized,setMinimized]=useState(false),[settings,setSettings]=useState(false);
 const call=v.call,incoming=call?.state==='ringing'&&call.callee_id===c.actor;
 const owned=c.selected(),active=call?.state==='accepted'&&owned,ended=call?.state==='ended';
 useEffect(()=>{setMinimized(false);setSettings(false);},[call?.id,v.preview?.kind]);
 if(!call&&!v.preview&&!v.error&&!v.busy)return null;
 const name=call?(call.caller_id===c.actor?call.callee_name:call.caller_name):'Camera preview';
 return <section className={`call-panel${minimized?' call-panel--minimized':''}`} aria-label="Call" aria-busy={v.busy}>
  <header><div><strong>{name}</strong><p role="status">{v.preview?'Your camera is only visible to you':v.busy&&!call?'Preparing your call…':v.status}</p></div>
   {call&&!ended&&!incoming&&!v.preview&&<IconButton label={minimized?'Expand call':'Minimize call'} onClick={()=>setMinimized(!minimized)}>{minimized?<CaretUp size={20}/>:<CaretDown size={20}/>}</IconButton>}
   {(ended||(!call&&!v.preview&&!v.busy))&&<IconButton label="Dismiss call" onClick={()=>c.dismiss()}><X size={20}/></IconButton>}
  </header>
  {v.error&&<p className="call-error" role="alert">{v.error}</p>}
  <div hidden={minimized}>
   {(v.preview||active)&&<div className="call-videos">
    {active&&<Media stream={v.remote} label={name}/>}
    {v.camera&&<Media stream={v.local} local label="You"/>}
    {!v.camera&&active&&<span className="call-camera-off"><VideoCameraSlash size={20}/> Your camera is off</span>}
   </div>}
   {incoming&&!v.preview&&<p className="call-invitation">{call.mode==='video'?'Incoming video call':'Incoming voice call'}</p>}
   {v.preview&&<div className="call-actions"><Button disabled={v.busy} onClick={()=>void c.confirmPreview()}>{v.preview.kind==='start'?'Start video call':'Answer with video'}</Button><Button variant="secondary" disabled={v.busy} onClick={()=>c.cancelPreview()}>Cancel preview</Button></div>}
   {incoming&&!v.preview&&<div className="call-actions"><Button disabled={v.busy||!v.online} onClick={()=>void c.answer(false)}>Answer with audio</Button>{call.mode==='video'&&<Button variant="secondary" disabled={v.busy||!v.online} onClick={()=>void c.answer(true)}>Preview camera</Button>}<Button variant="danger" onClick={()=>void c.hangup()}>Decline</Button></div>}
   {active&&<div className="call-actions">
    <IconButton label={v.muted?'Unmute microphone':'Mute microphone'} aria-pressed={v.muted} onClick={()=>c.mute()}>{v.muted?<MicrophoneSlash size={22}/>:<Microphone size={22}/>}</IconButton>
    <IconButton label={v.camera?'Turn camera off':'Turn camera on'} aria-pressed={v.camera} disabled={v.busy} onClick={()=>void c.camera()}>{v.camera?<VideoCamera size={22}/>:<VideoCameraSlash size={22}/>}</IconButton>
    <Button variant="secondary" size="sm" onClick={()=>setSettings(!settings)} aria-expanded={settings}>Devices</Button>
   </div>}
   {settings&&active&&<div className="call-devices">{(['audio','video'] as const).map(kind=><label key={kind}>{kind==='audio'?'Microphone':'Camera'}<Select aria-label={kind==='audio'?'Microphone device':'Camera device'} disabled={v.busy||(kind==='video'&&!v.camera)} value={v.local?.getTracks().find(t=>t.kind===kind)?.getSettings().deviceId??''} onChange={e=>void c.changeDevice(kind,e.target.value)}><option value="">System default</option>{v.devices.filter(d=>d.kind===`${kind}input`).map((d,i)=><option key={d.deviceId} value={d.deviceId}>{d.label||`${kind==='audio'?'Microphone':'Camera'} ${i+1}`}</option>)}</Select></label>)}</div>}
  </div>
  {call&&!ended&&owned&&!v.preview&&<div className="call-actions"><Button variant="danger" onClick={()=>void c.hangup()}><PhoneDisconnect size={19}/> {call.state==='ringing'?'Cancel call':'Hang up'}</Button></div>}
 </section>;
}
