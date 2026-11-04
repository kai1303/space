import type {CallIceConfig,CallMode,CallSignal,CallSession} from '@space/contracts';
import {acquireRealtime,type RealtimeLease} from '../../shared/realtime/socket-session.js';
import {socketCommand} from '../../shared/realtime/socket-command.js';
import {CallPeer} from './peer.js';

export type CallView={call:CallSession|null;local:MediaStream|null;remote:MediaStream|null;status:string;error:string;busy:boolean;online:boolean;muted:boolean;camera:boolean;devices:MediaDeviceInfo[];preview:null|{kind:'start';channel:string}|{kind:'answer';callId:string};hasTurn:boolean};
export const emptyCallView:CallView={call:null,local:null,remote:null,status:'',error:'',busy:false,online:false,muted:false,camera:false,devices:[],preview:null,hasTurn:false};
const friendly=(error:unknown)=>{
 const code=error instanceof Error?error.message:String(error);
 if(error instanceof DOMException&&['NotAllowedError','PermissionDeniedError'].includes(error.name))return 'Camera or microphone permission was denied. Allow access and try again.';
 if(error instanceof DOMException&&error.name==='NotFoundError')return 'No matching camera or microphone was found.';
 return ({call_busy:'You or this person are already in a call.',call_other_device:'This call was answered on another device.',call_unavailable:'This person is unavailable for calls.',call_ended:'This call has ended.',call_rate_limit:'Too many call requests. Please wait a moment.'} as Record<string,string>)[code]??code;
};
export class CallController {
 state:CallView={...emptyCallView};
 readonly device=crypto.randomUUID();
 private lease:RealtimeLease;
 private config:CallIceConfig|undefined;
 private peer:CallPeer|undefined;
 private disposed=false;
 private operation=0;
 private connecting=false;
 private reconnectPending=false;
 private credentialTimer:ReturnType<typeof setTimeout>|undefined;
 private heartbeat:ReturnType<typeof setTimeout>|undefined;
 private offlineDeadline:ReturnType<typeof setTimeout>|undefined;
 private pendingEnd:string|undefined;
 private signals:CallSignal[]=[];
 private recoveries=0;
 constructor(readonly actor:string,private changed:(state:CallView)=>void){
  this.lease=acquireRealtime();
  this.lease.on('connect',()=>{void this.sync();});
  this.lease.on('call.reconnect',()=>{void this.sync();});
  this.lease.on('call.state',value=>this.apply(value.call));
  this.lease.on('call.signal',(value:CallSignal)=>{
   if(this.peer&&this.peer.callId===value.call_id)void this.peer.receive(value).catch(e=>this.mediaFailed(e));
   else if(this.state.call?.id===value.call_id&&this.signals.length<128)this.signals.push(value);
  });
  this.lease.on('disconnect',()=>{
   this.patch({online:false,...(this.peer?{status:'Reconnecting…'}:{})});clearTimeout(this.heartbeat);clearTimeout(this.offlineDeadline);
   if(this.state.local)this.offlineDeadline=setTimeout(()=>this.mediaFailed(new Error('Connection to Space was lost.')),25000);
  });
  this.lease.on('session.revoked',()=>{this.operation++;this.clearMedia();this.patch({call:null,error:'Your session ended.',online:false,preview:null,busy:false});});
  this.lease.on('call.error',(value:{error:string})=>{if(this.peer)this.mediaFailed(new Error(value.error));else this.patch({error:friendly(new Error(value.error))});});
  navigator.mediaDevices?.addEventListener?.('devicechange',this.devices);
  if(this.lease.socket.connected)void this.sync();else this.lease.connect();
 }
 private patch(change:Partial<CallView>){if(this.disposed)return;this.state={...this.state,...change};this.changed(this.state);}
 private command<T>(name:string,input:object){return socketCommand<T>(this.lease.socket,name,input);}
 private async sync(){
  if(this.disposed||!this.lease.socket.connected)return;
  if(this.connecting){this.reconnectPending=true;return;}this.connecting=true;
  try{
   const reply=await this.command<{call:CallSession|null;config:CallIceConfig}>('call.subscribe',{device_id:this.device,...(this.state.call?{call_id:this.state.call.id}:{})});
   if(this.disposed)return;
   this.config=reply.config;this.peer?.configureIce(reply.config);this.scheduleCredentials();clearTimeout(this.offlineDeadline);this.patch({online:true,hasTurn:reply.config.hasTurn});
   if(this.pendingEnd){const id=this.pendingEnd;await this.command('call.end',{call_id:id});this.pendingEnd=undefined;}
   this.apply(reply.call);this.recoveries=0;
   if(this.peer){await this.peer.ready();this.pulse();}
  }catch(error){if(!this.disposed){this.patch({error:friendly(error),online:false});if(this.recoveries++<3)this.lease.recover();}}
  finally{this.connecting=false;if(this.reconnectPending){this.reconnectPending=false;void this.sync();}}
 }
 selected(call=this.state.call){return !!call?.selected;}
 private apply(call:CallSession|null){
  if(this.disposed)return;
  const old=this.state.call;
  if(old&&call?.id===old.id&&call.revision<old.revision)return;
  if(call&&call.state!=='ended'&&this.state.preview?.kind==='start'&&!this.selected(call)){this.operation++;this.clearMedia();this.patch({preview:null,busy:false});}
  if(!call||call.state==='ended'||(call.state==='accepted'&&!this.selected(call))){
   this.operation++;this.clearMedia();this.patch({preview:null,busy:false});
  }
  this.patch({call,status:!call?'':call.state==='ended'?({missed:'Missed call',declined:'Call declined',cancelled:'Call cancelled',failed:'Call disconnected',access_revoked:'Call ended — access changed',completed:'Call ended'}[call.reason!]??'Call ended'):call.state==='ringing'?(call.caller_id===this.actor?'Ringing…':'Incoming call'):this.selected(call)?this.peer?.pc.connectionState==='connected'?'Connected':'Connecting…':'Call in progress on another device'});
  if(call?.state==='accepted'&&this.selected(call)&&this.state.local&&!this.peer&&!this.pendingEnd){
   if(!this.config)return;
   this.peer=new CallPeer(call.id,call.callee_id===this.actor,this.state.local,this.config,
    signal=>this.command<void>('call.signal',signal).catch(error=>{if(this.lease.socket.connected&&!String(error).includes('Connection changed'))throw error;}),remote=>this.patch({remote}),status=>this.patch({status}),e=>this.mediaFailed(e));
   for(const signal of this.signals.splice(0))if(signal.call_id===call.id)void this.peer.receive(signal).catch(e=>this.mediaFailed(e));
   void this.peer.ready().catch(e=>this.mediaFailed(e));this.pulse();this.scheduleCredentials();
  }
 }
 private scheduleCredentials(attempt=0){
  clearTimeout(this.credentialTimer);
  if(!this.peer||!this.config?.expiresAt)return;
  this.credentialTimer=setTimeout(()=>{
   if(!this.peer)return;
   void this.command<CallIceConfig>('call.ice',{}).then(config=>{this.config=config;this.peer?.configureIce(config);this.scheduleCredentials();})
    .catch(error=>{if(attempt<2)this.scheduleCredentials(attempt+1);else this.mediaFailed(error);});
  },attempt?5000:Math.max(1000,this.config.expiresAt-Date.now()-300000));
 }
 private pulse(){
  clearTimeout(this.heartbeat);
  if(!this.peer||!this.state.online)return;
  // Presence heartbeat for this selected endpoint; this never reads or discovers calls.
  this.heartbeat=setTimeout(()=>{
   if(!this.peer)return;
   void this.command('call.heartbeat',{call_id:this.peer.callId}).then(()=>this.pulse()).catch(error=>{
    if(this.lease.socket.connected)this.mediaFailed(error);
   });
  },15000);
 }
 private clearMedia(){
  clearTimeout(this.credentialTimer);clearTimeout(this.heartbeat);clearTimeout(this.offlineDeadline);this.signals=[];
  if(this.peer){this.peer.close();this.peer=undefined;}else for(const track of this.state.local?.getTracks()??[])track.stop();
  this.patch({local:null,remote:null,camera:false,muted:false});
 }
 private mediaFailed(error:unknown){if(this.disposed)return;const message=friendly(error);void this.hangup(true).finally(()=>this.patch({error:message}));}
 private async capture(video:boolean,token:number){
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Calling requires HTTPS and a browser with camera/microphone support.');
  if(this.config?.expiresAt&&this.config.expiresAt<Date.now()+300000)this.config=await this.command<CallIceConfig>('call.ice',{});
  if(this.disposed||token!==this.operation)return false;
  const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:video?{width:{ideal:1280},height:{ideal:720}}:false});
  if(this.disposed||token!==this.operation){stream.getTracks().forEach(t=>t.stop());return false;}
  this.patch({local:stream,camera:video,muted:false});void this.devices();return true;
 }
 private devices=async()=>{try{const devices=await navigator.mediaDevices?.enumerateDevices();if(devices)this.patch({devices:devices.filter(d=>d.kind==='audioinput'||d.kind==='videoinput')});}catch{/* Capture errors are surfaced by the action. */}};
 async start(channel:string,mode:CallMode){
  if(this.state.busy||!this.state.online||(this.state.call&&this.state.call.state!=='ended'))return;
  const token=++this.operation;this.clearMedia();this.patch({call:null,busy:true,error:''});
  try{
   if(!await this.capture(mode==='video',token))return;
   if(mode==='video')this.patch({preview:{kind:'start',channel}});
   else await this.place(channel,mode,token);
  }catch(error){if(token===this.operation){this.clearMedia();this.patch({error:friendly(error)});}}
  finally{if(token===this.operation)this.patch({busy:false});}
 }
 private async place(channel:string,mode:CallMode,token:number){
  const id=crypto.randomUUID();
  const call=await this.command<CallSession>('call.start',{id,channel_id:channel,device_id:this.device,mode});
  if(this.disposed||token!==this.operation){void this.command('call.end',{call_id:id}).catch(()=>{});return;}
  this.patch({preview:null});this.apply(call);
 }
 async answer(video:boolean){
  const call=this.state.call;if(!call||call.state!=='ringing'||call.callee_id!==this.actor||this.state.busy)return;
  const token=++this.operation;this.clearMedia();this.patch({busy:true,error:''});
  try{
   if(!await this.capture(video,token))return;
   if(video)this.patch({preview:{kind:'answer',callId:call.id}});
   else await this.accept(call.id,token);
  }catch(error){if(token===this.operation){this.clearMedia();this.patch({error:friendly(error)});}}
  finally{if(token===this.operation)this.patch({busy:false});}
 }
 private async accept(id:string,token:number){
  const call=await this.command<CallSession>('call.accept',{call_id:id});
  if(this.disposed||token!==this.operation){void this.command('call.end',{call_id:id}).catch(()=>{});return;}
  this.patch({preview:null});this.apply(call);
 }
 async confirmPreview(){
  const preview=this.state.preview;if(!preview||this.state.busy)return;
  const token=this.operation;this.patch({busy:true,error:''});
  try{if(preview.kind==='start')await this.place(preview.channel,'video',token);else await this.accept(preview.callId,token);}
  catch(error){if(token===this.operation){this.clearMedia();this.patch({preview:null,error:friendly(error)});}}
  finally{if(token===this.operation)this.patch({busy:false});}
 }
 cancelPreview(){this.operation++;this.clearMedia();this.patch({preview:null,busy:false});}
 async hangup(failed=false){
  const call=this.state.call;this.operation++;this.clearMedia();this.patch({preview:null,busy:false});
  if(!call||call.state==='ended')return;
  this.pendingEnd=call.id;this.patch({status:'Ending call…'});
  try{const ended=await this.command<CallSession>('call.end',{call_id:call.id,failed});this.pendingEnd=undefined;this.apply(ended);}
  catch(error){this.patch({error:friendly(error)});if(this.lease.socket.connected)this.lease.recover();}
 }
 mute(){const muted=!this.state.muted;for(const track of this.state.local?.getAudioTracks()??[])track.enabled=!muted;this.patch({muted});}
 async camera(){if(this.state.camera)await this.replace('video',null);else await this.changeDevice('video');}
 async changeDevice(kind:'audio'|'video',deviceId?:string){
  if(this.state.busy||!this.state.local)return;
  const token=this.operation;this.patch({busy:true,error:''});
  let stream:MediaStream|undefined;
  try{
   stream=await navigator.mediaDevices.getUserMedia({audio:kind==='audio'?(deviceId?{deviceId:{exact:deviceId}}:true):false,video:kind==='video'?(deviceId?{deviceId:{exact:deviceId}}:true):false});
   if(this.disposed||token!==this.operation){stream.getTracks().forEach(t=>t.stop());return;}
   await this.replace(kind,stream.getTracks()[0]!);void this.devices();
  }catch(error){stream?.getTracks().forEach(t=>t.stop());if(token===this.operation)this.patch({error:friendly(error)});}
  finally{if(token===this.operation)this.patch({busy:false});}
 }
 private async replace(kind:'audio'|'video',track:MediaStreamTrack|null){
  if(track&&kind==='audio')track.enabled=!this.state.muted;
  if(this.peer)await this.peer.replace(kind,track);
  else{for(const old of this.state.local?.getTracks().filter(t=>t.kind===kind)??[]){this.state.local?.removeTrack(old);old.stop();}if(track)this.state.local?.addTrack(track);}
  this.patch({camera:!!this.state.local?.getVideoTracks().length});
 }
 dismiss(){if(this.state.call?.state==='ended')this.patch({call:null,status:'',error:''});else this.patch({error:''});}
 dispose(){
  if(this.disposed)return;
  const call=this.state.call;if(call&&call.state!=='ended'&&this.selected(call)&&this.lease.socket.connected)void this.command('call.end',{call_id:call.id}).catch(()=>{});
  this.operation++;this.clearMedia();this.disposed=true;navigator.mediaDevices?.removeEventListener?.('devicechange',this.devices);this.lease.release();
 }
}
