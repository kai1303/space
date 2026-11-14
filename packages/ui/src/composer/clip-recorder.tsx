import { useEffect, useRef, useState } from 'react';
import { Check, Microphone, Stop, VideoCamera, XCircle } from '@phosphor-icons/react';
import { MAX_ASSET_BYTES } from '@space/contracts';
import { Button, Dialog, IconButton } from '../primitives/primitives.js';

import { VoiceWaveform } from './voice-waveform.js';

const audioFormats = [
  { mime: 'audio/webm', extension: 'weba' },
  { mime: 'audio/mp4', extension: 'm4a' },
  { mime: 'audio/ogg', extension: 'ogg' },
];
const videoFormats = [
  { mime: 'video/webm', extension: 'webm' },
  { mime: 'video/mp4', extension: 'mp4' },
];
const maxSeconds = 300;

export function ClipRecorder({ kind, disabled, onAttach }: { kind: 'audio' | 'video'; disabled: boolean; onAttach: (file: File) => void }) {
  const video = kind === 'video';
  const title = video ? 'Video clip' : 'Audio clip';
  const devices = video ? 'camera and microphone' : 'microphone';
  const formats = video ? videoFormats : audioFormats;
  const [camera, setCamera] = useState<MediaStream>();
  const live = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = live.current;
    if (!element || !camera) return;
    element.srcObject = camera;
    return () => { element.srcObject = null; };
  }, [camera]);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'ready' | 'recording' | 'finishing' | 'review' | 'error'>('idle');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<{ file: File; url: string }>();
  const generation = useRef(0);
  const release = useRef<() => void>(() => {});
  const clock = useRef<ReturnType<typeof setInterval>>(undefined);
  const deadline = useRef<ReturnType<typeof setTimeout>>(undefined);
  const recorder = useRef<MediaRecorder | null>(null);

  function dispose() {
    generation.current++;
    clearInterval(clock.current);
    clearTimeout(deadline.current);
    release.current();
    release.current = () => {};
    recorder.current = null;
  }
  useEffect(() => dispose, []);
  function close() {
    dispose();
    setClip(undefined);
    setCamera(undefined);
    setPhase('idle');
  }
  function fail(message: string) {
    dispose();
    setCamera(undefined);
    setError(message);
    setPhase('error');
  }
  function stop() {
    if (recorder.current?.state === 'recording') {
      setPhase('finishing');
      recorder.current.stop();
    }
  }
  function record() {
    const rec = recorder.current;
    if (!rec || rec.state !== 'inactive') return;
    try {
      rec.start(1000);
      const started = performance.now();
      clock.current = setInterval(() => setSeconds(Math.min(maxSeconds, Math.floor((performance.now() - started) / 1000))), 1000);
      deadline.current = setTimeout(stop, maxSeconds * 1000);
      setPhase('recording');
    } catch {
      fail(`Couldn’t start recording. Check your ${devices} and try again.`);
    }
  }
  async function start() {
    dispose();
    const run = generation.current;
    setClip(undefined);
    setSeconds(0);
    setPhase('starting');
    const format = typeof MediaRecorder !== 'undefined' && formats.find(item => MediaRecorder.isTypeSupported(item.mime));
    if (!navigator.mediaDevices?.getUserMedia || !format) {
      fail(`${title} recording requires ${devices} support and a secure connection.`);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: video && { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } } });
      const releaseTracks = () => stream.getTracks().forEach(track => track.stop());
      if (run !== generation.current) { releaseTracks(); return; }
      release.current = releaseTracks;
      const rec = new MediaRecorder(stream, { mimeType: format.mime, audioBitsPerSecond: video ? 64000 : 96000, ...(video && { videoBitsPerSecond: 550000 }) });
      recorder.current = rec;
      const chunks: Blob[] = [];
      let bytes = 0;
      release.current = () => {
        rec.onstop = rec.onerror = rec.ondataavailable = null;
        if (rec.state === 'recording') rec.stop();
        releaseTracks();
      };
      rec.onerror = () => fail(`Recording failed. Check your ${devices} and try again.`);
      rec.ondataavailable = ({ data }) => {
        bytes += data.size;
        if (bytes > MAX_ASSET_BYTES) fail('This clip exceeds the upload limit. Record a shorter clip.');
        else if (data.size) chunks.push(data);
      };
      rec.onstop = () => {
        dispose();
        setCamera(undefined);
        if (!bytes) { fail('The clip is empty. Try recording again.'); return; }
        const file = new File(chunks, title + '.' + format.extension, { type: format.mime });
        const url = URL.createObjectURL(file);
        release.current = () => URL.revokeObjectURL(url);
        setClip({ file, url });
        setPhase('review');
      };
      if (video) {
        setCamera(stream);
        setPhase('ready');
      } else record();
    } catch (reason) {
      if (run === generation.current) fail(reason instanceof DOMException && reason.name === 'NotAllowedError'
        ? `Access was denied. Allow ${devices} access for Space and try again.`
        : `Couldn’t start recording. Check your ${devices} and try again.`);
    }
  }

  const compact = !video && phase === 'recording';
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <>
    <IconButton size="sm" label={`Record ${kind} clip`} disabled={disabled} onClick={() => void start()}>{video ? <VideoCamera size={18}/> : <Microphone size={18}/>}</IconButton>
    {phase !== 'idle' && <Dialog open title={title} onClose={close} closeOnBackdrop={!compact}>
      {compact ? <div className="sp-voice-strip" data-warning={seconds >= maxSeconds - 10 || undefined}>
        <VoiceWaveform stream={recorder.current?.stream}/>
        <time aria-label="Recording duration">{elapsed}</time>
        <IconButton label="Cancel recording" onClick={close} className="sp-voice-cancel"><XCircle size={28} weight="fill"/></IconButton>
        <IconButton autoFocus label="Finish recording" onClick={stop} className="sp-voice-finish"><Check size={18} weight="bold"/></IconButton>
      </div> :
      <div className="sp-clip-recorder">
        {phase === 'starting' && <p role="status">Waiting for {devices}…</p>}
        {camera && <video ref={live} muted autoPlay playsInline aria-label="Live camera preview"/>}
        {phase === 'recording' && <p><strong role="status">Recording</strong> <time>{elapsed}</time> / 5:00</p>}
        {phase === 'finishing' && <p role="status">Preparing clip…</p>}
        {phase === 'error' && <p role="alert">{error}</p>}
        {clip && (video ? <video controls playsInline preload="metadata" src={clip.url} aria-label="Preview video clip"/> : <audio controls preload="metadata" src={clip.url} aria-label="Preview audio clip"/>)}
        <div className="sp-draft-dialog-actions">
          <Button onClick={close}>{clip ? 'Discard' : 'Cancel'}</Button>
          {phase === 'ready' && <Button variant="primary" disabled={disabled} onClick={record}><VideoCamera size={16}/> Record</Button>}
          {phase === 'recording' && <Button variant="primary" onClick={stop}><Stop size={16} weight="fill"/> Stop recording</Button>}
          {phase === 'error' && <Button onClick={() => void start()}>Try again</Button>}
          {clip && <Button variant="primary" disabled={disabled} onClick={() => { onAttach(clip.file); close(); }}>Attach to message</Button>}
        </div>
      </div>}
    </Dialog>}
  </>;
}
