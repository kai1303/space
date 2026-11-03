import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@space/ui';
import type { ChatEvent, MessagePage } from '@space/contracts';
import type { HistoryDirection } from './history-window.js';

export type TimelineHandle = { reveal: (id: string) => void };
export function MessageTimeline({ label, items, page, loading, latestVersion, load, pinned, handle, render, children, busy, onAtEndChange }: {
  label: string; items: ChatEvent[]; page: MessagePage | null; loading: HistoryDirection | null;
  latestVersion: number; load: (direction: HistoryDirection) => unknown;
  pinned: RefObject<boolean>; handle?: RefObject<TimelineHandle | null>;
  render: (event: ChatEvent, index: number) => ReactNode; children?: ReactNode; busy?: boolean;
  onAtEndChange?: (atEnd: boolean) => void;
}) {
  const element = useRef<HTMLDivElement>(null), lastOffset = useRef(0);
  const handledLatest = useRef(0);
  const [atEnd, setAtEnd] = useState(true);
  const virtualizer = useVirtualizer({
    count: items.length, getScrollElement: () => element.current,
    getItemKey: index => items[index]!.type === 'message.created' ? `message:${items[index]!.payload.id}` : `event:${items[index]!.sequence}`,
    estimateSize: () => 100, overscan: 6, paddingStart: 44, paddingEnd: 44,
    anchorTo: 'end', followOnAppend: !page?.has_newer && loading === null,
    scrollEndThreshold: 80,
    onChange: instance => { pinned.current = instance.isAtEnd(); },
  });
  useLayoutEffect(() => {
    if (latestVersion && latestVersion !== handledLatest.current) {
      handledLatest.current = latestVersion;
      virtualizer.scrollToEnd(); pinned.current = true; setAtEnd(true); onAtEndChange?.(true);
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
  return <>
    <div className="chat-timeline chat-timeline--virtual" aria-label={label} aria-busy={busy} ref={element} onScroll={event => {
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
      {!!items.length && <div className="chat-virtual-items" style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        <div className="chat-history-edge chat-history-edge--older">{page?.has_older && <Button variant="ghost" size="sm" disabled={!!loading} onClick={() => void load('older')}>{loading === 'older' ? 'Loading older messages…' : 'Load older history'}</Button>}</div>
        {virtualizer.getVirtualItems().map(item => <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>{render(items[item.index]!, item.index)}</div>)}
        <div className="chat-history-edge chat-history-edge--newer">{page?.has_newer && <Button variant="ghost" size="sm" disabled={!!loading} onClick={() => void load('newer')}>{loading === 'newer' ? 'Loading newer messages…' : 'Load newer messages'}</Button>}</div>
      </div>}
    </div>
    {(page?.has_newer || !atEnd) && <div className="chat-jump-latest"><Button size="sm" disabled={!!loading} onClick={() => void load('latest')}>Jump to latest</Button></div>}
  </>;
}
