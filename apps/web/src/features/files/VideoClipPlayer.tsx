import { useEffect, useRef, useState } from 'react';
import { Play } from '@phosphor-icons/react';

export function VideoClipPlayer({ src, name, onError }: { src: string; name: string; onError: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const probingEnd = useRef(false);
  const [duration, setDuration] = useState(0);
  const [active, setActive] = useState(false);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (visible || !video.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(video.current);
    return () => observer.disconnect();
  }, [visible]);

  function readDuration(player: HTMLVideoElement) {
    if (Number.isFinite(player.duration) && player.duration > 0) setDuration(player.duration);
  }

  return <div className="video-clip-player" role="group" aria-label="Video clip">
    <video ref={video} src={visible ? src + '#t=0.1' : undefined} preload="metadata" playsInline controls={active} aria-label={name}
      onError={onError} onDurationChange={event => readDuration(event.currentTarget)}
      onLoadedMetadata={event => {
        const player = event.currentTarget;
        readDuration(player);
        // MediaRecorder WebM files can omit the duration. Seeking to the end lets the demuxer discover it.
        if (player.duration === Infinity && !active) {
          probingEnd.current = true;
          player.currentTime = Number.MAX_SAFE_INTEGER;
        }
      }}
      onSeeked={event => {
        if (!probingEnd.current) return;
        probingEnd.current = false;
        const player = event.currentTarget;
        readDuration(player);
        if (!active) player.currentTime = Math.min(0.1, player.duration / 2);
      }}
      onEnded={event => { setActive(false); event.currentTarget.currentTime = Math.min(0.1, duration / 2); }}/>
    {!active && <button type="button" className="video-clip-cover" aria-label="Play video clip" onClick={() => {
      const player = video.current;
      if (!player) return;
      if (!visible) {
        setVisible(true);
        player.src = src + '#t=0.1';
      }
      probingEnd.current = false;
      player.currentTime = 0;
      setActive(true);
      void player.play().then(() => player.focus()).catch(error => {
        if (error.name !== 'AbortError') onError();
        else setActive(false);
      });
    }}>
      <span className="video-clip-pill"><Play size={16} weight="fill" aria-hidden="true"/>
        {duration > 0 && <time aria-label="Clip duration">{Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, '0')}</time>}
      </span>
    </button>}
  </div>;
}
