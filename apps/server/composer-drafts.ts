import { record } from '@space/contracts';
import type { ComposerDraftStore } from '@space/postgres/composer-drafts';
import type { FastifyInstance } from 'fastify';
import { expectedActor } from './expected-actor.js';

export function registerComposerDraftRoutes(app: FastifyInstance, store: ComposerDraftStore) {
  app.get('/v1/composer-drafts', request => {
    const { after } = record(request.query, ['after']);
    return store.list(expectedActor(request), after);
  });
  app.get<{ Params: { key: string } }>('/v1/composer-drafts/:key', request =>
    store.get(expectedActor(request), request.params.key));
  app.put<{ Params: { key: string } }>('/v1/composer-drafts/:key', { bodyLimit: 104 * 1024 }, request =>
    store.put(expectedActor(request), request.params.key, request.body));
}
