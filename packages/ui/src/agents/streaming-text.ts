import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Element, Root } from 'hast';

const tickMs = 40;
export const wordFadeMs = 700;
export const words = typeof Intl.Segmenter === 'function' && new Intl.Segmenter(undefined, { granularity: 'word' });
const characters = typeof Intl.Segmenter === 'function' && new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const motionQuery = '(prefers-reduced-motion: reduce)';

function immediate() {
  return !words || document.hidden || window.matchMedia?.(motionQuery).matches === true;
}

function subscribe(listener: () => void) {
  const media = window.matchMedia?.(motionQuery);
  media?.addEventListener('change', listener);
  document.addEventListener('visibilitychange', listener);
  return () => {
    media?.removeEventListener('change', listener);
    document.removeEventListener('visibilitychange', listener);
  };
}
const subscribeNever = () => () => {};
const alwaysImmediate = () => true;

// Keep one presentation timer while text is queued. Incoming snapshots can extend the target mid-reveal.
export function useStreamingText(text: string, streaming: boolean, newArrival: boolean) {
  // A fast provider may first deliver the reply in its completed snapshot.
  const [arrivalText, setArrivalText] = useState(newArrival && !streaming && text ? text : null);
  const arrivingComplete = arrivalText === text && !streaming;
  const active = streaming || arrivingComplete;
  const bypass = useSyncExternalStore(active ? subscribe : subscribeNever, active ? immediate : alwaysImmediate, alwaysImmediate);
  const initial = newArrival && !bypass ? '' : text;
  const [visible, setVisible] = useState(initial);
  const state = useRef({ source: initial, visible: initial, fadeFrom: initial.length, lastArrival: 0, rate: 0, timer: 0 });

  useLayoutEffect(() => {
    const stream = state.current;
    const now = performance.now();
    if (bypass || !text.startsWith(stream.source)) {
      window.clearTimeout(stream.timer);
      Object.assign(stream, { source: text, visible: text, fadeFrom: text.length, lastArrival: 0, rate: 0, timer: 0 });
      setVisible(text);
      return;
    }
    const added = text.length - stream.source.length;
    stream.source = text;
    if (added > 0) {
      const interval = stream.lastArrival ? Math.max(tickMs, now - stream.lastArrival) : 200;
      const incomingRate = added / interval;
      stream.rate = stream.rate ? stream.rate * 0.6 + incomingRate * 0.4 : incomingRate;
      stream.lastArrival = now;
    }
    function advance() {
      const remaining = stream.source.length - stream.visible.length;
      // Drain a burst in roughly half a second and keep up with a sustained stream.
      const step = Math.max(1, Math.ceil(tickMs * Math.max(stream.rate, remaining / 450)));
      const target = Math.min(stream.source.length, stream.visible.length + step);
      const last = characters && characters.segment(stream.source).containing(target - 1);
      const end = last ? last.index + last.segment.length : target;
      stream.visible = stream.source.slice(0, end);
      setVisible(stream.visible);
      stream.timer = end < stream.source.length ? window.setTimeout(advance, tickMs) : 0;
    }
    if (!stream.timer && stream.visible.length < text.length) stream.timer = window.setTimeout(advance, tickMs);
  }, [text, bypass]);

  useLayoutEffect(() => () => {
    window.clearTimeout(state.current.timer);
    state.current.timer = 0;
  }, []);

  useLayoutEffect(() => {
    if (arrivalText === null) return;
    if (!arrivingComplete || bypass) {
      setArrivalText(null);
    } else if (visible === text) {
      const timer = window.setTimeout(() => setArrivalText(null), wordFadeMs);
      return () => window.clearTimeout(timer);
    }
  }, [arrivalText, arrivingComplete, bypass, visible, text]);

  if (bypass || !text.startsWith(state.current.source)) return { text, fadeFrom: undefined };
  return { text: visible, fadeFrom: state.current.fadeFrom };
}

// Decorate parsed prose only. CodeBlock receives its original source and links keep their original attributes.
export function fadeStreamedWords(from: number, tailFrom: number) {
  return (root: Root) => {
    function decorate(node: Element) {
      if (node.tagName === 'pre' || node.tagName === 'code' || (node.position?.end.offset ?? Infinity) <= from) return;
      node.children = node.children.map(child => {
        if (child.type === 'element') decorate(child);
        if (child.type !== 'text' || !child.value.trim() || !child.position || (child.position.end.offset ?? 0) <= from) return child;
        return {
          type: 'element', tagName: 'span',
          properties: { dataFadeFrom: Math.max(0, tailFrom - (child.position.start.offset ?? 0)) },
          children: [child],
        };
      });
    }
    for (const child of root.children) if (child.type === 'element') decorate(child);
  };
}
