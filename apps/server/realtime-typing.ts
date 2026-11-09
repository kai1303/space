import type { TypingEvent } from '@space/contracts';

type Listener = (event: TypingEvent) => void;
type Pump = (active: () => boolean, read: () => Promise<void>, revoke: (error: unknown) => void) => () => void;

interface TypingSubscription {
  channel: string;
  socketId: string;
  pump: Pump;
  active: () => boolean;
  readAccess: () => Promise<{ archived: boolean }>;
  emit: Listener;
  revoke: (error: unknown) => void;
}

export class TypingListeners {
  private readonly channels = new Map<string, Set<Listener>>();

  publish(event: TypingEvent) {
    for (const listener of this.channels.get(event.channel_id) ?? []) listener(event);
  }

  subscribe({ channel, socketId, pump, active, readAccess, emit, revoke }: TypingSubscription) {
    const pending = new Map<string, TypingEvent>();
    const wake = pump(active, async () => {
      const events = [...pending.values()];
      pending.clear();
      const access = await readAccess();
      if (!active()) return;
      for (const event of events) {
        if (!event.active || event.expires_at > Date.now()) emit(access.archived ? { ...event, active: false } : event);
      }
    }, revoke);
    const listener: Listener = event => {
      if (event.source_id === socketId) return;
      const key = event.source_id + ':' + (event.thread_id ?? '');
      if (!pending.has(key) && pending.size >= 64) pending.delete(pending.keys().next().value!);
      pending.set(key, event);
      wake();
    };
    const listeners = this.channels.get(channel) ?? new Set<Listener>();
    listeners.add(listener);
    this.channels.set(channel, listeners);
    return () => {
      pending.clear();
      listeners.delete(listener);
      if (!listeners.size) this.channels.delete(channel);
    };
  }
}
