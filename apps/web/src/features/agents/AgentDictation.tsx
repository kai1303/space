import { useEffect, useRef, useState } from 'react';
import { Check, Microphone, X } from '@phosphor-icons/react';
import { IconButton } from '@space/ui/primitives';
import type { DictationUpdate } from './dictation.worker.js';

type Phase = 'idle'|'starting'|'recording'|'loading'|'transcribing'|'error';
const maxSeconds = 60;
const sampleRate = 16000;

export function AgentDictation({ insert, disabled, onBusy }: {
  insert:(text:string)=>void; disabled:boolean; onBusy:(busy:boolean)=>void;
}) {
  const [phase,setPhase] = useState<Phase>('idle');
  const [seconds,setSeconds] = useState(0);
  const [status,setStatus] = useState('');
  const root = useRef<HTMLSpanElement>(null);
  const stop = useRef<()=>void>(()=>{});
  const generation = useRef(0);
  const release = useRef<()=>void>(()=>{});
  const worker = useRef<Worker | null>(null);
  const recording = useRef<Blob | null>(null);
  const callbacks = useRef({insert,onBusy});
  callbacks.current={insert,onBusy};

  function dispose() {
    generation.current++;
    release.current();release.current=()=>{};
    worker.current?.terminate();worker.current=null;
    callbacks.current.onBusy(false);
  }
  function cancel() { dispose();recording.current=null;setPhase('idle');setStatus(''); }
  function fail(message:string) { dispose();setPhase('error');setStatus(message); }

  useEffect(()=>{
    const hide=()=>{if(document.hidden || root.current?.closest('[hidden],[inert]')) cancel();};
    document.addEventListener('visibilitychange',hide);
    // Space can retain an open session while hiding its panel.
    const observer=new MutationObserver(hide);
    for(let el:HTMLElement | null=root.current;el;el=el.parentElement) observer.observe(el,{attributes:true,attributeFilter:['hidden','inert']});
    return ()=>{observer.disconnect();document.removeEventListener('visibilitychange',hide);dispose();};
  },[]);

  async function transcribe(blob:Blob) {
    const run=++generation.current;
    callbacks.current.onBusy(true);setPhase('loading');setStatus('Preparing audio…');
    try {
      const context=new OfflineAudioContext(1,1,sampleRate);
      const decoded=await context.decodeAudioData(await blob.arrayBuffer());
      if(run!==generation.current) return;
      const samples=decoded.getChannelData(0).slice(0,maxSeconds*sampleRate);
      if(samples.length<sampleRate/4 || !samples.some(sample=>Math.abs(sample)>.002)) {
        recording.current=null;fail('No speech detected. Try dictating again.');return;
      }
      const engine=new Worker(new URL('./dictation.worker.ts',import.meta.url),{type:'module'});
      worker.current=engine;
      const deadline=setTimeout(()=>{if(run===generation.current) fail('Transcription timed out. Retry or cancel.');},300000);
      release.current=()=>clearTimeout(deadline);
      engine.onerror=()=>{if(run===generation.current) fail('Couldn’t start transcription. Retry or cancel.');};
      engine.onmessage=({data}:MessageEvent<DictationUpdate>)=>{
        if(run!==generation.current) return;
        if(data.phase==='error') { fail(data.message);return; }
        if(data.phase==='done') {
          if(!data.text){recording.current=null;fail('No speech detected. Try dictating again.');return;}
          const text=data.text;cancel();callbacks.current.insert(text);return;
        }
        setPhase(data.phase);
        setStatus(data.phase==='transcribing' ? 'Transcribing…' : 'Loading speech model'+(data.percent===undefined?'…':` · ${data.percent}%`));
      };
      engine.postMessage(samples,[samples.buffer]);
    } catch { if(run===generation.current) fail('Couldn’t read this recording. Try again or cancel.'); }
  }

  async function start() {
    if(disabled) return;
    if(!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder==='undefined' || typeof OfflineAudioContext==='undefined'){
      fail('Dictation needs microphone support and a secure connection.');return;
    }
    const run=++generation.current;
    callbacks.current.onBusy(true);setPhase('starting');setStatus('Waiting for microphone…');setSeconds(0);
    let stream:MediaStream | undefined;
    try {
      stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1},video:false});
      if(run!==generation.current){stream.getTracks().forEach(t=>t.stop());return;}
      const rec=new MediaRecorder(stream);
      const chunks:Blob[]=[];
      const began=performance.now();
      const tick=setInterval(()=>setSeconds(Math.min(maxSeconds,Math.floor((performance.now()-began)/1000))),1000);
      stop.current=()=>{if(rec.state==='recording'){setPhase('loading');setStatus('Preparing audio…');rec.stop();}};
      const deadline=setTimeout(()=>stop.current(),maxSeconds*1000);
      release.current=()=>{
        clearInterval(tick);clearTimeout(deadline);
        rec.onstop=null;rec.ondataavailable=null;rec.onerror=null;
        if(rec.state==='recording') rec.stop();
        stream?.getTracks().forEach(t=>t.stop());
      };
      rec.ondataavailable=e=>{if(e.data.size) chunks.push(e.data);};
      rec.onerror=()=>{if(run===generation.current) fail('Recording failed. Check your microphone and try again.');};
      rec.onstop=()=>{
        if(run!==generation.current) return;
        release.current();release.current=()=>{};
        const blob=new Blob(chunks,{type:rec.mimeType});
        if(!blob.size){fail('No audio was recorded. Try again.');return;}
        recording.current=blob;void transcribe(blob);
      };
      rec.start(1000);setPhase('recording');
    } catch(error) {
      stream?.getTracks().forEach(t=>t.stop());
      if(run===generation.current) fail(error instanceof DOMException && error.name==='NotAllowedError'
        ? 'Microphone access was denied. Allow it in your device settings, then try again.' : 'Couldn’t open the microphone. Check the input device and try again.');
    }
  }
  return <span className="agent-dictation" ref={root} onKeyDown={event=>{if(event.key==='Escape' && phase!=='idle'){event.preventDefault();cancel();}}}>
    {phase==='idle' ? <IconButton size="sm" label="Dictate" title="Dictate" disabled={disabled} onClick={()=>void start()}><Microphone size={17}/></IconButton>
    : <>
      <span className="agent-dictation-status" role={phase==='error'?'alert':'status'}>{phase==='recording' ? 'Recording' : status}</span>
      {phase==='recording' && <><span className="agent-dictation-time" aria-label="Recording duration">{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</span><IconButton size="sm" label="Finish dictation" onClick={()=>stop.current()}><Check/></IconButton></>}
      {phase==='error' && <button type="button" onClick={()=>recording.current ? void transcribe(recording.current) : void start()}>Retry</button>}
      <IconButton size="sm" label="Cancel dictation" onClick={cancel}><X/></IconButton>
    </>}
  </span>;
}
