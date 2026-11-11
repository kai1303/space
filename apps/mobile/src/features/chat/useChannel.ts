import { useCallback, useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import type { ChatEvent, ChatMessage, MessagePage } from '@space/contracts';
import { ApiError, errorText } from '../../shared/api/request';
import { useRealtime } from '../../shared/realtime/RealtimeProvider';
import { useAuth } from '../auth/AuthProvider';
import { appendLive, mergePage } from './history-window';
import { failed, reconcile, sending, type Outgoing } from './outbox';

export const MAX_TEXT = 16_000; // Server limit in packages/contracts/chat.ts.
export const MAX_PENDING = 50;
type Batch = { channel_id: string; events: ChatEvent[]; cursor: string };
const NO_ACCESS = new Set(['forbidden', 'not_found', 'invalid_id']);

export function useChannel(channelId: string) {
  const { api, user } = useAuth();
  const realtime = useRealtime();
  const viewerId = user?.id ?? '';
  const path = `/channels/${encodeURIComponent(channelId)}/messages`;
  const [page, setPageState] = useState<MessagePage | null>(null);
  const [outgoing, setOutgoingState] = useState<Outgoing[]>([]);
  const [error, setError] = useState('');
  const [noAccess, setNoAccess] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const pageRef = useRef<MessagePage | null>(null);
  const outgoingRef = useRef<Outgoing[]>([]);
  const atLatest = useRef(true);
  const olderBusy = useRef(false);
  const alive = useRef(true);
  const reload = useRef<() => Promise<void>>(async () => {});
  const setPage = useCallback((next: MessagePage | null) => { pageRef.current = next; setPageState(next); }, []);
  const setOutgoing = useCallback((next: Outgoing[]) => { outgoingRef.current = next; setOutgoingState(next); }, []);

  useEffect(() => {
    alive.current = true;
    setPage(null); setOutgoing([]); setError(''); setNoAccess(false);
    let epoch = 0;
    let cursor: string | null = null;
    const subscribe = async () => {
      if (!cursor || !realtime.connected) return;
      try {
        await realtime.command('channel.subscribe', { channel_id: channelId, after: cursor });
        if (alive.current) setError('');
      } catch (reason) {
        if (!alive.current) return;
        const code = reason instanceof Error ? reason.message : '';
        if (NO_ACCESS.has(code)) setNoAccess(true);
        else if (code === 'invalid_cursor') void loadLatest();
        // Other failures retry on the next connect.
      }
    };
    const loadLatest = async () => {
      const mine = ++epoch;
      try {
        const result = await api.request<MessagePage>(path);
        if (!alive.current || mine !== epoch) return;
        setPage(mergePage(pageRef.current, result, 'latest'));
        cursor = result.event_cursor;
        setError('');
        await subscribe();
      } catch (reason) {
        if (!alive.current || mine !== epoch) return;
        if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) setNoAccess(true);
        else setError(errorText(reason));
      }
    };
    reload.current = loadLatest;
    const offEvents = realtime.on<Batch>('chat.events', batch => {
      if (!alive.current || batch.channel_id !== channelId || !pageRef.current) return;
      const incoming = batch.events.flatMap(event => event.type === 'message.created' || event.type === 'message.updated'
        ? [{ ...event.payload, sequence: event.payload.sequence ?? event.sequence }] : []);
      cursor = batch.cursor;
      if (!incoming.length) return;
      setPage(appendLive(pageRef.current, incoming, atLatest.current, true));
      setOutgoing(reconcile(outgoingRef.current, incoming, viewerId));
    });
    const offConnect = realtime.on('connect', () => { void subscribe(); });
    void loadLatest();
    return () => {
      alive.current = false; epoch++;
      offEvents(); offConnect();
      if (realtime.connected) void realtime.command('channel.unsubscribe', { channel_id: channelId }).catch(() => undefined);
    };
  }, [api, channelId, path, realtime, setOutgoing, setPage, viewerId]);

  const loadOlder = useCallback(async () => {
    const current = pageRef.current;
    if (olderBusy.current || !current?.has_older || !current.older_cursor) return;
    olderBusy.current = true; setLoadingOlder(true);
    try {
      const result = await api.request<MessagePage>(`${path}?before=${encodeURIComponent(current.older_cursor)}`);
      if (alive.current && pageRef.current) setPage(mergePage(pageRef.current, result, 'older'));
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      olderBusy.current = false;
      if (alive.current) setLoadingOlder(false);
    }
  }, [api, path, setPage]);

  const setAtLatest = useCallback((value: boolean) => {
    if (atLatest.current === value) return;
    atLatest.current = value;
    // Live messages stop extending a window the reader scrolled away from. Rejoin the latest page.
    if (value && pageRef.current?.has_newer) void reload.current();
  }, []);

  const deliver = useCallback(async (entry: Pick<Outgoing, 'id' | 'text'>) => {
    setOutgoing(sending(outgoingRef.current, entry));
    try {
      const saved = await realtime.command<ChatMessage>('message.send', { channel_id: channelId, client_message_id: entry.id, text: entry.text });
      if (!alive.current) return;
      if (pageRef.current) setPage(appendLive(pageRef.current, [saved], true, true));
      setOutgoing(reconcile(outgoingRef.current, [saved], viewerId));
    } catch (reason) {
      if (alive.current) setOutgoing(failed(outgoingRef.current, entry.id, errorText(reason)));
    }
  }, [channelId, realtime, setOutgoing, setPage, viewerId]);

  const send = useCallback((text: string) => {
    const value = text.trim();
    if (!value || value.length > MAX_TEXT || outgoingRef.current.length >= MAX_PENDING) return false;
    void deliver({ id: Crypto.randomUUID(), text: value });
    return true;
  }, [deliver]);

  const retry = useCallback((id: string) => {
    const entry = outgoingRef.current.find(item => item.id === id);
    if (entry?.status === 'failed') void deliver(entry);
  }, [deliver]);

  return { page, outgoing, error, noAccess, loadingOlder, loadOlder, setAtLatest, send, retry };
}
