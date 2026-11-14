import type { FastifyRequest } from 'fastify';
import { AppError, uuid } from '@space/contracts';

export function expectedActor(request: FastifyRequest) {
  const expected = request.headers['x-expected-actor'];
  if (expected !== undefined && uuid(expected) !== request.actorId) throw new AppError(409, 'actor_changed');
  return request.actorId;
}
