import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `graph_rag_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

const post = async (token: string, channel: string, text: string) => {
  const r = await app.inject({ method: 'POST', url: `/v1/channels/${channel}/messages`, headers: { authorization: `Bearer ${token}` }, payload: { client_message_id: randomUUID(), text } });
  assert.equal(r.statusCode, 201, r.body); return r.json();
};
const visible = async (w: string, requester: string, destination: string, ids: string[]) =>
  (await pool.query('SELECT id, body FROM memory_visible_messages($1,$2,$3,$4::uuid[])', [w, requester, destination, ids])).rows;
const inSource = async (id: string) => (await pool.query('SELECT 1 FROM memory_source_messages WHERE id=$1', [id])).rowCount;

test('memory_source_messages follows the memory switch, deletes and archive; memory_visible_messages checks membership', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const m = await post(a.owner_token, a.channel_id, 'Hello world');
  assert.equal(await inSource(m.id), 0, 'off by default');
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  assert.equal(await inSource(m.id), 1);
  assert.deepEqual((await visible(a.workspace_id, a.owner_id, a.channel_id, [m.id])).map(r => r.id), [m.id]);
  assert.deepEqual(await visible(a.workspace_id, randomUUID(), a.channel_id, [m.id]), [], 'a stranger sees nothing');
  assert.deepEqual(await visible(b.workspace_id, b.owner_id, b.channel_id, [m.id]), [], 'another workspace sees nothing');
  assert.deepEqual(await visible(a.workspace_id, a.owner_id, b.channel_id, [m.id]), [], 'only the message channel can be the destination');

  await pool.query('UPDATE channels SET archived_at=now() WHERE id=$1', [a.channel_id]);
  assert.equal(await inSource(m.id), 0, 'archived channels leave the view');
  await pool.query('UPDATE channels SET archived_at=NULL WHERE id=$1', [a.channel_id]);
  const removed = await app.inject({ method: 'DELETE', url: `/v1/channels/${a.channel_id}/messages/${m.id}`, headers: { authorization: `Bearer ${a.owner_token}` } });
  assert.ok(removed.statusCode < 300, removed.body);
  assert.equal(await inSource(m.id), 0, 'deleted messages leave the view');
  assert.deepEqual(await visible(a.workspace_id, a.owner_id, a.channel_id, [m.id]), []);
});

test('graph_source_messages carries memory and knowledge flags', async () => {
  const a = await bootstrap(pool);
  const m = await post(a.owner_token, a.channel_id, 'Flagged');
  const [initial] = (await pool.query('SELECT memory, knowledge FROM graph_source_messages WHERE id=$1', [m.id])).rows;
  assert.deepEqual(initial, { memory: false, knowledge: true });
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  const [both] = (await pool.query('SELECT memory, knowledge FROM graph_source_messages WHERE id=$1', [m.id])).rows;
  assert.deepEqual([both.memory, both.knowledge], [true, true]);
  await pool.query('UPDATE channels SET memory_enabled=false WHERE id=$1', [a.channel_id]);
  const [knowledgeOnly] = (await pool.query('SELECT memory, knowledge FROM graph_source_messages WHERE id=$1', [m.id])).rows;
  assert.deepEqual([knowledgeOnly.memory, knowledgeOnly.knowledge], [false, true]);
});

// Needs a knowledge database with memory-graph.sql applied (MEMORY_GRAPH_URL, writer role) and local Ollama.
test('graphMemoryIndex ranks by meaning inside the asked thread, session or channel only', { skip: !process.env.MEMORY_GRAPH_URL }, async () => {
  const { graphMemoryIndex } = await import('@space/server/memory-index');
  const graph = new Pool({ connectionString: process.env.MEMORY_GRAPH_URL });
  const embed = async (texts: string[]) => (await (await fetch('http://127.0.0.1:11434/api/embed', { method: 'POST', body: JSON.stringify({ model: 'all-minilm:22m', input: texts }) })).json()).embeddings as number[][];
  const ws = randomUUID(), channel = randomUUID(), other = randomUUID(), t1 = randomUUID(), t2 = randomUUID(), t3 = randomUUID(), session = randomUUID();
  const messages = [
    { id: randomUUID(), thread: t1, text: 'Customers were charged twice after checkout retried' },
    { id: randomUUID(), thread: t1, text: 'Lunch is at noon on Friday' },
    { id: randomUUID(), thread: t2, text: 'Duplicate charges again in another thread' },
    { id: randomUUID(), thread: t3, text: 'Charged twice in a different channel' },
    { id: randomUUID(), thread: t1, text: 'Agent turn: I fixed the duplicate charge bug', session },
  ];
  try {
    await graph.query('INSERT INTO kb.m_channels(id,workspace_id,name,is_private,memory_enabled,version) VALUES($1,$3,$4,false,true,1),($2,$3,$4,false,true,1)', [channel, other, ws, 'c']);
    await graph.query('INSERT INTO kb.m_threads(id,workspace_id,channel_id,version) VALUES($1,$4,$5,1),($2,$4,$5,1),($3,$4,$6,1)', [t1, t2, t3, ws, channel, other]);
    await graph.query(`INSERT INTO kb.m_sessions(id,workspace_id,thread_id,title,state,version) VALUES($1,$2,$3,'Fix','active',1)`, [session, ws, t1]);
    const vectors = await embed(messages.map(m => m.text));
    for (const [i, m] of messages.entries()) {
      await graph.query(`INSERT INTO kb.m_messages(id,workspace_id,thread_id,sequence,revision,created_at,memory,knowledge,body,embedding,version)
        VALUES($1,$2,$3,$4,1,now(),true,false,$5,$6,1)`, [m.id, ws, m.thread, i + 1, m.text, JSON.stringify(vectors[i])]);
      if (m.session) await graph.query('INSERT INTO kb.m_session_turns(id,workspace_id,session_id,message_id) VALUES($1,$2,$3,$1)', [m.id, ws, m.session]);
    }
    await graph.query("SELECT pgcontext.upsert_points('kb_memory', $1::text[])", [messages.map(m => m.id)]);
    const index = graphMemoryIndex(process.env.MEMORY_GRAPH_URL)!;
    const inThread = await index.related({ channelId: channel, threadId: t1 }, 'charged twice', 5);
    assert.equal(inThread[0], messages[0]!.id, 'the matching message of this thread ranks first');
    assert.ok(!inThread.includes(messages[2]!.id) && !inThread.includes(messages[3]!.id), 'no other thread or channel');
    assert.ok(!inThread.includes(messages[4]!.id), 'session turns stay out of thread memory');
    assert.deepEqual(await index.related({ channelId: channel, threadId: t1, sessionId: session }, 'duplicate charge', 5), [messages[4]!.id]);
    const inChannel = await index.related({ channelId: channel }, 'charged twice', 5);
    assert.ok(inChannel.includes(messages[2]!.id) && !inChannel.includes(messages[3]!.id), 'channel scope stops at the channel');
  } finally {
    await graph.query("SELECT pgcontext.delete_points('kb_memory', $1::text[])", [messages.map(m => m.id)]).catch(() => {});
    await graph.query('DELETE FROM kb.m_channels WHERE id = ANY($1::text[])', [[channel, other]]);
    await graph.end();
  }
});
