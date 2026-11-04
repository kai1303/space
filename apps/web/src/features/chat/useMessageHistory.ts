import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, MessagePage } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { appendLive, HISTORY_LIMIT, mergePage, type HistoryDirection } from './history-window.js';

export function useMessageHistory(path: string, onError: (reason: unknown) => void, rootsOnly = false) {
  const [page, setPage] = useState<MessagePage | null>(null);
  const [loading, setLoading] = useState<HistoryDirection | null>(null);
  const [latestVersion, setLatestVersion] = useState(0);
  const current = useRef(page), epoch = useRef(0), busy = useRef<HistoryDirection | null>(null);
  const error = useRef(onError); error.current = onError;
  const buffer = useRef<ChatMessage[]>([]), overflow = useRef(false);
  const mounted = useRef(true);
  const update = (value: MessagePage | null) => { current.current = value; setPage(value); };
  const clear = useCallback(() => { epoch.current++; busy.current = null; buffer.current = []; overflow.current = false; update(null); setLoading(null); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; busy.current = null; }; }, [path]);
  const receive = useCallback((messages: ChatMessage[], pinned: boolean) => {
    if (!current.current || busy.current) {
      buffer.current.push(...messages);
      if (buffer.current.length > HISTORY_LIMIT) { overflow.current = true; buffer.current = buffer.current.slice(-HISTORY_LIMIT); }
    }
    if (current.current) update(appendLive(current.current, messages, pinned, rootsOnly));
  }, [rootsOnly]);
  const load = useCallback(async (direction: HistoryDirection): Promise<MessagePage | undefined> => {
    if (busy.current) {
      if (direction !== 'latest') return;
      epoch.current++;
    }
    const previous = current.current;
    const boundary = direction === 'older' ? previous?.older_cursor : previous?.newer_cursor;
    if (direction !== 'latest' && (!previous || !boundary || !(direction === 'older' ? previous.has_older : previous.has_newer))) return;
    busy.current = direction; setLoading(direction);
    const version = epoch.current;
    try {
      const result = await request<MessagePage>(`${path}${direction === 'latest' ? '' : `?${direction === 'older' ? 'before' : 'after'}=${boundary}`}`);
      if (epoch.current !== version) return;
      let next = mergePage(current.current, result, direction);
      if (direction === 'latest' || direction === 'newer') {
        if (overflow.current) next = { ...next, has_newer: true };
        else next = appendLive(next, buffer.current.filter(message => BigInt(message.reaction_sequence ?? '0') > BigInt(result.event_cursor) || BigInt(message.sequence!) > BigInt(result.event_cursor)), direction === 'latest', rootsOnly);
        if (direction === 'latest') setLatestVersion(value => value + 1);
      }
      // Replay reaction snapshots over pages fetched while their updates were in flight.
      next = appendLive(next, buffer.current.filter(message => BigInt(message.reaction_sequence ?? '0') > 0n && next.messages.some(item => item.id === message.id)), false, rootsOnly);
      buffer.current = []; overflow.current = false;
      update(next);
      return result;
    } catch (reason) { if (epoch.current === version) error.current(reason); }
    finally { if (epoch.current === version) { busy.current = null; setLoading(null); } }
  }, [path, rootsOnly]);
  const sent = useCallback((message: ChatMessage) => {
    if (!mounted.current || !current.current) return;
    receive([message], true);
    if (current.current.has_newer || busy.current) void load('latest');
    else setLatestVersion(value => value + 1);
  }, [load, receive]);
  return { page, loading, latestVersion, load, receive, sent, clear };
}
