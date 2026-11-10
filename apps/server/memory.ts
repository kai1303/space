import { messagePath } from '@space/contracts';
import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { AppError, parseAgentMemoryContext, MAX_AGENT_MEMORY_CHARS, MAX_MEMORY_IMPORT_BYTES, memorySourceId, parseMemorySettings, parseMemorySource, parseMemoryWrite, record, text, uuid, type ChannelMemory } from '@space/contracts';
import type { AgentMemoryContext, Task } from '@space/contracts';
import type { MemoryProvider } from '@space/core/memory';
import { MemoryStore, type MemoryChannel } from '@space/postgres/memory';
import { readThreadContext } from '@space/postgres/thread-context';
import { MarkdownMemoryProvider } from './markdown-memory.js';

export type MemoryOptions = { directory?: string; providers?: MemoryProvider[] };
export function createMemoryProviders(options: MemoryOptions = {}) {
  const providers = new Map<string, MemoryProvider>();
  for (const provider of [new MarkdownMemoryProvider(options.directory ?? process.env.MEMORY_DIRECTORY ?? fileURLToPath(new URL('../../../.space-memory/', import.meta.url))), ...(options.providers ?? [])]) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider.id) || providers.has(provider.id)) throw new Error('Invalid or duplicate memory provider');
    providers.set(provider.id, provider);
  }
  return providers;
}
export function memoryProviderFor(providers: Map<string, MemoryProvider>, channel: MemoryChannel, requireEnabled = true) {
  if (requireEnabled && !channel.enabled) throw new AppError(409, 'memory_disabled');
  const provider = providers.get(channel.provider);
  if (!provider) throw new AppError(503, 'memory_provider_unavailable');
  return provider;
}
// Read external providers outside database transactions, then recheck the live permission.
export function createAgentMemoryReader(store: MemoryStore, providers = createMemoryProviders()) {
  let activeReads = 0;
  return (task: Pick<Task, 'installation_id' | 'requester_id' | 'thread_id'>): Promise<AgentMemoryContext | undefined> => store.agentContext(task, async channel => {
    const provider = memoryProviderFor(providers, channel);
    if (activeReads >= 8) throw new AppError(503, 'memory_provider_busy');
    activeReads++;
    const reading = Promise.resolve().then(() => provider.read(channel)).finally(() => { activeReads--; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const document = await Promise.race([reading, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError(503, 'memory_provider_timeout')), 5000);
      })]);
      let content = document.content.slice(0, MAX_AGENT_MEMORY_CHARS);
      if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
      return parseAgentMemoryContext({ channel_id: channel.channel_id, provider: channel.provider, revision: document.revision, content, truncated: content.length < document.content.length });
    } finally { clearTimeout(timer); }
  });
}
export function registerMemoryRoutes(app: FastifyInstance, store: MemoryStore, providers = createMemoryProviders()) {
  const providerFor = (channel: MemoryChannel, requireEnabled = true) => {
    return memoryProviderFor(providers, channel, requireEnabled);
  };
  const state = async (channel: MemoryChannel): Promise<ChannelMemory> => ({
    enabled: channel.enabled, provider: channel.provider, can_manage: channel.can_manage,
    providers: [...providers.values()].map(({ id, name }) => ({ id, name })),
    document: channel.enabled ? await providerFor(channel).read(channel) : null,
  });
  const threadPath = '/v1/channels/:channelId/threads/:threadId/context';
  app.get<{ Params: { channelId: string; threadId: string } }>(threadPath, r => {
    record(r.query, []);
    return store.channel(r.actorId, r.params.channelId, (channel, c) => readThreadContext(c, channel.channel_id, uuid(r.params.threadId)));
  });
  app.post<{ Params: { channelId: string; threadId: string } }>(`${threadPath}/connections`, async (r, reply) =>
    reply.code(201).send(await store.createConnection(r.actorId, uuid(r.params.channelId), r.body, uuid(r.params.threadId))));
  const path = '/v1/channels/:channelId/memory';
  app.get<{ Params: { channelId: string } }>(`${path}/agents`, r => store.agents(r.actorId, uuid(r.params.channelId)));
  app.post<{ Params: { channelId: string; installationId: string } }>(`${path}/agents/:installationId`, r =>
    store.setAgentAccess(r.actorId, uuid(r.params.channelId), uuid(r.params.installationId), r.body));
  app.get<{ Params: { channelId: string } }>(`${path}/connections`, r => store.connections(r.actorId, uuid(r.params.channelId)));
  app.post<{ Params: { channelId: string } }>(`${path}/connections`, async (r, reply) => reply.code(201).send(await store.createConnection(r.actorId, uuid(r.params.channelId), r.body)));
  app.post<{ Params: { channelId: string; connectionId: string } }>(`${path}/connections/:connectionId/revoke`, r => {
    record(r.body, []);
    return store.revokeConnection(r.actorId, uuid(r.params.channelId), uuid(r.params.connectionId));
  });
  app.get<{ Params: { channelId: string } }>(path, r => {
    record(r.query, []);
    return store.channel(r.actorId, r.params.channelId, state);
  });
  app.post<{ Params: { channelId: string } }>(`${path}/settings`, r => {
    const input = parseMemorySettings(r.body);
    return store.channel(r.actorId, r.params.channelId, async (channel, c) => {
      if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
      const provider = input.provider ?? channel.provider;
      if ((input.enabled || input.provider) && !providers.has(provider)) throw new AppError(400, 'invalid_memory_provider');
      return state(await store.configure(c, channel, input.enabled, provider));
    });
  });
  app.post<{ Params: { channelId: string } }>(`${path}/document`, { bodyLimit: 850_000 }, r => {
    const input = parseMemoryWrite(r.body);
    return store.channel(r.actorId, r.params.channelId, channel => providerFor(channel).write(channel, input.content, input.revision));
  });
  app.post<{ Params: { channelId: string } }>(`${path}/sources`, { bodyLimit: 650_000 }, r => {
    const input = parseMemorySource(r.body);
    return store.channel(r.actorId, r.params.channelId, async (channel, c) => {
      const provider = providerFor(channel);
      if ('message_id' in input) {
        const message = await store.message(c, channel, input.message_id);
        const attachments = message.attachments?.map(asset => `Attachment: ${asset.name} (file content not imported)`).join('\n');
        return provider.ingest(channel, { id: `message:${message.id}`, title: `Message from ${message.author.name} · ${message.created_at}`,
          text: [message.text, attachments].filter(Boolean).join('\n'), url: messagePath(channel.channel_id, message.id) });
      }
      if (Buffer.byteLength(input.content, 'utf8') > MAX_MEMORY_IMPORT_BYTES) throw new AppError(413, 'memory_import_too_large');
      const now = new Date().toISOString();
      return provider.ingest(channel, { id: `document:${input.source_id}`, title: `${input.name} · ${now}`, text: `Imported by ${r.actorId}\n\n${input.content}` });
    });
  });
  app.delete<{ Params: { channelId: string; sourceId: string } }>(`${path}/sources/:sourceId`, r => {
    const id = memorySourceId(r.params.sourceId);
    return store.channel(r.actorId, r.params.channelId, channel => providerFor(channel).remove(channel, id));
  });
  app.get<{ Params: { channelId: string }; Querystring: { q?: unknown } }>(`${path}/search`, r => {
    record(r.query, ['q']);
    const query = text(r.query.q, 200);
    return store.channel(r.actorId, r.params.channelId, async channel => ({ items: await providerFor(channel).search(channel, query) }));
  });
  app.delete<{ Params: { channelId: string } }>(path, r => store.channel(r.actorId, r.params.channelId, async channel => {
    if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
    await providerFor(channel, false).clear(channel);
    return { deleted: true };
  }));
}
