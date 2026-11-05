import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, record, uuid } from '@space/contracts';
import { replySuggestionProvider } from '@space/core/reply-suggestion';
import type { ChatStore } from '@space/postgres/chat';

export function registerReplySuggestions(app: FastifyInstance, chat: ChatStore) {
  const generate = replySuggestionProvider(process.env);
  const cache = new Map<string, { digest: string; suggestion: string; expires: number }>();
  const active = new Set<string>();
  app.post<{ Params: { threadId: string } }>('/v1/threads/:threadId/reply-suggestion', async (request, reply) => {
    record(request.body, []);
    const thread = uuid(request.params.threadId), actor = request.actorId;
    if (!generate) return { suggestion: null };
    if (active.size >= 8 || active.has(actor)) throw new AppError(429, 'reply_suggestion_busy');
    active.add(actor);
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    reply.raw.once('close', disconnect);
    try {
      const messages = await chat.replySuggestionContext(actor, thread);
      if (!messages.some(message => message.text.trim())) return { suggestion: null };
      const key = `${actor}:${thread}`;
      const digest = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
      const cached = cache.get(key);
      if (cached && cached.digest === digest && cached.expires > Date.now()) {
        return { suggestion: cached.suggestion };
      }
      const suggestion = await generate(messages, abort.signal).catch(() => null);
      if (suggestion) {
        await chat.requireThreadAccess(actor, thread);
        cache.delete(key);
        if (cache.size >= 512) cache.delete(cache.keys().next().value!);
        cache.set(key, { digest, suggestion, expires: Date.now() + 5 * 60_000 });
      }
      return { suggestion };
    } finally {
      reply.raw.off('close', disconnect);
      active.delete(actor);
    }
  });
}
