import { useEffect, useRef, useState } from 'react';
import type { AnimationItem } from 'lottie-web';
import { SpaceLogo } from './SpaceLogo.js';

export function AnimatedSpaceLogo({ theme }: { theme: 'light' | 'dark' }) {
  const container = useRef<HTMLSpanElement>(null);
  const player = useRef<AnimationItem | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!window.matchMedia || typeof SVGGeometryElement === 'undefined') return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    function updatePlayback() {
      const animation = player.current;
      if (!animation?.isLoaded) return;
      if (reduced.matches) animation.goToAndStop(animation.totalFrames - 1, true);
      else animation.goToAndPlay(0, true);
      setReady(true);
    }
    void import('lottie-web/build/player/lottie_light.js').then(({ default: lottie }) => {
      if (disposed || !container.current) return;
      player.current = lottie.loadAnimation({
        container: container.current,
        renderer: 'svg',
        path: '/brand/space-logo-motion.json',
        rendererSettings: { viewBoxSize: '18.75 30 507.5 125' },
        autoplay: false,
        loop: false,
      });
      player.current.addEventListener('DOMLoaded', updatePlayback);
    }).catch(() => { /* The static wordmark stays visible if the player cannot load. */ });
    reduced.addEventListener('change', updatePlayback);
    return () => {
      disposed = true;
      reduced.removeEventListener('change', updatePlayback);
      player.current?.destroy();
      player.current = null;
    };
  }, []);

  useEffect(() => {
    if (player.current?.isLoaded && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      player.current.goToAndPlay(0, true);
    }
  }, [theme]);

  return <span className="space-logo space-logo--animated" aria-hidden="true">
    {!ready && <SpaceLogo inverse />}
    <span className="space-logo-player space-logo--inverse" ref={container} style={{ visibility: ready ? 'visible' : 'hidden' }} />
  </span>;
}
