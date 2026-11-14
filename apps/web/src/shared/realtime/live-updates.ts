import { acquireRealtime } from './socket-session.js';
import { socketCommand } from './socket-command.js';

type Scope = 'actor' | 'workspace' | 'channel' | 'thread' | 'task' | 'session-team';
type Update = { scope: Scope; id: string; error?: string };
type Listener = { refresh: () => unknown; onRevoked?: (code: string) => void; active: boolean; running: boolean; pending: boolean; completion?: Promise<void> };
type Subscription = { listeners: Set<Listener>; close: () => void; version?: object };
const subscriptions = new Map<string, Subscription>();
const denied = (code: string) => ['unauthorized', 'not_found', 'forbidden', 'subscription_limit', 'invalid_scope', 'invalid_id'].includes(code);

async function refresh(listener: Listener) {
  listener.pending = true;
  if (listener.running) return listener.completion;
  listener.running = true;
  let complete!: () => void;
  listener.completion = new Promise<void>(resolve => { complete = resolve; });
  try {
    while (listener.active && listener.pending) {
      listener.pending = false;
      try { await listener.refresh(); } catch { /* Views expose read failures; reconnect or focus retries. */ }
    }
  } finally { listener.running = false; complete(); listener.completion = undefined; }
}

// A page can be reused only while the same acknowledged subscription has seen no changes.
export function workspaceReadVersion(workspace: string) {
  return subscriptions.get(`workspace:${workspace}`)?.version;
}

export async function invalidateUpdates(scope: Scope, id: string): Promise<void> {
  const subscription = subscriptions.get(`${scope}:${id}`);
  if (!subscription) return;
  if (subscription.version) subscription.version = {};
  await Promise.all([...subscription.listeners].map(refresh));
}

export function subscribeUpdates(scope: Scope, id: string, read: () => unknown, onRevoked?: (code: string) => void): () => void {
  const key = `${scope}:${id}`;
  let subscription = subscriptions.get(key);
  if (!subscription) {
    const connection = acquireRealtime(), socket = connection.socket;
    const listeners = new Set<Listener>();
    let active = true, subscribing = false, pending = false, generation = 0;
    const notify = (acknowledged = false) => {
      if (subscription && (acknowledged || subscription.version)) subscription.version = {};
      for (const listener of listeners) void refresh(listener);
    };
    const matches = (update: Update) => update?.scope === scope && update.id === id;
    const revoke = (code: string) => {
      if (!active) return;
      active = false; subscriptions.delete(key);
      for (const listener of listeners) {
        if (listener.onRevoked) { listener.active = false; listener.pending = false; listener.onRevoked(code); }
        else void refresh(listener);
      }
      connection.release();
      if (code === 'unauthorized') connection.expire();
    };
    const subscribe = async () => {
      if (!active || !socket.connected) return;
      if (subscribing) { pending = true; return; }
      subscribing = true;
      const attempt = generation;
      try {
        await socketCommand(socket, 'updates.subscribe', { scope, id });
        if (active && attempt === generation) notify(true);
      } catch (error) {
        if (!active || attempt !== generation) return;
        const code = error instanceof Error ? error.message : '';
        if (denied(code)) revoke(code);
        else connection.recover();
      } finally {
        subscribing = false;
        if (pending) { pending = false; void subscribe(); }
      }
    };
    connection.on('connect', () => { void subscribe(); });
    connection.on('disconnect', () => { generation++; if (subscription) subscription.version = undefined; });
    connection.on('updates.changed', (update: Update) => { if (active && matches(update)) notify(); });
    connection.on('updates.revoked', (update: Update) => { if (matches(update)) revoke(update.error ?? 'not_found'); });
    connection.on('session.revoked', () => revoke('unauthorized'));
    connection.on('focus', () => notify());
    subscription = { listeners, close: () => {
      if (!active) return;
      active = false;
      if (socket.connected) void socketCommand(socket, 'updates.unsubscribe', { scope, id }).catch(() => {});
      connection.release();
    } };
    subscriptions.set(key, subscription);
    if (socket.connected) void subscribe();
    // Attach the first read before connecting, including when test transports connect synchronously.
    queueMicrotask(() => { if (active) connection.connect(); });
  }
  const listener: Listener = { refresh: read, onRevoked, active: true, running: false, pending: false };
  subscription.listeners.add(listener); void refresh(listener);
  return () => {
    if (!listener.active && !subscription.listeners.has(listener)) return;
    listener.active = false; subscription.listeners.delete(listener);
    if (!subscription.listeners.size) { subscription.close(); if (subscriptions.get(key) === subscription) subscriptions.delete(key); }
  };
}
