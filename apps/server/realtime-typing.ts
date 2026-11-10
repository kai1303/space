import type { TypingEvent } from '@space/contracts';

type Listener = (event: TypingEvent) => void;
type Pump = (active: () => boolean, read: () => Promise<void>, revoke: (error: unknown) => void) => () => void;

interface TypingSubscription {
  key: string;
  socketId: string;
  pump: Pump;
  active: () => boolean;
  authorizeEvents: (events: TypingEvent[]) => Promise<TypingEvent[]>;
  emit: Listener;
  revoke: (error: unknown) => void;
}

export class TypingListeners {
  private readonly channels = new Map<string, Set<Listener>>();

  publish(event: TypingEvent, key = event.channel_id) {
    for (const listener of this.channels.get(key) ?? []) listener(event);
  }

  subscribe({ key, socketId, pump, active, authorizeEvents, emit, revoke }: TypingSubscription) {
    const pending = new Map<string, TypingEvent>();
    const wake = pump(active, async () => {
      const events = [...pending.values()];
      pending.clear();
      const allowed = await authorizeEvents(events);
      if (!active()) return;
      for (const event of allowed) {
        if (!event.active || event.expires_at > Date.now()) emit(event);
      }
    }, revoke);
    const listener: Listener = event => {
      if (event.source_id === socketId) return;
      const key = event.channel_id + ':' + event.source_id + ':' + (event.thread_id ?? '');
      if (!pending.has(key) && pending.size >= 64) pending.delete(pending.keys().next().value!);
      pending.set(key, event);
      wake();
    };
    const listeners = this.channels.get(key) ?? new Set<Listener>();
    listeners.add(listener);
    this.channels.set(key, listeners);
    return () => {
      pending.clear();
      listeners.delete(listener);
      if (!listeners.size) this.channels.delete(key);
    };
  }
}
