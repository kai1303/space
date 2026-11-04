import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useReducedMotion } from 'motion/react';
import { Button } from '@space/ui';
import type { ChatEvent, MessagePage } from '@space/contracts';
import type { HistoryDirection } from './history-window.js';

export type TimelineHandle = { reveal: (id: string) => void };
export function MessageTimeline({ label, items, page, loading, latestVersion, load, pinned, handle, render, children, footer, busy, onAtEndChange, role, hidden }: {
  label: string; items: ChatEvent[]; page: Pick<MessagePage,'has_older'|'has_newer'> | null; loading: HistoryDirection | null;
  latestVersion: number; load: (direction: HistoryDirection) => unknown;
  pinned: RefObject<boolean>; handle?: RefObject<TimelineHandle | null>;
  render: (event: ChatEvent, index: number) => ReactNode; children?: ReactNode; footer?: ReactNode; busy?: boolean;
  onAtEndChange?: (atEnd: boolean) => void; role?: 'log'; hidden?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null), lastOffset = useRef(0);
  const handledLatest = useRef(0);
  const latestScrollBehavior = useRef<'auto' | 'smooth'>('auto');
  const reducedMotion = useReducedMotion();
  const [atEnd, setAtEnd] = useState(true);
  const virtualizer = useVirtualizer({
    count: items.length, getScrollElement: () => element.current,
    getItemKey: index => items[index]!.type === 'message.created' ? `message:${items[index]!.payload.id}` : `event:${items[index]!.sequence}`,
    estimateSize: () => 100, overscan: 6, paddingStart: page?.has_older ? 44 : footer ? 16 : 10, paddingEnd: page?.has_newer ? 44 : 0,
    anchorTo: 'end', followOnAppend: !page?.has_newer && loading === null,
    scrollEndThreshold: 80,
    onChange: instance => { pinned.current = instance.isAtEnd(); },
  });
  useLayoutEffect(() => {
    if (latestVersion && latestVersion !== handledLatest.current) {
      handledLatest.current = latestVersion;
      const behavior = latestScrollBehavior.current;
      latestScrollBehavior.current = 'auto';
      virtualizer.scrollToEnd({ behavior });
      if (behavior === 'auto') { pinned.current = true; setAtEnd(true); onAtEndChange?.(true); }
    }
  }, [latestVersion, virtualizer]);
  useLayoutEffect(() => {
    if (!handle) return;
    handle.current = { reveal: id => {
      const index = items.findIndex(event => event.type === 'message.created' && event.payload.id === id);
      if (index < 0) return;
      virtualizer.scrollToIndex(index, { align: 'center' });
      requestAnimationFrame(() => document.getElementById(`chat-message-${id}`)?.focus({ preventScroll: true }));
    } };
    return () => { handle.current = null; };
  }, [handle, items, virtualizer]);
  async function jumpToLatest() {
    const behavior = reducedMotion ? 'auto' : 'smooth';
    if (!page?.has_newer) { virtualizer.scrollToEnd({ behavior }); return; }
    latestScrollBehavior.current = behavior;
    if (!await load('latest')) latestScrollBehavior.current = 'auto';
  }
  const showJump = !!page?.has_newer || !atEnd;
  return <div className="chat-timeline-shell" hidden={hidden}>
    <div className="chat-timeline chat-timeline--virtual" role={role} aria-label={label} aria-busy={busy} ref={element} onScroll={event => {
      const node = event.currentTarget, offset = node.scrollTop;
      const movingUp = offset < lastOffset.current, movingDown = offset > lastOffset.current;
      lastOffset.current = offset;
      pinned.current = node.scrollHeight - offset - node.clientHeight < 80;
      setAtEnd(pinned.current); onAtEndChange?.(pinned.current);
      if (loading || offset < 0) return;
      if (movingUp && offset < 300 && page?.has_older) void load('older');
      else if (movingDown && node.scrollHeight - offset - node.clientHeight < 300 && page?.has_newer) void load('newer');
    }}>
      {children}
      {(!!items.length || page?.has_older || page?.has_newer) && <div className="chat-virtual-items" style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {page?.has_older && <div className="chat-history-edge chat-history-edge--older"><Button variant="ghost" size="sm" disabled={!!loading} onClick={() => void load('older')}>{loading === 'older' ? 'Loading older messages…' : 'Load older history'}</Button></div>}
        {virtualizer.getVirtualItems().map(item => <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>{render(items[item.index]!, item.index)}</div>)}
        {page?.has_newer && <div className="chat-history-edge chat-history-edge--newer"><Button variant="ghost" size="sm" disabled={!!loading} onClick={() => void load('newer')}>{loading === 'newer' ? 'Loading newer messages…' : 'Load newer messages'}</Button></div>}
      </div>}
      {footer && <div className="chat-timeline-footer" aria-hidden={busy || undefined} inert={busy}>{footer}</div>}
    </div>
    <div className="chat-jump-latest" data-visible={showJump} aria-hidden={!showJump} inert={!showJump}><Button size="sm" disabled={!!loading} onClick={() => void jumpToLatest()}>Jump to latest</Button></div>
  </div>;
}
