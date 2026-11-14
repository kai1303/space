import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { connect } from 'nats';
import { streamName } from '@space/events';
import { EventBridge } from '@space/event-service/bridge';
import type { MemoryMessageChange, MemoryProvider } from '@space/core/memory';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

const schema = `provider_changes_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const url = new URL(process.env.TEST_DATABASE_URL!);
url.pathname = '/' + schema;
const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}` });
const natsUrl = process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
const bridge = new EventBridge({ databaseUrl: url.href, natsUrl, schema });
before(async () => {
  await admin.query(`CREATE DATABASE ${schema}`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await bridge.close();
  await pool.end();
  await admin.query(`DROP DATABASE ${schema}`);
  await admin.end();
  const nc = await connect({ servers: natsUrl });
  try {
    const manager = await nc.jetstreamManager();
    for (const suffix of ['CHAT', 'WORK', 'SEARCH']) await manager.streams.delete(`${streamName(schema)}_${suffix}`);
  } finally { await nc.close(); }
});

test('custom Memory receives committed edits and deletes, retries failures and limits access to saved evidence', {timeout: 30000}, async () => {
  const seed = await bootstrap(pool);
  const document = { content: '', sources: [], revision: '0'.repeat(64) };
  const attempted: string[] = [];
  type Received = { scope: object; change: MemoryMessageChange; text?: string | null };
  const seen = new Map<string, Received>();
  const received = new EventEmitter();
  async function receipt(messageId: string, revision: string): Promise<Received> {
    const key = messageId + '/' + revision;
    if (!seen.has(key)) await once(received, key, { signal: AbortSignal.timeout(10_000) });
    return seen.get(key)!;
  }
  let retry = true;
  const provider: MemoryProvider = {
    id: 'test-store', name: 'Test store', async read() { return document; }, async ingest() { return document; },
    async write() { return document; }, async remove() { return document; }, async clear() {}, async search() { return []; },
    async onMessageChanged(scope, change, signal) {
      signal.throwIfAborted();
      attempted.push(change.event_id);
      if (retry) { retry = false; throw new Error('Temporary outage'); }
      const text = change.type === 'edited' ? (await change.readSource())?.text ?? null : undefined;
      const key = change.message_id + '/' + change.revision;
      seen.set(key, {scope, change, text});
      received.emit(key);
    },
  };
  const start = () => createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { providers: [provider] }, realtime: { eventUrl: natsUrl } });
  let app = start();
  const request = async (method: 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) => {
    const res = await app.inject({ method, url: '/v1/channels/' + seed.channel_id + path,
      headers: {authorization: 'Bearer ' + seed.owner_token}, ...(payload && {payload}) });
    assert.ok(res.statusCode < 300, res.body);
    return res.json();
  };
  try {
    await request('POST', '/memory/settings', {enabled: true, provider: provider.id});
    const send = () => request('POST', '/messages', {client_message_id: randomUUID(), text: 'Before'});
    const saved = await send(), unsaved = await send();
    await request('POST', '/memory/sources', {message_id: saved.id});
    const edit = (m: {id: string; reaction_sequence: string}, text: string) => request('PATCH', '/messages/' + m.id,
      {revision: m.reaction_sequence, document: {ops: [{insert: text + '\n'}]}});
    const updated = await edit(saved, 'After');
    await edit(saved, 'After'); // a retried edit is a no-op
    const pending = await pool.query("SELECT payload FROM event_outbox WHERE kind='memory.provider.changed'");
    assert.equal(pending.rowCount, 1);
    assert.doesNotMatch(JSON.stringify(pending.rows), /Before|After/);

    // Commit before either the bridge or the replacement API is listening.
    await app.close();
    await bridge.start();
    app = start();
    await app.ready();
    const event = await receipt(saved.id, '2');
    assert.deepEqual(event.scope, {workspace_id: seed.workspace_id, channel_id: seed.channel_id});
    assert.equal(event.change.type, 'edited');
    assert.equal(event.text, 'After');
    assert.deepEqual(attempted, [event.change.event_id, event.change.event_id]);
    const editedUnsaved = await edit(unsaved, 'Outside the saved sources');
    assert.equal((await receipt(unsaved.id, '2')).text, null);

    await request('POST', '/memory/sources', {message_id: unsaved.id});
    await request('DELETE', '/memory/sources/message:' + unsaved.id);
    await edit(editedUnsaved, 'After forgetting the source');
    assert.equal((await receipt(unsaved.id, '3')).text, null);

    await request('POST', '/memory/settings', {enabled: true, provider: 'markdown'});
    await edit(updated, 'Private to the new provider');
    assert.equal((await receipt(saved.id, '3')).text, null);
    await request('POST', '/memory/settings', {enabled: false});
    await request('DELETE', '/messages/' + saved.id);
    const deletion = await receipt(saved.id, '4');
    assert.equal(deletion.change.type, 'deleted');
    assert.ok(!('readSource' in deletion.change));
  } finally { await app.close(); }
});
