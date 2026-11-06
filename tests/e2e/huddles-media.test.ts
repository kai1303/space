import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Room,RoomEvent,AudioSource,AudioFrame,AudioStream,LocalAudioTrack,TrackPublishOptions,TrackSource,VideoSource,VideoFrame,VideoStream,VideoBufferType,LocalVideoTrack,dispose} from '@livekit/rtc-node';
import {huddleMedia} from '@space/server/huddle-media';

test('three participants receive synthetic audio, camera and screen tracks; closed room rejects its old token',{skip:!process.env.LIVEKIT_URL,timeout:45000},async()=>{
 const media=huddleMedia()!,id=randomUUID(),rooms=[new Room(),new Room(),new Room()];
 const audio=new AudioSource(48000,1),camera=new VideoSource(320,180),screen=new VideoSource(320,180);
 const readers:{cancel():Promise<void>}[]=[];
 const timeout=<T>(promise:Promise<T>,ms=10000)=>new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Media deadline exceeded')),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
 try{
  await media.create(id);const tokens=await Promise.all(rooms.map((_,i)=>media.token(id,randomUUID(),`Synthetic member ${i+1}`)));
  await Promise.all(rooms.map((room,i)=>room.connect(media.url,tokens[i]!,{autoSubscribe:true,dynacast:true})));
  const received=rooms.slice(1).map(room=>new Promise<void>((resolve,reject)=>{
   const sources=new Set<TrackSource>();
   room.on(RoomEvent.TrackSubscribed,(track,publication)=>{void (async()=>{
    if(publication.source===TrackSource.SOURCE_MICROPHONE){const reader=new AudioStream(track).getReader();readers.push(reader);let audible=false;
     for(let i=0;i<200&&!audible;i++){const frame=await reader.read();if(frame.done)break;audible=frame.value.data.some(value=>Math.abs(value)>10);}
     assert.ok(audible,'receiver gets non-silent synthetic audio');
    }else{const reader=new VideoStream(track).getReader();readers.push(reader);const frame=await reader.read();assert.equal(frame.value?.frame.width,320);}
    assert.notEqual(publication.source,undefined);sources.add(publication.source!);if(sources.size===3)resolve();
   })().catch(reject);});
  }));
  const audioTrack=LocalAudioTrack.createAudioTrack('synthetic-audio',audio);
  const cameraTrack=LocalVideoTrack.createVideoTrack('synthetic-camera',camera),screenTrack=LocalVideoTrack.createVideoTrack('synthetic-screen',screen);
  for(const [track,source] of [[audioTrack,TrackSource.SOURCE_MICROPHONE],[cameraTrack,TrackSource.SOURCE_CAMERA],[screenTrack,TrackSource.SOURCE_SCREENSHARE]] as const){const options=new TrackPublishOptions();options.source=source;await rooms[0]!.localParticipant!.publishTrack(track,options);}
  const pixels=new Uint8Array(320*180*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=140;pixels[i+1]=70;pixels[i+2]=220;pixels[i+3]=255;}
  const video=new VideoFrame(pixels,320,180,VideoBufferType.RGBA);
  const playback=(async()=>{for(let n=0;n<150;n++){
   const samples=Int16Array.from({length:960},(_,i)=>Math.round(7000*Math.sin(2*Math.PI*440*(n*960+i)/48000)));
   await audio.captureFrame(new AudioFrame(samples,48000,1,960));if(n%3===0){camera.captureFrame(video);screen.captureFrame(video);}
  }await audio.waitForPlayout();})();
  await timeout(Promise.all([...received,playback]));
  await media.remove(id);assert.equal(await media.exists(id),false);
  const stale=new Room();try{await assert.rejects(stale.connect(media.url,tokens[0]!,{autoSubscribe:true,dynacast:true}));}finally{await stale.disconnect();}
 }finally{
  await Promise.allSettled(readers.map(reader=>reader.cancel()));
  await Promise.allSettled(rooms.map(room=>room.disconnect()));await Promise.all([audio.close(),camera.close(),screen.close()]);
  await media.remove(id);await dispose();
 }
});
