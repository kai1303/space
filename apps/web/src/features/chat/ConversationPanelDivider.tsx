import { useLayoutEffect, useRef, useState } from 'react';

const preference = 'space.conversation-panel-width';

function savedWidth() {
  try {
    const width = Number(localStorage.getItem(preference));
    if (Number.isFinite(width) && width > 0) return width;
  } catch { /* Storage may be unavailable. */ }
}

export function ConversationPanelDivider({ files }: { files: boolean }) {
  const handle = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [preferred, setPreferred] = useState(savedWidth);
  const drag = useRef<{ pointer: number; x: number; width: number; previous?: number } | null>(null);
  const min = Math.min(310, Math.floor(available / 2));
  const max = Math.max(min, available - 320);
  const clamp = (value: number) => Math.max(min, Math.min(max, Math.round(value)));
  const width = clamp(preferred ?? (files ? 390 : available * 0.4));

  useLayoutEffect(() => {
    const container = handle.current!.parentElement!;
    const measure = () => setAvailable(container.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!available) return;
    const style = handle.current!.parentElement!.style;
    style.setProperty('--conversation-panel-width', width + 'px');
    return () => { style.removeProperty('--conversation-panel-width'); };
  }, [available, width]);

  function commit(value: number) {
    setPreferred(value);
    try { localStorage.setItem(preference, String(value)); } catch { /* Keep the in-memory width. */ }
  }

  return <div ref={handle} className="chat-panel-divider" role="separator" tabIndex={0}
    aria-label="Right sidebar width" aria-orientation="vertical"
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={width + ' pixels'}
    onKeyDown={event => {
      const next = { ArrowLeft: width + 10, ArrowRight: width - 10, Home: min, End: max }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      commit(clamp(next));
    }}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, x: event.clientX, width, previous: preferred };
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start && start.pointer === event.pointerId) setPreferred(clamp(start.width + start.x - event.clientX));
    }}
    onPointerUp={event => {
      const start = drag.current;
      if (!start || start.pointer !== event.pointerId) return;
      drag.current = null;
      const next = clamp(start.width + start.x - event.clientX);
      if (next === start.width) setPreferred(start.previous);
      else commit(next);
    }}
    onLostPointerCapture={event => {
      const start = drag.current;
      if (start && start.pointer === event.pointerId) {
        drag.current = null;
        setPreferred(start.previous);
      }
    }}
  />;
}
