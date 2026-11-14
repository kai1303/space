import { record } from '@space/contracts';
import type { ComposerDraftStore } from '@space/postgres/composer-drafts';
import type { ScheduledMessageStore } from '@space/postgres/scheduled-messages';
import type { ChatStore } from '@space/postgres/chat';
import type { FastifyInstance } from 'fastify';
import { expectedActor } from './expected-actor.js';

export function registerComposerDraftRoutes(app: FastifyInstance, store: ComposerDraftStore, chat: ChatStore, scheduled: ScheduledMessageStore) {
  app.get('/v1/composer-drafts', request => {
    const { after } = record(request.query, ['after']);
    return store.list(expectedActor(request), after);
  });
  app.get<{ Params: { key: string } }>('/v1/composer-drafts/:key', request =>
    store.get(expectedActor(request), request.params.key));
  app.post<{ Params: { key: string } }>('/v1/composer-drafts/:key/send', { bodyLimit: 131072 }, async (request, reply) => {
    await store.submit({send:chat}, expectedActor(request), request.params.key, request.body);
    return reply.code(204).send();
  });
  app.post<{ Params: { key: string } }>('/v1/composer-drafts/:key/schedule', async (request, reply) => {
    await store.submit({schedule:scheduled}, expectedActor(request), request.params.key, request.body);
    return reply.code(204).send();
  });
  app.put<{ Params: { key: string } }>('/v1/composer-drafts/:key', { bodyLimit: 104 * 1024 }, request =>
    store.put(expectedActor(request), request.params.key, request.body));
}
