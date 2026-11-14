import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, MessagePage } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { appendLive, HISTORY_LIMIT, mergePage, type HistoryDirection } from './history-window.js';

export function useMessageHistory(path: string, onError: (reason: unknown) => void, rootsOnly = false, target?: ChatMessage) {
  const [page, setPage] = useState<MessagePage | null>(null);
  const [loading, setLoading] = useState<HistoryDirection | null>(null);
  const [latestVersion, setLatestVersion] = useState(0);
  const current = useRef(page), epoch = useRef(0), busy = useRef<HistoryDirection | null>(null);
  const error = useRef(onError); error.current = onError;
  const buffer = useRef<ChatMessage[]>([]), overflow = useRef<'messages' | 'deletion' | null>(null);
  const mounted = useRef(true);
  const update = (value: MessagePage | null) => { current.current = value; setPage(value); };
  const clear = useCallback(() => { epoch.current++; busy.current = null; buffer.current = []; overflow.current = null; update(null); setLoading(null); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; busy.current = null; }; }, [path]);
  const receive = useCallback((messages: ChatMessage[], pinned: boolean) => {
    if (!current.current || busy.current) {
      buffer.current.push(...messages);
      if (buffer.current.length > HISTORY_LIMIT) {
        const dropped = buffer.current.splice(0, buffer.current.length - HISTORY_LIMIT);
        if (dropped.some(message => message.deleted_at)) overflow.current = 'deletion';
        else overflow.current ??= 'messages';
      }
    }
    if (current.current) update(appendLive(current.current, messages, pinned, rootsOnly));
  }, [rootsOnly]);
  const load = useCallback(async (direction: HistoryDirection, targetSequence?: string): Promise<MessagePage | undefined> => {
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
      // The API uses an exclusive sequence cursor. Include the linked message at the start of its page.
      let url = path;
      if (targetSequence) url += `?after=${BigInt(targetSequence) - 1n}`;
      else if (direction !== 'latest') url += `?${direction === 'older' ? 'before' : 'after'}=${boundary}`;
      let result = await request<MessagePage>(url);
      if (epoch.current !== version) return;
      if (overflow.current === 'deletion') {
        // A dropped update could have deleted content in this snapshot. Re-read once.
        buffer.current = []; overflow.current = null;
        result = await request<MessagePage>(url);
        if (epoch.current !== version) return;
        if (overflow.current === 'deletion') throw new Error('Messages changed while loading. Try again.');
      }
      let next = mergePage(targetSequence ? null : current.current, result, direction);
      if (direction === 'latest' || direction === 'newer') {
        if (overflow.current) next = { ...next, has_newer: true };
        else next = appendLive(next, buffer.current.filter(message => BigInt(message.reaction_sequence ?? '0') > BigInt(result.event_cursor) || BigInt(message.sequence!) > BigInt(result.event_cursor)), direction === 'latest', rootsOnly);
        if (direction === 'latest' && !targetSequence) setLatestVersion(value => value + 1);
      }
      // Updates retain their creation sequence and can overlap any page being fetched.
      const ids = new Set(next.messages.map(message => message.id));
      next = appendLive(next, buffer.current.filter(message => (message.deleted_at || BigInt(message.reaction_sequence ?? '0') > 0n) && ids.has(message.id)), false, rootsOnly);
      buffer.current = []; overflow.current = null;
      update(next);
      return result;
    } catch (reason) { if (epoch.current === version) error.current(reason); }
    finally { if (epoch.current === version) { busy.current = null; setLoading(null); } }
  }, [path, rootsOnly]);
  const located = useRef<ChatMessage | undefined>(undefined);
  useEffect(() => {
    if (!target) { located.current = undefined; return; }
    if (!page || located.current === target) return;
    located.current = target;
    if (!page.messages.some(message => message.id === target.id) && target.sequence) {
      void load('latest', target.sequence);
    }
  }, [page, target, load]);
  const sent = useCallback((message: ChatMessage) => {
    if (!mounted.current || !current.current) return;
    receive([message], true);
    if (current.current.has_newer || busy.current) void load('latest');
    else setLatestVersion(value => value + 1);
  }, [load, receive]);
  return { page, loading, latestVersion, load, receive, sent, clear };
}
