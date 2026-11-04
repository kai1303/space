import type {CallIceConfig,CallSignal} from '@space/contracts';

export class CallPeer {
 readonly pc:RTCPeerConnection;
 readonly remote=new MediaStream();
 private senders:Partial<Record<'audio'|'video',RTCRtpSender>>={};
 private closed=false;
 private localGeneration=crypto.randomUUID() as string;
 private remoteGeneration='';
 private candidates=new Map<string,RTCIceCandidateInit[]>();
 private candidateCount=0;
 private queued=0;
 private retired=new Set<string>();
 private readyGeneration='';
 private started=false;
 private chain:Promise<void>=Promise.resolve();
 private deadline:ReturnType<typeof setTimeout>|undefined;
 private restart:ReturnType<typeof setTimeout>|undefined;
 private restarts=0;
 constructor(readonly callId:string,readonly polite:boolean,readonly local:MediaStream,config:CallIceConfig,
  private send:(signal:CallSignal)=>Promise<void>,onRemote:(stream:MediaStream)=>void,
  private onStatus:(status:string)=>void,private onError:(error:unknown)=>void){
  this.pc=new RTCPeerConnection({iceServers:config.iceServers,iceTransportPolicy:config.iceTransportPolicy});
  if(!polite)this.senders={audio:this.pc.addTransceiver(local.getAudioTracks()[0]??'audio',{direction:'sendrecv',streams:[local]}).sender,
   video:this.pc.addTransceiver(local.getVideoTracks()[0]??'video',{direction:'sendrecv',streams:[local]}).sender};
  this.pc.ontrack=e=>{if(!this.remote.getTracks().some(t=>t.id===e.track.id))this.remote.addTrack(e.track);onRemote(this.remote);};
  this.pc.onicecandidate=e=>{
   if(!e.candidate||this.closed)return;
   void this.send({call_id:this.callId,generation:this.localGeneration,candidate:{...e.candidate.toJSON(),candidate:e.candidate.candidate,sdpMid:e.candidate.sdpMid,sdpMLineIndex:e.candidate.sdpMLineIndex,usernameFragment:e.candidate.usernameFragment}}).catch(this.onError);
  };
  this.pc.onnegotiationneeded=()=>{if(this.started&&!this.polite)void this.enqueue(()=>this.negotiate()).catch(this.onError);};
  this.pc.onconnectionstatechange=()=>{
   if(this.closed)return;
   const state=this.pc.connectionState;
   this.onStatus(state==='connected'?'Connected':state==='disconnected'?'Reconnecting…':'Connecting…');
   if(state==='connected'){clearTimeout(this.deadline);clearTimeout(this.restart);this.restart=undefined;}
   else if(state==='failed'||state==='disconnected'){
    this.armDeadline();
    if(!this.polite&&!this.restart&&this.restarts<2)this.restart=setTimeout(()=>{this.restart=undefined;this.restarts++;this.pc.restartIce();},state==='failed'?0:5000);
   }
  };
  this.armDeadline();
 }
 private armDeadline(){if(this.deadline)clearTimeout(this.deadline);this.deadline=setTimeout(()=>{if(!this.closed)this.onError(new Error('Could not connect the call. Try again.'));},30000);}
 private enqueue(action:()=>Promise<void>){
  if(this.queued>=256)return Promise.reject(new Error('Too many pending connection messages'));
  this.queued++;const next=this.chain.then(()=>{if(!this.closed)return action();}).finally(()=>{this.queued--;});this.chain=next.catch(()=>{});return next;
 }
 async ready(){if(!this.closed)await this.send({call_id:this.callId,generation:crypto.randomUUID(),ready:true});}
 private async negotiate(){
  if(this.closed||this.pc.signalingState!=='stable')return;
  this.localGeneration=crypto.randomUUID();await this.pc.setLocalDescription();
  if(!this.closed)await this.send({call_id:this.callId,generation:this.localGeneration,description:{type:'offer',sdp:this.pc.localDescription!.sdp}});
 }
 receive(signal:CallSignal):Promise<void>{return this.enqueue(async()=>{
  if(signal.call_id!==this.callId)return;
  if(signal.ready){
   if(this.polite){await this.ready();return;}
   if(this.readyGeneration===signal.generation&&this.started)return;
   this.readyGeneration=signal.generation;this.started=true;
   // Retry the same pending offer after signaling recovery; rollback would reorder unassociated transceivers.
   if(this.pc.signalingState==='have-local-offer'){
    await this.send({call_id:this.callId,generation:this.localGeneration,description:{type:'offer',sdp:this.pc.localDescription!.sdp}});return;
   }
   if(this.pc.connectionState==='connected')return;
   await this.negotiate();return;
  }
  if(signal.description){
   const d=signal.description;
   // The caller owns offers for the two fixed media slots; camera toggles use replaceTrack.
   if((d.type==='offer'&&!this.polite)||(d.type==='answer'&&this.polite))return;
   if(d.type==='answer'&&(signal.generation!==this.localGeneration||this.pc.signalingState!=='have-local-offer'))return;
   if(d.type==='offer'&&this.remoteGeneration===signal.generation&&this.pc.localDescription?.type==='answer'){
    await this.send({call_id:this.callId,generation:signal.generation,description:{type:'answer',sdp:this.pc.localDescription.sdp}});return;
   }
   await this.pc.setRemoteDescription(d);
   if(d.type==='offer')for(const kind of ['audio','video'] as const){
    const transceiver=this.pc.getTransceivers().find(t=>t.receiver.track.kind===kind);
    if(!transceiver)throw new Error('The remote call is missing a media track.');
    transceiver.direction='sendrecv';this.senders[kind]=transceiver.sender;
    await transceiver.sender.replaceTrack(this.local.getTracks().find(t=>t.kind===kind)??null);
    transceiver.sender.setStreams(this.local);
   }
   if(this.remoteGeneration&&this.remoteGeneration!==signal.generation){this.retired.add(this.remoteGeneration);if(this.retired.size>8)this.retired.delete(this.retired.values().next().value!);}
   this.remoteGeneration=signal.generation;
   for(const candidate of this.candidates.get(signal.generation)??[])await this.pc.addIceCandidate(candidate);
   this.candidates.clear();this.candidateCount=0;
   if(d.type==='offer'){
    this.started=true;this.localGeneration=signal.generation;await this.pc.setLocalDescription();
    await this.send({call_id:this.callId,generation:signal.generation,description:{type:'answer',sdp:this.pc.localDescription!.sdp}});
   }
  }else if(signal.candidate&&!this.retired.has(signal.generation)){
   if(this.remoteGeneration===signal.generation&&this.pc.remoteDescription)await this.pc.addIceCandidate(signal.candidate);
   else{if(this.candidateCount>=128||(!this.candidates.has(signal.generation)&&this.candidates.size>=2))throw new Error('Too many pending connection candidates');const pending=this.candidates.get(signal.generation)??[];pending.push(signal.candidate);this.candidates.set(signal.generation,pending);this.candidateCount++;}
  }
 });}
 configureIce(config:CallIceConfig){if(!this.closed)this.pc.setConfiguration({iceServers:config.iceServers,iceTransportPolicy:config.iceTransportPolicy});}
 async replace(kind:'audio'|'video',track:MediaStreamTrack|null){
  if(this.closed){track?.stop();return;}
  try{await this.senders[kind]?.replaceTrack(track);}catch(error){track?.stop();throw error;}
  if(this.closed){track?.stop();return;}
  for(const old of this.local.getTracks().filter(t=>t.kind===kind)){this.local.removeTrack(old);old.stop();}
  if(track)this.local.addTrack(track);
 }
 close(){
  if(this.closed)return;this.closed=true;clearTimeout(this.deadline);clearTimeout(this.restart);
  this.pc.onicecandidate=null;this.pc.ontrack=null;this.pc.onnegotiationneeded=null;this.pc.onconnectionstatechange=null;
  this.pc.close();for(const track of this.local.getTracks())track.stop();for(const track of this.remote.getTracks())track.stop();this.candidates.clear();
 }
}
