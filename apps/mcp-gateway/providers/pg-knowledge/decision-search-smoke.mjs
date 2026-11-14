// Use a disposable Space database and an empty dedicated provider index. Requires local all-minilm:22m.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { assetDownloadPath, messagePath } from '@space/contracts';
import { createPool } from '@space/postgres/database';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { AssetStore } from '@space/postgres/assets';
import { ChatStore } from '@space/postgres/chat';
import { RemoteMcp } from '../../dist/remote.js';
import { callKnowledge, discoverKnowledge } from '../../dist/knowledge.js';
import { rebuild, publish } from './graph-apply.mjs';

const schema = 'decision_search_' + randomUUID().replaceAll('-', '');
const sourceUrl = new URL(process.env.TEST_DATABASE_URL);
sourceUrl.searchParams.set('options', '-c search_path=' + schema);
const admin = createPool(process.env.TEST_DATABASE_URL), source = createPool(sourceUrl.href);
const index = createPool(process.env.THREAD_INDEX_URL);
const chat = new ChatStore(source);
let provider, seed;
const checkpoint = 'decision-search-smoke-' + schema;
async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
try {
  assert.equal((await index.query('SELECT count(*)::int AS count FROM kb.m_channels')).rows[0].count, 0, 'Use an empty dedicated provider index');
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(source);
  seed = await bootstrap(source);
  const pricing = await chat.createChannel(seed.owner_id, seed.workspace_id, { name: 'launch-pricing', private: true });
  const release = await chat.createChannel(seed.owner_id, seed.workspace_id, { name: 'launch-release', private: false });
  const privateSession = await chat.directMessages.open(seed.owner_id, seed.workspace_id, { user_id: seed.owner_id });
  const sharedSession = await chat.directMessages.open(seed.owner_id, seed.workspace_id, { user_id: seed.collaborator_id });
  const send = (channel, text) => chat.send(seed.owner_id, channel, { client_message_id: randomUUID(), text });
  const privateDecision = await send(pricing.id, 'Launch decision: the private launch discount is 20 percent for annual contracts.');
  const publicDecision = await send(release.id, 'Launch decision: release the annual plan on November 20.');
  const excluded = await send(privateSession.id, 'A direct message about the launch.');
  const assets = new AssetStore(source);
  const attachment = await assets.create(seed.owner_id, pricing.id, { name: 'Vendor-Proposal.pdf', type: 'application/pdf', size: 83 });
  await assets.complete(seed.owner_id, attachment.id, async () => ({kind:'pdf', mime:'application/pdf'}));
  const posted = await chat.send(seed.owner_id, pricing.id, { client_message_id: randomUUID(), text: '', asset_ids: [attachment.id] });
  await rebuild(index, source, checkpoint, '0/1');
  await publish(index, checkpoint);
  assert.equal((await index.query('SELECT count(*)::int AS count FROM kb.m_messages WHERE knowledge')).rows[0].count, 2);
  const port = await freePort(), bearer = randomUUID() + randomUUID();
  provider = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, KNOWLEDGE_DATABASE_URL: process.env.KNOWLEDGE_DATABASE_URL ?? process.env.THREAD_INDEX_URL, THREAD_LOOKUP_URL: sourceUrl.href,
      KNOWLEDGE_WORKSPACE_ID: seed.workspace_id, KNOWLEDGE_BEARER: bearer, KNOWLEDGE_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  process.env.NODE_ENV = 'development';
  process.env.SPACE_LOCAL_PG_KNOWLEDGE = '1';
  process.env.SPACE_LOCAL_PG_KNOWLEDGE_PORT = String(port);
  const connection = { id: randomUUID(), url: 'https://pg-knowledge.invalid/mcp', token: bearer, kind: 'knowledge' };
  const remote = new RemoteMcp();
  // Bounded retries cover provider process startup only.
  for (let attempt = 0; ; attempt++) {
    try {
      const tools = await discoverKnowledge(remote, connection, AbortSignal.timeout(3000));
      assert.equal(tools[0].name, 'knowledge_search');
      assert.match(tools[0].description, /exact URL/);
      break;
    } catch (error) {
      if (attempt === 30 || provider.exitCode !== null) throw error;
      await delay(100);
    }
  }
  const search = async (destination, requester = seed.owner_id, sourceKind = 'threads', query = 'What did the team decide about the annual plan launch?') => {
    const result = await callKnowledge(undefined, remote, connection, 'knowledge_search', {
      query, filters: { source: sourceKind }, limit: 8,
    }, { connectionId: connection.id, installationId: seed.installation_id, workspaceId: seed.workspace_id,
      requesterId: requester, audience: { kind: 'channel', channelId: destination } }, AbortSignal.timeout(30000));
    return result.structuredContent.hits;
  };
  const both = await search(privateSession.id);
  assert.deepEqual(new Set(both.map(hit => hit.citation.url)), new Set([
    messagePath(pricing.id, privateDecision.id), messagePath(release.id, publicDecision.id),
  ]), 'private session receives both exact source links');
  assert.ok(both.some(hit => hit.evidence === privateDecision.text));
  assert.ok(both.some(hit => hit.evidence === publicDecision.text));
  assert.ok(!both.some(hit => hit.ref.recordId === 'message/' + excluded.id));
  const findAttachment = (destination, query = 'proposal') => search(destination, seed.owner_id, 'attachments', query);
  const [hit] = await findAttachment(privateSession.id);
  assert.equal(hit?.ref.recordId, 'attachment/' + attachment.id);
  assert.equal(hit.title, attachment.name);
  assert.equal(hit.citation.url, assetDownloadPath(attachment.id));
  assert.deepEqual(await findAttachment(seed.channel_id), [], 'a shared answer cannot discover a private file');
  assert.deepEqual(await findAttachment(sharedSession.id), [], 'every member of the destination must be allowed to see the file');
  assert.deepEqual(await search(privateSession.id, seed.collaborator_id, 'attachments', 'proposal'), []);
  const { rows: [node] } = await index.query('SELECT message_id,thread_id FROM kb.m_attachments WHERE id=$1',[attachment.id]);
  assert.equal(node.message_id, posted.id);
  assert.equal(node.thread_id, posted.thread_id);
  const graph = await index.connect();
  try {
    await graph.query("SELECT graph.select_graph('space_memory')");
    const {rows: path} = await graph.query(
      `SELECT node_id,depth FROM graph.traverse('kb.m_attachments'::regclass,$1,3,
        edge_types=>ARRAY['attached_to','attachment_message_in_thread','in_channel'],include_start=>false,max_rows=>8) ORDER BY depth`,
      [attachment.id]);
    assert.deepEqual(path.map(n => [n.depth,n.node_id]), [[1, posted.id],[2, posted.thread_id],[3, pricing.id]]);
  } finally { graph.release(true); }
  const publicOnly = await search(seed.channel_id);
  assert.deepEqual(publicOnly.map(hit => hit.citation.url), [messagePath(release.id, publicDecision.id)], 'public answer excludes private decisions');
  assert.deepEqual((await search(sharedSession.id)).map(hit => hit.citation.url), [messagePath(release.id, publicDecision.id)], 'shared private conversation still checks every viewer');
  assert.deepEqual(await search(privateSession.id, seed.collaborator_id), [], 'requester cannot use someone else’s private session');
  await source.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [pricing.id, seed.owner_id]);
  assert.deepEqual((await search(privateSession.id)).map(hit => hit.citation.url), [messagePath(release.id, publicDecision.id)], 'requester membership revocation hides stale indexed evidence');
  assert.deepEqual(await findAttachment(privateSession.id), [], 'an indexed attachment cannot survive requester revocation');
  await chat.deleteMessage(seed.owner_id, release.id, publicDecision.id);
  assert.deepEqual(await search(privateSession.id), []);
  console.log('PASS: automatic decision indexing, real embeddings and pgContext ranking, gateway MCP knowledge_search, two-channel private citations, Attachment search and citations, shared audience filtering, deletion and membership revocation against a stale index.');
} finally {
  if (provider && provider.exitCode === null) {
    const ended = once(provider, 'exit');
    provider.kill();
    await ended;
  }
  if (seed) {
    await index.query("SELECT pgcontext.delete_points('kb_memory', ARRAY(SELECT id FROM kb.m_messages WHERE workspace_id=$1))", [seed.workspace_id]);
    await index.query('DELETE FROM kb.m_channels WHERE workspace_id=$1', [seed.workspace_id]);
    await index.query('DELETE FROM kb.m_people WHERE workspace_id=$1', [seed.workspace_id]);
    await index.query('DELETE FROM kb.graph_position WHERE slot=$1', [checkpoint]);
  }
  await source.end();
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await Promise.all([index.end(), admin.end()]);
}
