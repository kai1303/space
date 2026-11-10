import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, record, uuid } from '@space/contracts';
import { replySuggestionProvider, threadSummaryProvider } from '@space/core/reply-suggestion';
import type { ChatStore } from '@space/postgres/chat';

export function registerReplySuggestions(app: FastifyInstance, chat: ChatStore) {
  const generate = replySuggestionProvider(process.env);
  const summarize = threadSummaryProvider(process.env);
  const cache = new Map<string, { digest: string; suggestion: string; expires: number }>();
  const active = new Set<string>();
  app.post<{ Params: { threadId: string } }>('/v1/threads/:threadId/reply-suggestion', async (request, reply) => {
    record(request.body, []);
    const thread = uuid(request.params.threadId), actor = request.actorId;
    if (!generate || !summarize) return { suggestion: null };
    if (active.size >= 8 || active.has(actor)) throw new AppError(429, 'reply_suggestion_busy');
    active.add(actor);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
    const disconnect = () => abort.abort();
    reply.raw.once('close', disconnect);
    try {
      let context = await chat.replySuggestionContext(actor, thread);
      while (context.older.length) {
        if (signal.aborted) return { suggestion: null };
        const compacted = await summarize(context.older, context.summary, signal).catch(() => null);
        if (!compacted || signal.aborted) return { suggestion: null };
        await chat.saveReplySummary(actor, thread, context, context.older[compacted.count - 1]!, compacted.summary);
        context = await chat.replySuggestionContext(actor, thread);
      }
      const { messages, summary, viewer, revision } = context;
      if (!messages.some(message => message.text.trim())) return { suggestion: null };
      const key = `${actor}:${thread}`;
      const digest = createHash('sha256').update(JSON.stringify([messages, summary, viewer, revision])).digest('hex');
      const cached = cache.get(key);
      if (cached && cached.digest === digest && cached.expires > Date.now()) {
        return { suggestion: cached.suggestion };
      }
      const suggestion = await generate(messages, signal, summary, viewer).catch(() => null);
      if (suggestion) {
        const current = await chat.replySuggestionContext(actor, thread);
        if (current.revision !== revision || current.messages.at(-1)?.sequence !== messages.at(-1)?.sequence) return { suggestion: null };
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
