// Collect routes on the actual API while Fastify registers its modules.
import { channel } from 'node:diagnostics_channel';

export function collectRoutes(create) {
  const routes = new Set();
  const initialization = channel('fastify.initialization');
  const observe = ({ fastify }) => fastify.addHook('onRoute', ({ method, url }) => {
    for (const verb of [method].flat()) routes.add(verb + ' ' + url);
  });
  initialization.subscribe(observe);
  let app;
  try { app = create(); } finally { initialization.unsubscribe(observe); }
  // Authentication is mounted on a wildcard. Track the individual web client flows.
  routes.delete('POST /v1/auth/*');
  routes.delete('GET /v1/auth/*');
  for (const path of ['sign-up/email', 'sign-in/email', 'refresh', 'sign-out', 'send-verification-email']) routes.add('POST /v1/auth/' + path);
  for (const path of ['get-session', 'verify-email']) routes.add('GET /v1/auth/' + path);
  return { app, routes };
}
