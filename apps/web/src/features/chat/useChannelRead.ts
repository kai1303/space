import { useEffect, useRef, useState } from 'react';
import { request } from '../../shared/api/request.js';
const attending = (selector: string) => {
  if (document.hidden || !document.hasFocus() || document.querySelector('dialog[open]')) return false;
  const timeline = document.querySelector<HTMLElement>(selector);
  if (!timeline) return false;
  for (let node: HTMLElement | null = timeline; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
};

export function useChannelRead(channel: string, sequence: string, lastRead: string | undefined, enabled: boolean, thread?: { workspace: string; id:string; actor:string }) {
  const selector = thread ? '.chat-thread[aria-label="Thread"] .chat-timeline' : '#chat-messages .chat-timeline';
  const path = thread ? `/workspaces/${thread.workspace}/hub/threads/${thread.id}/read` : `/channels/${channel}/read`;
  const confirmed = useRef('0');
  const [attention, setAttention] = useState(0), [error, setError] = useState('');
  useEffect(() => {
    let previous = attending(selector);
    const changed = (event?: Event) => {
      const next = attending(selector);
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
  }, [selector]);
  useEffect(() => {
    if (!enabled || lastRead === undefined || !attending(selector) || BigInt(sequence) <= BigInt(lastRead) || BigInt(sequence) <= BigInt(confirmed.current)) return;
    let active = true;
    const timer = setTimeout(() => {
      if (!attending(selector)) return;
      void request(path, { sequence }, undefined, 'POST', undefined, thread?.actor).then(() => {
        if (BigInt(sequence) > BigInt(confirmed.current)) confirmed.current = sequence;
        if (active) setError('');
      }).catch(() => { if (active) setError('Couldn’t update read status. It will retry when you return.'); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [path, sequence, lastRead, enabled, attention, selector, thread?.actor]);
  return error;
}
