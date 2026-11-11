import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import type { SessionClient } from '../api/session';

export type RealtimeAuth = Pick<SessionClient, 'headers' | 'refresh' | 'expire' | 'on'>;
type Connect = (url: string, options: Partial<ManagerOptions & SocketOptions>) => Socket;
export type Realtime = ReturnType<typeof createRealtime>;
const MAX_PENDING = 128;

export function createRealtime(base: string, auth: RealtimeAuth, connect: Connect = io) {
  const socket = connect(base, {
    transports: ['websocket'], autoConnect: false,
    reconnectionDelay: 1000, reconnectionDelayMax: 30_000, randomizationFactor: 0.5,
    extraHeaders: auth.headers(),
  });
  let wanted = false, closed = false, restoring = false, triedRefresh = false, delay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<unknown> = Promise.resolve(), pending = 0, generation = 0;

  const open = () => {
    if (closed || !wanted || socket.connected || socket.active) return;
    // Engine.IO reads these on every new transport, so a renewed cookie applies on reconnect.
    socket.io.opts.extraHeaders = auth.headers();
    socket.connect();
  };
  // Bounded backoff for cases socket.io does not retry itself.
  const later = () => {
    if (retry || closed || !wanted) return;
    const wait = delay * (0.75 + Math.random() * 0.5);
    delay = Math.min(delay * 2, 30_000);
    retry = setTimeout(() => { retry = undefined; open(); }, wait);
  };
  const restore = () => {
    if (closed || restoring) return;
    if (triedRefresh) { void auth.expire(); return; }
    restoring = true; triedRefresh = true;
    socket.disconnect();
    auth.refresh()
      .then(ok => { if (!ok) void auth.expire(); }) // On success the 'renewed' listener reconnects.
      .catch(() => { triedRefresh = false; later(); })
      .finally(() => { restoring = false; });
  };

  socket.on('connect', () => { triedRefresh = false; delay = 1000; clearTimeout(retry); retry = undefined; });
  socket.on('disconnect', (reason: string) => { generation++; if (reason === 'io server disconnect' && !restoring) later(); });
  socket.on('connect_error', (error: Error) => {
    if (error.message === 'unauthorized') restore();
    else if (!socket.active) later(); // Middleware rejections are not retried by socket.io.
  });
  socket.on('chat.error', (error: { error?: string } | undefined) => { if (error?.error === 'unauthorized') restore(); });
  const offRenewed = auth.on('renewed', () => { if (wanted && !closed) { socket.disconnect(); open(); } });
  const offExpired = auth.on('expired', () => close());

  function start() { wanted = true; open(); }
  function stop() { wanted = false; clearTimeout(retry); retry = undefined; socket.disconnect(); }
  function close() {
    if (closed) return;
    stop(); closed = true; offRenewed(); offExpired(); socket.removeAllListeners();
  }
  function command<T>(event: string, data: object): Promise<T> {
    if (!socket.connected) return Promise.reject(new Error('Reconnecting. Try again when connected.'));
    if (pending >= MAX_PENDING) return Promise.reject(new Error('Too many pending commands. Try again.'));
    const mine = generation;
    pending++;
    const result = tail.then(async () => {
      // Never replay a queued command into a replacement connection.
      if (!socket.connected || mine !== generation) throw new Error('Connection changed. Try again.');
      const reply = await socket.timeout(8000).emitWithAck(event, data) as { data?: T; error?: string };
      if (reply.error) throw new Error(reply.error);
      return reply.data as T;
    }).finally(() => { pending--; });
    tail = result.catch(() => undefined);
    return result;
  }
  function on<T = unknown>(event: string, handler: (value: T) => void) {
    const listener = (value: T, ack?: () => void) => { try { handler(value); } finally { ack?.(); } };
    socket.on(event, listener);
    return () => { socket.off(event, listener); };
  }
  return { start, stop, close, command, on, get connected() { return socket.connected; } };
}
