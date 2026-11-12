// One instance per Space database schema. Reads committed changes from a logical replication slot and keeps
// the Graph RAG memory store current: nodes, links and message vectors. On any failure it exits so the
// supervisor restarts it; the slot keeps every unconfirmed change, and every graph write is guarded, so a
// restart repeats nothing harmful.
//   GRAPH_SOURCE_URL       Space database; may create the publication and slot; can read the graph_source_messages view
//   GRAPH_REPLICATION_URL  Space database role with REPLICATION
//   GRAPH_INDEX_URL        knowledge database writer (memory-graph.sql applied)
//   GRAPH_SOURCE_SCHEMA    schema holding the Space tables (default public)
// Embeddings come from the local Ollama all-minilm:22m model.
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { createPool } from '@space/postgres/database';
import { TABLES, lsnToVersion, planChange } from './graph-plan.mjs';
import { sourceLookup } from './graph-source.mjs';
import { applyOps, fillChannelText, publish, publishNeeded, rebuild, resyncChannel, savedPosition } from './graph-apply.mjs';

const schema = process.env.GRAPH_SOURCE_SCHEMA ?? 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid GRAPH_SOURCE_SCHEMA');
const slot = ('space_graph_' + schema).slice(0, 63), publication = slot;
// The legacy space_knowledge reader consumed this same WAL slot. Its LSN cannot certify space_memory.
const checkpoint = 'space_memory:' + slot;
const source = createPool(process.env.GRAPH_SOURCE_URL);
const index = createPool(process.env.GRAPH_INDEX_URL);
const lookup = sourceLookup(source);
const CHUNK = 500, PUBLISH_DELAY_MS = 1000, LAG_REPORT_MS = 60000;
let buffer = [], saved = 0n, publishTimer, publishing = Promise.resolve(), lastReport = 0, confirmed = '0/0';
// pgGraph refuses `build_graph` while a registered source transaction is open (error PG006). So graph
// writes and publishes run one at a time inside this process. This is an in-process queue, not a
// database or distributed lock.
let queue = Promise.resolve();
const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };

// Column lists keep message text and knowledge content out of the stream: only ids, flags and channel
// labels (name, topic, description) leave Space this way.
async function prepare() {
  const q = name => `"${schema}"."${name}"`;
  const { rowCount } = await source.query('SELECT 1 FROM pg_publication WHERE pubname=$1', [publication]);
  if (!rowCount) await source.query(`CREATE PUBLICATION "${publication}"`).catch(error => { if (error.code !== '42710') throw error; });
  await source.query(`ALTER PUBLICATION "${publication}" SET (publish_via_partition_root = true)`);
  await source.query(`ALTER PUBLICATION "${publication}" SET TABLE
    ${q('channels')} (id, workspace_id, name, private, kind, memory_enabled, knowledge_enabled, topic, description),
    ${q('messages')} (id, workspace_id, channel_id, thread_id, agent_session_id, search_revision, deleted_at, retained_at),
    ${q('knowledge_notes')} (id, workspace_id, channel_id, kind, title, evidence, revision, removed_at),
    ${q('agent_sessions')} (id, workspace_id, origin_thread_id, title, state),
    ${q('knowledge_thread_channels')}`);
  let { rows: [state] } = await source.query('SELECT wal_status, confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name=$1', [slot]);
  if (state?.wal_status === 'lost') {
    console.error('Replication slot was lost; rebuilding the graph');
    await source.query('SELECT pg_drop_replication_slot($1)', [slot]);
    state = undefined;
  }
  if (!state) await source.query("SELECT pg_create_logical_replication_slot($1,'pgoutput')", [slot]).catch(error => { if (error.code !== '42710') throw error; });
  const position = await savedPosition(index, checkpoint);
  if (!state || !position || lsnToVersion(state.lsn) > lsnToVersion(position)) {
    const { rows: [flush] } = await source.query('SELECT confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name=$1', [slot]);
    await rebuild(index, source, checkpoint, flush.lsn);
    console.log('Graph rebuilt from snapshot');
  }
  confirmed = await savedPosition(index, checkpoint);
  saved = lsnToVersion(confirmed);
  // Channels copied before topic and description were watched. Runs before the stream starts.
  const filled = await fillChannelText(index, source);
  if (filled) console.log(JSON.stringify({ graph_reader: 'channel_text_filled', channels: filled }));
}

// Channels whose switches differ from the stored copy need their messages brought in line.
async function channelsToResync(batch) {
  // A thread-search opt-in or opt-out changes the knowledge flag of every message in that channel.
  const ids = batch.filter(c => c.table === 'channels').map(c => c.row.id);
  const rows = ids.length ? (await index.query(
    'SELECT id, memory_enabled, knowledge_enabled FROM kb.m_channels WHERE id=ANY($1::text[])', [ids])).rows : [];
  const known = new Map(rows.map(r => [r.id, r]));
  const pending = new Map();
  for (const { table, op, row, lsn } of batch) {
    if (table === 'knowledge_thread_channels') pending.set(row.channel_id, lsnToVersion(lsn));
    if (table !== 'channels' || op === 'delete' || row.kind !== 'channel') continue;
    const previous = known.get(row.id);
    if ((previous?.memory_enabled ?? false) !== row.memory_enabled ||
        (previous?.knowledge_enabled ?? false) !== row.knowledge_enabled) pending.set(row.id, lsnToVersion(lsn));
    known.set(row.id, row);
  }
  return pending;
}

async function flush(position) {
  const batch = buffer; buffer = [];
  const resync = await channelsToResync(batch);
  await lookup.prefetch(batch);
  // A message that is neither in the source view nor in the store (a direct message, a switched-off channel) needs no write.
  const absent = [], threads = new Set();
  for (const change of batch) {
    if (change.table !== 'messages') continue;
    const message = await lookup.message(change.row.workspace_id, change.row.id);
    if (message) threads.add(message.thread_id);
    else absent.push(change);
  }
  const known = absent.length ? new Set((await index.query('SELECT id FROM kb.m_messages WHERE id=ANY($1::text[])', [absent.map(c => c.row.id)])).rows.map(r => r.id)) : new Set();
  const skip = new Set(absent.filter(c => !known.has(c.row.id)));
  const ops = [];
  for (const change of batch) if (!skip.has(change)) ops.push(...await planChange(change, lsnToVersion(change.lsn), lookup));
  // Leave the old flags and checkpoint visible until every page commits. If a page fails, WAL replay
  // detects the same switch, including in a partial chunk, and repeats its guarded writes.
  for (const [id, version] of resync) await serial(() => resyncChannel(index, source, lookup, id, version));
  await serial(() => applyOps(index, ops, position ? { slot: checkpoint, lsn: position } : undefined));
  if (threads.size || resync.size) await source.query('SELECT wake_memory_extract($1::uuid[], $2::uuid[])', [[...threads], [...resync.keys()]]);
  if (position) { saved = lsnToVersion(position); schedulePublish(); }
}

// Debounce: a burst of commits costs one graph build.
function schedulePublish() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishing = serial(() => publish(index, checkpoint)).catch(fail);
  }, PUBLISH_DELAY_MS);
}

async function onMessage(replication, lsn, message) {
  if (message.tag === 'begin') buffer = [];
  else if ((message.tag === 'insert' || message.tag === 'update' || message.tag === 'delete')
      && message.relation.schema === schema && (TABLES.includes(message.relation.name) || message.relation.name === 'knowledge_thread_channels')) {
    buffer.push({ table: message.relation.name, op: message.tag, lsn, row: message.tag === 'delete' ? (message.old ?? message.key) : message.new });
    if (buffer.length >= CHUNK) await flush();            // partial chunk: guarded writes, position unchanged
  } else if (message.tag === 'commit') {
    if (lsnToVersion(message.commitEndLsn) <= saved) buffer = [];   // already applied before a crash
    else await flush(message.commitEndLsn);
    confirmed = message.commitEndLsn;
    await replication.acknowledge(confirmed);                       // only after the graph commit
  }
}

function fail(error) { console.error('Memory graph reader stopped:', error.code ?? error.name, error.message); process.exit(1); }

await prepare();
// Recover a crash after a graph commit and before its cross-database wakeup.
await source.query('SELECT wake_memory_extract(NULL::uuid[])');
if (await publishNeeded(index, checkpoint)) await serial(() => publish(index, checkpoint));
const replication = new LogicalReplicationService(
  { connectionString: process.env.GRAPH_REPLICATION_URL, application_name: 'space-graph-reader', keepAlive: true },
  { acknowledge: { auto: false, timeoutSeconds: 0 }, flowControl: { enabled: true } });
// Keepalives from the server carry its WAL end, so lag is reported without any query.
replication.on('heartbeat', async (lsn, _time, respond) => {
  if (respond) await replication.acknowledge(confirmed);
  if (Date.now() - lastReport > LAG_REPORT_MS) {
    lastReport = Date.now();
    console.log(JSON.stringify({ graph_reader: 'lag', bytes: String(lsnToVersion(lsn) - saved) }));
  }
});
replication.on('data', async (lsn, message) => {
  try { await onMessage(replication, lsn, message); } catch (error) { fail(error); }
});
replication.on('error', fail);
replication.subscribe(new PgoutputPlugin({ protoVersion: 1, publicationNames: [publication] }), slot, confirmed).catch(fail);
console.log('Memory graph reader ready');
for (const name of ['SIGTERM', 'SIGINT']) process.once(name, async () => {
  clearTimeout(publishTimer);
  await replication.stop().catch(() => {}); await publishing.catch(() => {});
  process.exit(0);
});
