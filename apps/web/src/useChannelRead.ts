import { useEffect, useRef, useState } from 'react';
import { request } from './chat-client.js';
const attending = () => {
  if (document.hidden || !document.hasFocus() || document.querySelector('dialog[open]')) return false;
  const timeline = document.querySelector<HTMLElement>('#chat-messages .chat-timeline');
  if (!timeline) return false;
  for (let node: HTMLElement | null = timeline; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
};

export function useChannelRead(channel: string, sequence: string, lastRead: string | undefined, enabled: boolean) {
  const confirmed = useRef('0');
  const [attention, setAttention] = useState(0), [error, setError] = useState('');
  useEffect(() => {
    let previous = attending();
    const changed = (event?: Event) => {
      const next = attending();
      if (event?.type !== 'focusin' || next !== previous) setAttention(value => value + 1);
      previous = next;
    };
    window.addEventListener('focus', changed); window.addEventListener('blur', changed);
    window.addEventListener('resize', changed);
    document.addEventListener('visibilitychange', changed);
    document.addEventListener('focusin', changed);
    const shell = document.querySelector('.chat-app'), observer = new MutationObserver(() => changed());
    if (shell) observer.observe(shell, { attributes: true, attributeFilter: ['class'] });
    return () => { observer.disconnect(); window.removeEventListener('focus', changed); window.removeEventListener('blur', changed); window.removeEventListener('resize', changed); document.removeEventListener('visibilitychange', changed); document.removeEventListener('focusin', changed); };
  }, []);
  useEffect(() => {
    if (!enabled || lastRead === undefined || !attending() || BigInt(sequence) <= BigInt(lastRead) || BigInt(sequence) <= BigInt(confirmed.current)) return;
    let active = true;
    const timer = setTimeout(() => {
      if (!attending()) return;
      void request(`/channels/${channel}/read`, { sequence }).then(() => {
        if (BigInt(sequence) > BigInt(confirmed.current)) confirmed.current = sequence;
        if (active) setError('');
      }).catch(() => { if (active) setError('Couldn’t update read status. It will retry when you return.'); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [channel, sequence, lastRead, enabled, attention]);
  return error;
}
