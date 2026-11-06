import { useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { Check, CircleNotch, Pause, Play } from '@phosphor-icons/react';
import { ConnectionTracks } from './LaunchMarquees.js';
import { motion } from 'motion/react';
import { useLaunchMotion } from './useLaunchMotion.js';
import './launch-connections.css';

const providers = [
  { slug: 'quickbooks', name: 'QuickBooks' },
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'stripe', name: 'Stripe' },
  { slug: 'slack', name: 'Slack' },
  { slug: 'hubspot', name: 'HubSpot' },
];

export function LaunchConnections() {
  const { feedback, reveal } = useLaunchMotion();
  const [providerIndex, setProviderIndex] = useState(0);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const section = useRef<HTMLElement>(null);
  const manualPause = useRef(false);
  const syncPlayback = useRef<() => void>(undefined);

  useLayoutEffect(() => {
    manualPause.current = paused;
    syncPlayback.current?.();
  }, [paused]);

  useLayoutEffect(() => {
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      setConnected(false);
      const timeline = gsap.timeline({ repeat: -1, paused: true });
      timeline.call(() => setConnected(true), [], 1.3);
      timeline.call(() => {
        setProviderIndex(index => (index + 1) % providers.length);
        setConnected(false);
      }, [], 3.2);
      const spinner = gsap.to(section.current!.querySelector('.connection-spinner'), {
        rotation: 360, duration: 1, ease: 'none', repeat: -1, paused: true,
      });
      let visible = false;
      const sync = () => {
        const stop = !visible || document.hidden || manualPause.current;
        timeline.paused(stop);
        spinner.paused(stop);
      };
      syncPlayback.current = sync;
      const observer = new IntersectionObserver(([entry]) => {
        visible = !!entry?.isIntersecting;
        sync();
      }, { threshold: .25 });
      observer.observe(section.current!);
      document.addEventListener('visibilitychange', sync);
      return () => {
        observer.disconnect();
        document.removeEventListener('visibilitychange', sync);
        syncPlayback.current = undefined;
      };
    });
    return () => media.revert();
  }, []);

  const provider = providers[providerIndex]!;
  return <section id="connections" className="launch-connections" ref={section}>
    <div className="connections-heading">
      <h2>Works with the tools you already use.</h2>
      <div className="connection-demo">
        <div className="connection-status" role="img" aria-label={'Connection animation demo. ' + provider.name + (connected ? ' connected.' : ' signing in.')}>
          <motion.span key={provider.slug} {...reveal} className="connection-provider-logo"><img src={'/launch/connections/' + provider.slug + '.svg'} alt="" width="32" height="32"/></motion.span>
          <motion.div key={provider.slug+connected} {...reveal} className="connection-account"><strong>{provider.name}</strong><span>{connected ? 'Orbit Studio · demo workspace' : 'Signing in…'}</span></motion.div>
          <span className={'connection-badge' + (connected ? ' connected' : '')}>
            <CircleNotch className="connection-spinner" style={{ display: connected ? 'none' : undefined }}/>
            {connected && <Check/>}{connected ? 'Connected' : 'Connecting'}
          </span>
        </div>
      </div>
    </div>
    <ConnectionTracks paused={paused}/>
    <div className="connection-caption"><span>Illustrative connection demo</span>
      <motion.button {...feedback} onClick={() => setPaused(value => !value)} aria-label={(paused ? 'Resume' : 'Pause') + ' connection animation'}>
        {paused ? <Play weight="fill"/> : <Pause weight="fill"/>}{paused ? 'Resume' : 'Pause'}
      </motion.button>
    </div>
  </section>;
}
