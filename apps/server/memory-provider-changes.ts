import type { FastifyInstance } from 'fastify';
import { AppError, uuid, type MemoryScope } from '@space/contracts';
import type { MemoryProvider } from '@space/core/memory';
import type { EventBus } from '@space/events';
import type { MemoryStore } from '@space/postgres/memory';
import { messageMemorySource } from './memory.js';

export function registerMemoryProviderChanges(app: FastifyInstance, getEvents: () => Promise<EventBus>,
  store: MemoryStore, providers: Map<string, MemoryProvider>) {
  const stops: (() => Promise<void>)[] = [];
  app.addHook('onReady', async () => {
    for (const provider of providers.values()) {
      if (!provider.onMessageChanged) continue;
      const notify = provider.onMessageChanged.bind(provider);
      const queue = `memory-provider-${provider.id}`;
      const bus = await getEvents();
      // Keep the subscription in PostgreSQL while every API replica is offline.
      await store.pool.query('INSERT INTO memory_change_providers(provider) VALUES($1) ON CONFLICT DO NOTHING', [provider.id]);
      stops.push(await bus.subscribe(`memory.provider.changed.${provider.id}`, { durable: queue, queue, maxPending: 4 }, async delivery => {
        const { id, data } = delivery.event;
        const scope: MemoryScope = { workspace_id: uuid(data.workspace_id), channel_id: uuid(data.channel_id) };
        const messageId = uuid(data.message_id);
        const change = { event_id: id, message_id: messageId, revision: String(data.revision) };
        const signal = AbortSignal.timeout(10_000);
        const readSource = async () => {
          signal.throwIfAborted();
          if (data.can_refresh !== true) return null;
          try {
            const message = await store.message(store.db, scope, messageId, { provider: provider.id, revision: change.revision });
            signal.throwIfAborted();
            return messageMemorySource(message);
          } catch (error) {
            if (error instanceof AppError && error.status === 404) return null;
            throw error;
          }
        };
        await notify(scope, data.type === 'deleted' ? { ...change, type: 'deleted' } : { ...change, type: 'edited', readSource }, signal);
        await delivery.ack();
      }));
    }
  });
  app.addHook('preClose', async () => { for (const stop of stops) await stop(); });
}
