import { useEffect, useRef, useState } from 'react';
import { DownloadSimple, Eye, Pause, Play } from '@phosphor-icons/react';
import { IconButton } from '@space/ui/primitives';
import { sessionFetch } from '../../shared/api/session-fetch.js';

const barCount = 40;
type Waveform = { bars: number[]; duration: number };
const waveforms = new Map<string, Waveform>();
// Decode one visible clip at a time. Keep only its small display summary.
let decoding = Promise.resolve();

async function readWaveform(src: string, signal: AbortSignal) {
  const response = await sessionFetch(src, { signal });
  if (!response.ok) throw new Error('Clip unavailable');
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  const context = new OfflineAudioContext(1, 1, 8000);
  const audio = await context.decodeAudioData(bytes);
  signal.throwIfAborted();
  const samples = audio.getChannelData(0);
  const bars = Array.from({ length: barCount }, (_, i) => {
    const start = Math.floor(samples.length * i / barCount);
    const end = Math.floor(samples.length * (i + 1) / barCount);
    let energy = 0;
    for (let j = start; j < end; j++) energy += samples[j]! ** 2;
    return Math.sqrt(energy / Math.max(1, end - start));
  });
  const peak = Math.max(.01, ...bars);
  return { duration: audio.duration, bars: bars.map(value => value / peak) };
}

function timestamp(seconds: number) {
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}

export function VoiceClipPlayer({ src, name, download, onOpen, onError }: {
  src: string; name: string; download: string; onOpen: (element: HTMLElement) => void; onError: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [wave, setWave] = useState(() => waveforms.get(src));
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const duration = wave?.duration ?? mediaDuration;
  useEffect(() => {
    if (waveforms.has(src)) { setWave(waveforms.get(src)); return; }
    if (typeof OfflineAudioContext === 'undefined') return;
    const controller = new AbortController();
    const { signal } = controller;
    function load() {
      decoding = decoding.then(async () => {
        signal.throwIfAborted();
        const result = waveforms.get(src) ?? await readWaveform(src, signal);
        if (waveforms.size >= 128) waveforms.delete(waveforms.keys().next().value!);
        waveforms.set(src, result);
        setWave(result);
      }).catch(() => { /* The native media element can still play when analysis is unavailable. */ });
    }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load(); }
    });
    if (observer && root.current) observer.observe(root.current);
    else load();
    return () => { controller.abort(); observer?.disconnect(); };
  }, [src]);

  function seek(seconds: number) {
    if (!audio.current || !duration) return;
    audio.current.currentTime = Math.max(0, Math.min(seconds, duration));
    setElapsed(audio.current.currentTime);
  }
  function toggle() {
    const player = audio.current;
    if (!player) return;
    if (player.paused) void player.play().catch(error => { if (error.name !== 'AbortError') onError(); });
    else player.pause();
  }
  return <div ref={root} className="asset-card voice-clip-player" role="group" aria-label="Voice clip">
    <audio ref={audio} src={src} preload="metadata" aria-label={name} onError={onError}
      onPlay={() => setPlaying(true)} onPause={event => { setPlaying(false); setElapsed(event.currentTarget.ended ? 0 : event.currentTarget.currentTime); }} onEnded={() => { setPlaying(false); setElapsed(0); }}
      onTimeUpdate={event => setElapsed(event.currentTarget.ended ? 0 : event.currentTarget.currentTime)}
      onDurationChange={event => { if (Number.isFinite(event.currentTarget.duration)) setMediaDuration(event.currentTarget.duration); }}/>
    <IconButton className="voice-clip-toggle" label={playing ? 'Pause voice clip' : 'Play voice clip'} onClick={toggle}>
      {playing ? <Pause weight="fill" size={18}/> : <Play weight="fill" size={18}/>}
    </IconButton>
    <div className="voice-clip-scrubber">
      <div className="voice-clip-bars" aria-hidden="true">
        {Array.from({ length: barCount }, (_, i) => <i key={i} style={{ height: 4 + 28 * (wave?.bars[i] ?? 0) }}
          data-played={duration > 0 && elapsed / duration > i / barCount || undefined}/>)}
      </div>
      <input type="range" aria-label="Seek voice clip" min={0} max={duration || 1} step="any" value={Math.min(elapsed, duration)}
        aria-valuetext={timestamp(elapsed) + ' of ' + timestamp(duration)} disabled={!duration}
        onChange={event => seek(event.target.valueAsNumber)}
        onKeyDown={event => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          event.preventDefault();
          seek((audio.current?.currentTime ?? 0) + (event.key === 'ArrowRight' ? 1 : -1));
        }}/>
    </div>
    <time aria-label={duration ? "Duration " + timestamp(duration) : "Loading duration"}>{duration ? timestamp(duration) : "–:––"}</time>
    <div className="voice-clip-actions">
      <IconButton size="sm" label={'Preview ' + name} onClick={event => { audio.current?.pause(); onOpen(event.currentTarget); }}><Eye size={16}/></IconButton>
      <a href={download} aria-label={'Download ' + name} title={'Download ' + name}><DownloadSimple size={16}/></a>
    </div>
  </div>;
}
