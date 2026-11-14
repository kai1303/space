import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { animate, useReducedMotion } from 'motion/react';
import { Button } from '@space/ui/primitives';
import type { ChatEvent, MessagePage } from '@space/contracts';
import type { HistoryDirection } from './history-window.js';

export type TimelineHandle = { reveal: (id: string) => void };
type TimelineItem = ChatEvent | { id: string; messageId?: string };
export function MessageTimeline<T extends TimelineItem>({ label, items, page, loading, latestVersion, load, pinned, handle, target, render, children, header, trailing, footer, endPadding = 16, busy, onAtEndChange, role, hidden }: {
  label: string; items: T[]; page: Pick<MessagePage,'has_older'|'has_newer'> | null; loading: HistoryDirection | null;
  latestVersion: number; load: (direction: HistoryDirection) => unknown;
  pinned: RefObject<boolean>; handle?: RefObject<TimelineHandle | null>; target?: { id: string };
  render: (event: T, index: number) => ReactNode; children?: ReactNode; header?: ReactNode; trailing?: ReactNode; footer?: ReactNode; endPadding?: number; busy?: boolean;
  onAtEndChange?: (atEnd: boolean) => void; role?: 'log'; hidden?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null), lastOffset = useRef(0);
  const handledLatest = useRef(0);
  const wasHidden = useRef(hidden);
  // The virtualizer cancels pending scrolls on cleanup, including StrictMode's effect remount.
  useLayoutEffect(() => () => { handledLatest.current = 0; }, []);
  const latestScrollBehavior = useRef<'auto' | 'smooth'>('auto');
  const reducedMotion = useReducedMotion();
  const [atEnd, setAtEnd] = useState(true);
  const headerCount = header ? 1 : 0;
  const virtualizer = useVirtualizer({
    count: items.length + headerCount, getScrollElement: () => element.current,
    getItemKey: index => {
      if (headerCount && index === 0) return 'header';
      const item = items[index - headerCount]!;
      if ('id' in item) return item.id;
      return item.type === 'message.created' ? `message:${item.payload.id}` : `event:${item.sequence}`;
    },
    estimateSize: () => 100, overscan: 6, paddingStart: page?.has_older ? 44 : footer ? 16 : 10, paddingEnd: page?.has_newer ? 44 : endPadding,
    anchorTo: 'end', followOnAppend: !page?.has_newer && loading === null,
    scrollEndThreshold: 80,
    onChange: instance => { if (!hidden && element.current?.clientHeight) pinned.current = instance.isAtEnd(); },
  });
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || hidden || typeof ResizeObserver === 'undefined') return;
    let height = node.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = node.clientHeight;
      // Composer growth should keep the latest reply visible, without moving readers in older history.
      if (nextHeight > 0 && nextHeight !== height && atEnd && !page?.has_newer) node.scrollTop = node.scrollHeight;
      height = nextHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [atEnd, page?.has_newer, hidden]);
  useLayoutEffect(() => {
    const revealed = wasHidden.current && !hidden;
    wasHidden.current = hidden;
    if (!hidden && latestVersion && latestVersion !== handledLatest.current) {
      handledLatest.current = latestVersion;
      const behavior = latestScrollBehavior.current;
      latestScrollBehavior.current = 'auto';
      virtualizer.scrollToEnd({ behavior });
      if (behavior === 'auto') { pinned.current = true; setAtEnd(true); onAtEndChange?.(true); }
    } else if (revealed) {
      if (atEnd && !page?.has_newer) virtualizer.scrollToEnd();
      else virtualizer.scrollToOffset(lastOffset.current);
    }
  }, [latestVersion, virtualizer, hidden, atEnd, page?.has_newer]);
  const revealedTarget = useRef<typeof target>(undefined);
  const highlight = useRef<Animation | undefined>(undefined);
  const activeReveal = useRef<(() => void) | null>(null);
  function cancelReveal() {
    activeReveal.current?.();
    activeReveal.current = null;
  }
  useLayoutEffect(() => () => {
    cancelReveal();
    highlight.current?.cancel();
    revealedTarget.current = undefined;
  }, [hidden, target]);
  useLayoutEffect(() => {
    function reveal(id: string) {
      const index = items.findIndex(item => 'id' in item ? item.messageId === id : item.type === 'message.created' && item.payload.id === id);
      const node = element.current;
      if (index < 0 || !node) return false;
      cancelReveal();
      const rowIndex = index + headerCount;
      const finish = () => {
        virtualizer.scrollToIndex(rowIndex, { align: 'center' });
        const frame = requestAnimationFrame(() => {
          activeReveal.current = null;
          const row = document.getElementById(`thread-message-${id}`);
          const anchor = row && node.contains(row) ? row : document.getElementById(`chat-message-${id}`);
          if (anchor && node.contains(anchor)) {
            anchor.focus({ preventScroll: true });
            if (target?.id === id) {
              const tint = {
                backgroundColor: 'color-mix(in srgb, var(--sp-info) 24%, transparent)',
                boxShadow: 'inset 3px 0 var(--sp-info)',
              };
              highlight.current?.cancel();
              highlight.current = anchor.animate?.([
                tint, { ...tint, offset: 0.7, easing: reducedMotion ? 'step-end' : 'ease-out' },
                { backgroundColor: 'transparent', boxShadow: 'inset 3px 0 transparent' },
              ], 1800);
            }
          }
        });
        activeReveal.current = () => cancelAnimationFrame(frame);
      };
      const start = node.scrollTop;
      const center = () => virtualizer.getOffsetForIndex(rowIndex, 'center')?.[0];
      const end = !reducedMotion && node.clientHeight ? center() : undefined;
      if (end === undefined || Math.abs(end - start) < 1) finish();
      else {
        const animation = animate(0, 1, {
          duration: 0.36, ease: [0.22, 1, 0.36, 1],
          // The centered offset can change as virtual rows enter view and are measured.
          onUpdate: progress => { node.scrollTop = start + ((center() ?? end) - start) * progress; },
          onComplete: finish,
        });
        activeReveal.current = () => animation.stop();
      }
      return true;
    }
    if (handle) handle.current = { reveal };
    if (!target) revealedTarget.current = undefined;
    else if (!hidden && revealedTarget.current !== target && reveal(target.id)) revealedTarget.current = target;
    return () => { if (handle) handle.current = null; };
  }, [handle, items, virtualizer, headerCount, target, hidden, reducedMotion]);
  async function jumpToLatest() {
    cancelReveal();
    const behavior = reducedMotion ? 'auto' : 'smooth';
    if (!page?.has_newer) { virtualizer.scrollToEnd({ behavior }); return; }
    latestScrollBehavior.current = behavior;
    if (!await load('latest')) latestScrollBehavior.current = 'auto';
  }
  const showJump = !!page?.has_newer || !atEnd;
  return <div className="chat-timeline-shell" hidden={hidden}>
    <div className="chat-timeline chat-timeline--virtual" role={role} aria-label={label} aria-busy={busy} ref={element}
      onWheel={cancelReveal} onTouchStart={cancelReveal} onPointerDown={cancelReveal} onKeyDown={cancelReveal} onScroll={event => {
      const node = event.currentTarget, offset = node.scrollTop;
      if (hidden || !node.clientHeight) return;
      const movingUp = offset < lastOffset.current, movingDown = offset > lastOffset.current;
      lastOffset.current = offset;
      pinned.current = node.scrollHeight - offset - node.clientHeight < 80;
      setAtEnd(pinned.current); onAtEndChange?.(pinned.current);
      if (activeReveal.current || loading || offset < 0) return;
      if (movingUp && offset < 300 && page?.has_older) void load('older');
      else if (movingDown && node.scrollHeight - offset - node.clientHeight < 300 && page?.has_newer) void load('newer');
    }}>
      {children}
      {(!!header || !!items.length || page?.has_older || page?.has_newer) && <div className="chat-virtual-items" style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {page?.has_older && <div className="chat-history-edge chat-history-edge--older"><Button variant="ghost" size="sm" disabled={!!loading} onClick={() => void load('older')}>{loading === 'older' ? 'Loading older messages…' : 'Load older history'}</Button></div>}
        {virtualizer.getVirtualItems().map(item => <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>{headerCount && item.index === 0 ? header : render(items[item.index - headerCount]!, item.index - headerCount)}</div>)}
        {page?.has_newer && <div className="chat-history-edge chat-history-edge--newer"><Button variant="ghost" size="sm" disabled={!!loading} onClick={() => void load('newer')}>{loading === 'newer' ? 'Loading newer messages…' : 'Load newer messages'}</Button></div>}
      </div>}
      {trailing}
      {footer && <div className="chat-timeline-footer" aria-hidden={busy || undefined} inert={busy}>{footer}</div>}
    </div>
    <div className="chat-jump-latest" data-visible={showJump} aria-hidden={!showJump} inert={!showJump}><Button size="sm" disabled={!!loading} onClick={() => void jumpToLatest()}>Jump to latest</Button></div>
  </div>;
}
