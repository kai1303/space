import { io, type Socket } from 'socket.io-client';
import { invalidateSocketCommands } from './socket-command.js';
import { clearLiveReceipts, enableLiveReceipts, finishLiveReceipt } from './live-receipts.js';

type Handler = (value: any) => unknown;
export type RealtimeLease = { socket: Socket; connect: () => void; recover: () => void; expire: () => void; on: (event: string, handler: Handler) => () => void; release: () => void };
type Transport = ReturnType<typeof createTransport>;
let current: Transport | undefined;

function createTransport() {
  const socket = io({ transports: ['websocket'], withCredentials: true, autoConnect: false, auth: { live_receipts: 1 },
    reconnectionDelay: 1000, reconnectionDelayMax: 30_000, randomizationFactor: 0.5 });
  const listeners = new Map<string, Set<Handler>>();
  const bindings = new Map<string, (...args: any[]) => void>();
  let references = 0, closed = false, terminal = false, delay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const dispatch = (event: string, value?: unknown) => {
    let accepted = false;
    for (const handler of [...(listeners.get(event) ?? [])]) if (handler(value) === true) accepted = true;
    return accepted;
  };
  const connect = () => { if (!closed && !terminal && !socket.connected && !socket.active) socket.connect(); };
  const reconnect = () => {
    if (closed || terminal || retry || socket.active) return;
    const wait = delay * (0.75 + Math.random() * 0.5);
    retry = setTimeout(() => { retry = undefined; connect(); }, wait);
    delay = Math.min(delay * 2, 30_000);
  };
  const unauthorized = (source?: Event) => {
    if (closed || terminal) return;
    terminal = true; clearTimeout(retry); invalidateSocketCommands(socket);
    dispatch('session.revoked', { error: 'unauthorized' });
    socket.disconnect();
    if (!source) window.dispatchEvent(new Event('space:session-expired'));
  };
  const bind = (event: string, handler: (...args: any[]) => void) => { bindings.set(event, handler); socket.on(event, handler); };
  bind('chat.receipts.enabled', () => enableLiveReceipts(socket));
  bind('chat.receipt.confirmed', (id: string, ack: (ms: number | null) => void) => ack(finishLiveReceipt(socket, id)));
  bind('connect', () => { clearTimeout(retry); retry = undefined; delay = 1000; dispatch('connect'); });
  bind('disconnect', reason => { clearLiveReceipts(socket); invalidateSocketCommands(socket); dispatch('disconnect', reason); if (reason === 'io server disconnect') reconnect(); });
  bind('connect_error', error => { if (error.message === 'unauthorized') unauthorized(); else { dispatch('connect_error', error); reconnect(); } });
  bind('chat.error', error => { if (error.error === 'unauthorized') unauthorized(); else dispatch('chat.error', error); });
  const focus = () => { if (!closed && !terminal && !document.hidden) { dispatch('focus'); connect(); } };
  window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
  window.addEventListener('space:session-expired', unauthorized);
  const close = () => {
    if (closed) return;
    closed = true; clearLiveReceipts(socket); clearTimeout(retry); invalidateSocketCommands(socket);
    for (const [event, handler] of bindings) socket.off(event, handler);
    listeners.clear(); socket.disconnect();
    window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus);
    window.removeEventListener('space:session-expired', unauthorized);
    if (current === transport) current = undefined;
  };
  const recover = () => { if (!closed && !terminal) { socket.disconnect(); reconnect(); } };
  const transport = { socket, connect, close,
    acquire() {
      references++;
      let released = false;
      const cleanups = new Set<() => void>();
      return { socket, connect, recover, expire: () => unauthorized(),
        on(event: string, handler: Handler) {
          let callbacks = listeners.get(event);
          if (!callbacks) {
            callbacks = new Set(); listeners.set(event, callbacks);
            if (!bindings.has(event) && event !== 'focus' && event !== 'session.revoked') {
              bind(event, (value, ack?: (accepted?: boolean) => void) => {
                let accepted = false;
                try { accepted = dispatch(event, value); }
                finally { if (accepted && event === 'chat.events' && value?.receipt_requested === true) ack?.(true); else ack?.(); }
              });
            }
          }
          callbacks.add(handler);
          const off = () => { callbacks.delete(handler); cleanups.delete(off); };
          cleanups.add(off); return off;
        },
        release() {
          if (released) return;
          released = true; for (const cleanup of [...cleanups]) cleanup();
          if (--references === 0) close();
        },
      };
    },
  };
  return transport;
}

export function acquireRealtime(): RealtimeLease { current ??= createTransport(); return current.acquire(); }
// The signed-in root holds this lease so navigation never tears down the transport.
export function retainRealtimeSession() { const lease = acquireRealtime(); lease.connect(); return () => lease.release(); }
if (import.meta.hot) import.meta.hot.dispose(() => { current?.close(); });
