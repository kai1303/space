// @vitest-environment jsdom
import {test,expect,vi,afterEach} from 'vitest';
import type {CallSignal} from '@space/contracts';
import {CallPeer} from './peer.js';
const makeTrack=(kind:string)=>({kind,enabled:true,stop:vi.fn()}) as unknown as MediaStreamTrack;
class Stream {tracks:MediaStreamTrack[]=[];getTracks(){return this.tracks;}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}addTrack(t:MediaStreamTrack){this.tracks.push(t);}removeTrack(t:MediaStreamTrack){this.tracks=this.tracks.filter(x=>x!==t);}}
class PC {
 static last:PC;signalingState='stable';connectionState='new';localDescription:any;remoteDescription:any;onicecandidate:any;ontrack:any;onnegotiationneeded:any;onconnectionstatechange:any;
 senders:any[]=[];close=vi.fn();restartIce=vi.fn();addIceCandidate=vi.fn(async()=>{});
 constructor(){PC.last=this;}
 addTransceiver(track:any,options:any){const sender={kind:typeof track==='string'?track:track.kind,setStreams:vi.fn(),track:typeof track==='string'?null:track,replaceTrack:vi.fn(async(t:any)=>{sender.track=t;})};this.senders.push(sender);return {sender};}
 getTransceivers(){return this.senders.map(sender=>({sender,receiver:{track:{kind:sender.kind}},direction:'sendrecv'}));}
 async setLocalDescription(){this.localDescription={type:this.signalingState==='have-remote-offer'?'answer':'offer',sdp:'v=0'};this.signalingState=this.localDescription.type==='answer'?'stable':'have-local-offer';}
 async setRemoteDescription(d:any){if(d.type==='offer'&&!this.senders.length){this.addTransceiver('audio',{});this.addTransceiver('video',{});}this.remoteDescription=d;this.signalingState=d.type==='offer'?'have-remote-offer':'stable';}
}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function setup(polite=false){vi.stubGlobal('RTCPeerConnection',PC);vi.stubGlobal('MediaStream',Stream);const stream=new Stream();stream.addTrack(makeTrack('audio'));stream.addTrack(makeTrack('video'));const send=vi.fn(async(_signal:CallSignal)=>{});const error=vi.fn();const peer=new CallPeer('call',polite,stream as any,{iceServers:[],iceTransportPolicy:'all',hasTurn:false},send,vi.fn(),vi.fn(),error);return {peer,stream,send,error,pc:PC.last};}
test('closing stops all capture and releases the peer connection',()=>{const {peer,stream,pc}=setup();peer.close();peer.close();for(const track of stream.getTracks())expect(track.stop).toHaveBeenCalledTimes(1);expect(pc.close).toHaveBeenCalledTimes(1);});
test('ICE arriving before its offer is buffered and applied to that generation only',async()=>{
 const {peer,pc}=setup(true);const candidate={candidate:'candidate:1',sdpMid:'0',sdpMLineIndex:0,usernameFragment:'a'};
 await peer.receive({call_id:'call',generation:'g',candidate});expect(pc.addIceCandidate).not.toHaveBeenCalled();
 await peer.receive({call_id:'call',generation:'g',description:{type:'offer',sdp:'v=0'}});expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);
 peer.close();
});
test('candidate buffers are bounded',async()=>{const {peer}=setup();const candidate={candidate:'candidate:1',sdpMid:'0',sdpMLineIndex:0,usernameFragment:'a'};for(let i=0;i<128;i++)await peer.receive({call_id:'call',generation:'g',candidate});await expect(peer.receive({call_id:'call',generation:'g',candidate})).rejects.toThrow('Too many');peer.close();});
test('replacing a camera stops the old track without losing microphone mute',async()=>{const {peer,stream,pc}=setup();const old=stream.getVideoTracks()[0]!;const next=makeTrack('video');stream.getAudioTracks()[0]!.enabled=false;await peer.replace('video',next);expect(old.stop).toHaveBeenCalledTimes(1);expect(pc.senders[1].track).toBe(next);expect(stream.getAudioTracks()[0]!.enabled).toBe(false);peer.close();});
test('a disconnected peer gets a bounded recovery deadline',async()=>{vi.useFakeTimers();const {peer,pc,error}=setup();pc.connectionState='disconnected';pc.onconnectionstatechange();await vi.advanceTimersByTimeAsync(35000);expect(error).toHaveBeenCalled();peer.close();});
test('duplicate ready messages reuse the pending offer without rollback',async()=>{
 const {peer,send,pc}=setup();
 await peer.receive({call_id:'call',generation:'ready1',ready:true});
 const first=send.mock.calls.find(([s])=>s.description?.type==='offer')?.[0];
 await peer.receive({call_id:'call',generation:'ready2',ready:true});
 const offers=send.mock.calls.filter(([s])=>s.description?.type==='offer').map(([s])=>s);
 expect(offers).toHaveLength(2);expect(offers[1]?.generation).toBe(first?.generation);expect(pc.signalingState).toBe('have-local-offer');peer.close();
});
