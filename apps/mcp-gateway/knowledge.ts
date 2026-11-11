import {
  AppError,
  isDirectoryKind,
  isAssetDownloadPath, isMessagePath,
  record,
  text,
  uuid,
  type KnowledgeManifest,
  type KnowledgeContext,
  type KnowledgeHit,
  type KnowledgePluginV1,
  type KnowledgeSearch,
  type KnowledgeRef,
  type OutboundTool,
  type ConnectionKind,
} from '@space/contracts';
import { channelManifest } from '@space/postgres/channel-knowledge';
import { peopleManifest } from '@space/postgres/people-knowledge';
import { knowledgeClient } from './local-pg-knowledge.js';
import type { RemoteMcp, RemoteConnection } from './remote.js';

type Remote = Pick<RemoteMcp, 'call' | 'discover'>;
type Connection = RemoteConnection & { id: string; kind?: ConnectionKind };
const search = 'knowledge_search',
  resolve = 'knowledge_resolve',
  manifest = 'knowledge_manifest';
const string = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const invalid = () => new AppError(502, 'invalid_knowledge_response');

function toolsFor(plugin: KnowledgeManifest, connectionId: string, canResolve: boolean): OutboundTool[] {
  const filters = Object.fromEntries(
    (plugin.filters ?? []).map((f) => [
      f.key,
      { ...string(128), description: f.description, ...(f.values ? { enum: f.values } : {}) },
    ]),
  );
  const tools = [
    {
      name: search,
      description: plugin.name + '. ' + plugin.description + ' Use an empty query to list by filter.',
      inputSchema: object(
        {
          query: { type: 'string', maxLength: 500 },
          filters: object(filters, []),
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          cursor: string(1024),
        },
        ['query'],
      ),
    },
  ];
  if (canResolve)
    tools.push({
      name: resolve,
      description: 'Resolve an exact ' + plugin.name + ' record from connection ' + connectionId + '.',
      inputSchema: object(
        {
          ref: object({ connectionId: { const: connectionId }, recordId: string(512) }, [
            'connectionId',
            'recordId',
          ]),
        },
        ['ref'],
      ),
    });
  return tools;
}

function parseManifest(raw: unknown): KnowledgeManifest {
  const m = record(raw, ['apiVersion', 'name', 'description', 'filters']);
  if (m.apiVersion !== 1 || (m.filters !== undefined && (!Array.isArray(m.filters) || m.filters.length > 16)))
    throw invalid();
  const filters = (m.filters as unknown[] | undefined)?.map((item) => {
    const f = record(item, ['key', 'description', 'values']);
    const key = text(f.key, 64);
    if (!/^[a-z][a-z0-9_]*$/.test(key) || key in Object.prototype) throw invalid();
    if (f.values !== undefined && (!Array.isArray(f.values) || !f.values.length || f.values.length > 50))
      throw invalid();
    return {
      key,
      description: text(f.description, 256),
      ...(Array.isArray(f.values) ? { values: f.values.map((v) => text(v, 128)) } : {}),
    };
  });
  if (filters && new Set(filters.map((f) => f.key)).size !== filters.length) throw invalid();
  return { apiVersion: 1, name: text(m.name, 100), description: text(m.description, 1000), filters };
}

async function upstream(
  remote: Remote,
  connection: Connection,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const result = await remote.call(connection, name, args, signal);
  if (result.isError) throw new AppError(502, 'knowledge_provider_failed');
  if (!result.structuredContent) throw invalid();
  return result.structuredContent;
}

export async function discoverKnowledge(remote: Remote, connection: Connection, signal: AbortSignal) {
  if (connection.kind === 'channels') return toolsFor(channelManifest, connection.id, true);
  if (connection.kind === 'people') return toolsFor(peopleManifest, connection.id, true);
  remote = knowledgeClient(remote, connection);
  const offered = await remote.discover(connection, signal);
  if (![manifest, search].every((name) => offered.some((t) => t.name === name))) throw invalid();
  const provider = parseManifest(await upstream(remote, connection, manifest, {}, signal));
  return toolsFor(
    provider,
    connection.id,
    offered.some((t) => t.name === resolve),
  );
}

function parseRef(value: unknown): KnowledgeRef {
  const r = record(value, ['connectionId', 'recordId']);
  return { connectionId: uuid(r.connectionId), recordId: text(r.recordId, 512) };
}
function parseHit(raw: unknown, connectionId: string): KnowledgeHit {
  const h = record(raw, ['ref', 'title', 'evidence', 'citation', 'facts']);
  const ref = parseRef(h.ref),
    c = record(h.citation, ['label', 'url']);
  if (ref.connectionId !== connectionId) throw invalid();
  const href = text(c.url, 2048);
  const url = isMessagePath(href) || isAssetDownloadPath(href) ? undefined : new URL(href);
  if (url && (url.protocol !== 'https:' || url.username || url.password)) throw invalid();
  if (h.facts !== undefined && (!Array.isArray(h.facts) || h.facts.length > 50)) throw invalid();
  const facts = (h.facts as unknown[] | undefined)?.map((rawFact) => {
    const f = record(rawFact, ['subject', 'predicate', 'value']);
    return {
      subject: parseRef(f.subject),
      predicate: text(f.predicate, 128),
      value: typeof f.value === 'string' ? text(f.value, 2048) : parseRef(f.value),
    };
  });
  return {
    ref,
    title: text(h.title, 256),
    evidence: text(h.evidence, 8000),
    citation: { label: text(c.label, 256), url: url?.href ?? href },
    ...(facts ? { facts } : {}),
  };
}

function remotePlugin(
  remote: Remote,
  connection: Connection,
  signal: AbortSignal,
): Pick<KnowledgePluginV1, 'search' | 'resolve'> {
  return {
    async search(context, request) {
      const raw = await upstream(remote, connection, search, { context, request }, signal);
      try {
        const page = record(raw, ['hits', 'nextCursor']);
        if (!Array.isArray(page.hits) || page.hits.length > request.limit) throw invalid();
        return {
          hits: page.hits.map((hit) => parseHit(hit, connection.id)),
          ...(page.nextCursor === undefined ? {} : { nextCursor: text(page.nextCursor, 1024) }),
        };
      } catch {
        throw invalid();
      }
    },
    async resolve(context, ref) {
      const raw = await upstream(remote, connection, resolve, { context, ref }, signal);
      try {
        const { hit } = record(raw, ['hit']);
        if (hit === null) return null;
        const found = parseHit(hit, connection.id);
        if (found.ref.recordId !== ref.recordId) throw invalid();
        return found;
      } catch {
        throw invalid();
      }
    },
  };
}

// The agent-facing schema was generated from the discovered manifest and validated before dispatch.
export async function callKnowledge(
  directory: KnowledgePluginV1 | undefined,
  remote: Remote,
  connection: Connection,
  name: string,
  args: Record<string, unknown>,
  context: KnowledgeContext,
  signal: AbortSignal,
) {
  const plugin = isDirectoryKind(connection.kind) ? directory : remotePlugin(knowledgeClient(remote, connection), connection, signal);
  if (!plugin) throw new AppError(503, 'directory_unavailable');
  let result;
  if (name === search) {
    const request = args as unknown as KnowledgeSearch;
    result = await plugin.search(context, { ...request, limit: request.limit ?? 10 });
  } else if (name === resolve && plugin.resolve) {
    const ref = parseRef(args.ref);
    if (ref.connectionId !== connection.id) throw new AppError(400, 'wrong_knowledge_connection');
    result = { hit: await plugin.resolve(context, ref) };
  } else throw new AppError(403, 'tool_not_allowed');
  return {
    isError: false,
    structuredContent: { ...result },
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}
