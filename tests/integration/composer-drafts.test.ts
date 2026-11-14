import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import { parseResourceSubscription, resourceRevision } from '../../apps/server/dist/resource-updates.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `drafts_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
const root = '/v1/composer-drafts';
const dest = (key: string) => `${root}/${encodeURIComponent(key)}`;
const plain = (text: string) => ({ document: { ops: [{ insert: text, attributes: { bold: true } }] }, files: [] });
const mutation = (value: unknown, base: string | null = null) => ({ value, base, mutation_id: randomUUID() });

let origin: string;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
});
after(async () => {
  await app.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function api(token: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  assert.equal(response.statusCode, status, response.body);
  return response.json();
}

test('destinations are actor-private and authorized, including on revocation', async () => {
  const a = await bootstrap(pool), outsider = await bootstrap(pool);
  const thread = `thread:${a.channel_id}:${a.thread_id}`;
  const sub = parseResourceSubscription({ scope: 'drafts', id: a.owner_id });
  const chat = new ChatStore(pool);
  const ownRevision = () => resourceRevision(chat, a.owner_id, sub);
  const firstRevision = await ownRevision();
  assert.deepEqual(sub.keys, [`drafts:${a.owner_id}`]);
  await assert.rejects(resourceRevision(chat, a.collaborator_id, sub), { status: 404 });
  const otherRevision = () => resourceRevision(chat, a.collaborator_id, { scope: 'drafts', id: a.collaborator_id });
  const initialOther = await otherRevision();
  const writes = [
    [a.channel_id, 'main'], [thread, 'reply'],
  ].map(async ([key, text]) => {
    const cmd = mutation(plain(text!));
    const row = await api(a.owner_token, 'PUT', dest(key!), cmd);
    assert.deepEqual(row, { workspace_id: a.workspace_id, destination_name: 'general', key, value: cmd.value, revision: cmd.mutation_id });
    return row;
  });
  const rows = await Promise.all(writes);
  assert.notEqual(await ownRevision(), firstRevision);
  assert.equal(await otherRevision(), initialOther);
  assert.deepEqual(await api(a.owner_token, 'GET', root), { items: rows, next: null });
  assert.deepEqual(await api(a.collaborator_token, 'GET', root), { items: [], next: null });
  assert.deepEqual(await api(a.collaborator_token, 'GET', dest(thread)), { workspace_id: a.workspace_id, destination_name: 'general', key: thread, revision: null, value: null });
  await api(outsider.owner_token, 'GET', dest(a.channel_id), undefined, 404);
  await api(outsider.owner_token, 'PUT', dest(a.channel_id), mutation(plain('x')), 404);
  await api(a.owner_token, 'PUT', dest(`thread:${a.channel_id}:${outsider.thread_id}`), mutation(plain('x')), 404);
  const stale = await app.inject({ method: 'GET', url: root, headers: { authorization: `Bearer ${a.owner_token}`, 'x-expected-actor': a.collaborator_id } });
  assert.equal(stale.statusCode, 409);
  await api(a.collaborator_token, 'PUT', dest(thread), mutation(plain('collaborator reply')));
  const revBeforeLoss = await otherRevision();
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [a.workspace_id, a.collaborator_id]);
  assert.notEqual(await otherRevision(), revBeforeLoss);
  assert.deepEqual(await api(a.collaborator_token, 'GET', root), { items: [], next: null });
  await api(a.collaborator_token, 'GET', dest(thread), undefined, 404);
});

test('a private agent handoff thread stays bound to its owner and source channel', async () => {
  const a = await bootstrap(pool);
  const message = await api(a.owner_token, 'POST', `/v1/channels/${a.channel_id}/messages`,
    {client_message_id: randomUUID(), text: 'source'}, 201);
  await pool.query('UPDATE agent_definitions SET capabilities=$2 WHERE id=$1',
    [a.definition_id, { skills: ['codex.run'], controls: {}, persistent_sessions: true }]);
  const handoff = await api(a.owner_token, 'POST', `/v1/workspaces/${a.workspace_id}/sidekick-sessions`, {
    client_session_id: randomUUID(), installation_id: a.installation_id, skill: 'codex.run',
    source: {channel_id: a.channel_id, message_ids: [message.id]},
  },201);
  const path = dest(`thread:${handoff.channel_id}:${handoff.origin_thread_id}`);
  await api(a.owner_token, 'PUT', path, mutation(plain('private')));
  await api(a.collaborator_token, 'GET', path, undefined, 404);
  await api(a.collaborator_token, 'PUT', path, mutation(plain('intrusion')), 404);
  await api(a.collaborator_token, 'PUT', dest(`thread:${a.channel_id}:${handoff.origin_thread_id}`), mutation(plain('wrong channel')), 404);
});

test('parallel retries and conflicting changes cannot overwrite a newer edit or revive a deletion', async () => {
  const a = await bootstrap(pool), path = dest(a.channel_id);
  const chat = new ChatStore(pool);
  const revision = () => resourceRevision(chat, a.owner_id, { scope: 'drafts', id: a.owner_id });
  const first = mutation(plain('hello'));
  const [left, right] = await Promise.all([api(a.owner_token, 'PUT', path, first), api(a.owner_token, 'PUT', path, first)]);
  assert.deepEqual(left, right);
  const firstRevision = await revision();
  await api(a.owner_token, 'PUT', path, first);
  assert.equal(await revision(), firstRevision);
  assert.equal((await api(a.owner_token, 'PUT', path, { ...first, value: plain('tampered') }, 409)).error, 'draft_conflict');
  const changes = ['device one', 'device two'].map(text => mutation(plain(text), first.mutation_id));
  const attempts = await Promise.all(changes.map(payload => app.inject({ method: 'PUT', url: path, headers: { authorization: `Bearer ${a.owner_token}` }, payload })));
  assert.deepEqual(attempts.map(r => r.statusCode).sort(), [200, 409]);
  const winner = attempts.find(r => r.statusCode === 200)!.json();
  const remove = mutation(null, winner.revision);
  const cleared = await api(a.owner_token, 'PUT', path, remove);
  assert.deepEqual(await api(a.owner_token, 'PUT', path, remove), cleared);
  assert.deepEqual(await api(a.owner_token, 'GET', path), cleared);
  assert.deepEqual(await api(a.owner_token, 'GET', root), { items: [], next: null });
  for (const stale of [first, ...changes, mutation(plain('stale'))]) {
    assert.equal((await api(a.owner_token, 'PUT', path, stale, 409)).error, 'draft_conflict');
  }
  await api(a.owner_token, 'PUT', path, mutation(plain('new'), cleared.revision));
});

test('ordinary files require ready, owned assets in the same room; a late clear works after attachment', async () => {
  const a = await bootstrap(pool);
  const id = randomUUID(), file = { id, name: 'note.md', size: 13, type: 'text/plain', description: 'memo' };
  const doc = { document: { ops: [] }, files: [file] };
  const path = dest(a.channel_id);
  await pool.query(`INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status)
    VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$1::uuid::text,$1::uuid::text,'ready')`, [id,a.workspace_id,a.channel_id,a.owner_id,file.name,file.size,file.type]);
  const privateRoom = await api(a.owner_token,'POST',`/v1/workspaces/${a.workspace_id}/channels`,{name:'separate',private:true},201);
  for (const [actor, key] of [[a.collaborator_token, a.channel_id], [a.owner_token, privateRoom.id]]) {
    assert.equal((await api(actor!, 'PUT', dest(key!), mutation(doc), 409)).error, 'asset_unavailable');
  }
  await api(a.owner_token, 'PUT', path, mutation({ ...doc, files: [{ ...file, size: 17 }] }), 409);
  await api(a.owner_token, 'PUT', path, mutation({ ...doc, files: [{ ...file, file: 'untrusted' }] }), 400);
  await api(a.owner_token, 'PUT', path, mutation({ ...doc, files: [file,file] }), 400);
  await api(a.owner_token, 'PUT', path, mutation({ ...doc, document: {ops:[{insert:'bad',attributes:{link:'javascript:void(0)'}}]} }), 400);
  const cmd = mutation(doc), saved = await api(a.owner_token, 'PUT', path, cmd);
  assert.deepEqual(saved.value, doc);
  const daysLeft = async () => Number((await pool.query(
    'SELECT extract(epoch FROM (expires_at-now()))/86400 AS days FROM assets WHERE id=$1', [id])).rows[0].days);
  assert.ok((await daysLeft()) > 29);
  const replyPath = dest(`thread:${a.channel_id}:${a.thread_id}`);
  const reply = await api(a.owner_token, 'PUT', replyPath, mutation(doc));
  const cleared = await api(a.owner_token, 'PUT', path, mutation(null, saved.revision));
  assert.ok((await daysLeft()) > 29);
  const sendAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const scheduled = await api(a.owner_token, 'POST', `/v1/channels/${a.channel_id}/scheduled-messages`,
    { id: randomUUID(), text: 'file', send_at: sendAt, asset_ids: [id] }, 201);
  await api(a.owner_token, 'PUT', replyPath, mutation(null, reply.revision));
  assert.ok((await daysLeft()) > 7 && (await daysLeft()) < 9);
  const savedAgain = await api(a.owner_token, 'PUT', path, mutation(doc, cleared.revision));
  await api(a.owner_token, 'DELETE', `/v1/scheduled-messages/${scheduled.id}`);
  assert.ok((await daysLeft()) > 29);

  await api(a.owner_token,'POST',`/v1/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: '', asset_ids: [id] },201);
  await api(a.owner_token, 'PUT', path, mutation(null, savedAgain.revision));
});

test('row sends commit one copy of a revision and preserve newer edits and rejected drafts', async () => {
  const a = await bootstrap(pool);
  const key = `thread:${a.channel_id}:${a.thread_id}`, path = dest(key);
  const old = await api(a.owner_token, 'PUT', path, mutation(plain('first version')));
  const draft = plain('ready for review');
  const current = await api(a.owner_token, 'PUT', path, mutation(draft, old.revision));
  const send = (revision: string) => app.inject({method:'POST',url:path+'/send',
    headers:{authorization:`Bearer ${a.owner_token}`},payload:{revision}});
  assert.equal((await send(old.revision)).statusCode,409);
  await pool.query('UPDATE channels SET archived_at=now() WHERE id=$1',[a.channel_id]);
  assert.equal((await send(current.revision)).statusCode,409);
  assert.deepEqual((await api(a.owner_token,'GET',path)).value,draft);
  await pool.query('UPDATE channels SET archived_at=NULL WHERE id=$1',[a.channel_id]);
  for (const res of await Promise.all([send(current.revision),send(current.revision)])) assert.equal(res.statusCode,204,res.body);
  const sent = await pool.query('SELECT document,thread_id FROM messages WHERE channel_id=$1 AND client_message_id=$2',[a.channel_id,current.revision]);
  assert.deepEqual(sent.rows,[{document:draft.document,thread_id:a.thread_id}]);
  const cleared = await api(a.owner_token,'GET',path);
  assert.equal(cleared.value,null);
  const next = await api(a.owner_token,'PUT',path,mutation(plain('next reply'),cleared.revision));
  assert.equal((await send(current.revision)).statusCode,204);
  assert.deepEqual((await api(a.owner_token,'GET',path)).value,next.value);
});

test('scheduling a draft revision preserves its files and thread and handles racing devices', async () => {
  const a = await bootstrap(pool);
  const dm = await api(a.owner_token,'POST',`/v1/workspaces/${a.workspace_id}/direct-messages`,{user_id:a.collaborator_id});
  const file = {id:randomUUID(), name:'plan.txt', type:'text/plain', size:42, description:'Original plan'};
  await pool.query(`INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,type,size,staging_key,object_key,status)
    VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$1::text,$1::text,'ready')`,[file.id,a.workspace_id,a.channel_id,a.owner_id,file.name,file.type,file.size]);
  const path = dest(`thread:${a.channel_id}:${a.thread_id}`);
  const content = {...plain('Plan for tomorrow'),files:[file]};
  const draft = await api(a.owner_token,'PUT',path,mutation(content));
  const at = new Date(Date.now() + 7 * 86400000).toISOString();
  const send = (path: string, revision: string, time = at) => app.inject({method:'POST',url:path+'/schedule',
    headers:{authorization:`Bearer ${a.owner_token}`},payload:{revision,send_at:time}});
  assert.equal((await send(path,draft.revision,new Date(Date.now()+120_000).toISOString())).statusCode,400);
  assert.deepEqual((await api(a.owner_token,'GET',path)).value,content);
  const later = new Date(Date.parse(at)+3600000).toISOString();
  const attempts = await Promise.all([send(path,draft.revision,at),send(path,draft.revision,later)]);
  assert.deepEqual(attempts.map(r=>r.statusCode).sort(),[204,409]);
  const scheduled = await api(a.owner_token,'GET',`/v1/workspaces/${a.workspace_id}/scheduled-messages`);
  assert.equal(scheduled.items.length,1);
  const item = scheduled.items[0];
  assert.equal(item.thread_id,a.thread_id);
  assert.deepEqual(item.document,content.document);
  assert.equal(item.attachments[0].id,file.id);
  const tombstone = await api(a.owner_token,'GET',path);
  assert.equal(tombstone.value,null);
  const newDraft = await api(a.owner_token,'PUT',path,mutation(plain('Newer reply'),tombstone.revision));
  assert.equal((await send(path,draft.revision,item.send_at)).statusCode,204);
  assert.deepEqual((await api(a.owner_token,'GET',path)).value,newDraft.value);
  const changed = await api(a.owner_token,'PUT',dest(dm.id),mutation(plain('Reminder')));
  assert.equal((await send(dest(dm.id),changed.revision)).statusCode,204);
  await pool.query('UPDATE channels SET encrypted_since=now() WHERE id=$1',[dm.id]);
  assert.equal((await send(dest('encrypted:'+dm.id),randomUUID())).statusCode,409);
  await api(a.owner_token,'POST',`/v1/scheduled-messages/${item.id}/send`,{});
  const { ScheduledMessageStore } = await import('@space/postgres/scheduled-messages');
  const version = (await pool.query('SELECT version FROM scheduled_messages WHERE id=$1',[item.id])).rows[0].version;
  await new ScheduledMessageStore(pool,new ChatStore(pool)).deliver(item.id,version);
  const posted = (await pool.query('SELECT thread_id,attachments FROM messages WHERE channel_id=$1 AND client_message_id=$2',[a.channel_id,item.id])).rows;
  assert.equal(posted.length,1);
  assert.equal(posted[0].thread_id,a.thread_id);
  assert.equal(posted[0].attachments[0].description,file.description);
});

test('encryption conversion purges prior drafts, enforces ciphertext-only writes and leaves no content on the realtime bus', async () => {
  const a = await bootstrap(pool);
  const dm = await api(a.owner_token, 'POST', `/v1/workspaces/${a.workspace_id}/direct-messages`, { user_id: a.collaborator_id });
  const path = dest(dm.id), key = `encrypted:${dm.id}`, encryptedPath = dest(key);
  const value = { ciphertext: Buffer.alloc(28000, 33).toString('base64') };
  await api(a.owner_token, 'PUT', encryptedPath, mutation(value), 409);
  await api(a.owner_token, 'PUT', path, mutation(plain('before encryption')));
  await pool.query('UPDATE channels SET encrypted_since=now() WHERE id=$1', [dm.id]);
  assert.equal((await pool.query('SELECT 1 FROM composer_drafts WHERE channel_id=$1', [dm.id])).rowCount, 0);
  assert.deepEqual(await api(a.owner_token, 'GET', root), { items: [], next: null });
  await api(a.owner_token, 'PUT', path, mutation(plain('plaintext')), 409);
  await api(a.owner_token, 'PUT', encryptedPath, mutation(plain('plaintext')), 400);
  await api(a.owner_token, 'PUT', encryptedPath, mutation({ ...value, files: [] }), 400);
  const id = randomUUID();
  await pool.query(`INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,encrypted)
    VALUES($1::uuid,$2,$3,$4,'Encrypted file',12,'application/octet-stream',$1::uuid::text,$1::uuid::text,'ready',true)`,
    [id, a.workspace_id, dm.id, a.owner_id]);
  const withFile = { ...value, asset_ids: [id] };
  await api(a.collaborator_token, 'PUT', encryptedPath, mutation(withFile), 409);
  const saved = await api(a.owner_token, 'PUT', encryptedPath, mutation(withFile));
  assert.equal(saved.destination_name, 'Demo collaborator');
  const held = await pool.query("SELECT expires_at>now()+interval '29 days' AS retained FROM assets WHERE id=$1", [id]);
  assert.equal(held.rows[0].retained, true);
  assert.deepEqual(await api(a.owner_token, 'GET', encryptedPath), saved);
  assert.deepEqual(await api(a.collaborator_token, 'GET', root), { items: [], next: null });
  await api(a.owner_token, 'PUT', encryptedPath, mutation(null, saved.revision));
  assert.equal((await pool.query("SELECT expires_at<now()+interval '25 hours' AS released FROM assets WHERE id=$1", [id])).rows[0].released, true);
  const events = await pool.query("SELECT payload FROM event_outbox WHERE kind='chat.changed' AND payload->'keys' ? $1", [`drafts:${a.owner_id}`]);
  assert.ok(events.rows.length);
  for (const event of events.rows) assert.deepEqual(event.payload, { keys: [`drafts:${a.owner_id}`] });
});

test('active draft pagination skips deletions and resumes from a stable destination key', async () => {
  const a = await bootstrap(pool);
  const keys: string[] = [];
  for (let i = 0; i < 34; i++) {
    const thread = randomUUID(), key = `thread:${a.channel_id}:${thread}`;
    await pool.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES($1,$2,$3)', [thread,a.workspace_id,a.channel_id]);
    await api(a.owner_token, 'PUT', dest(key), mutation(i ? plain('draft') : null));
    if (i) keys.push(key);
  }
  const first = await api(a.owner_token, 'GET', root);
  assert.equal(first.items.length, 32);
  assert.equal(first.next, first.items.at(-1).key);
  const last = await api(a.owner_token, 'GET', root + '?after=' + encodeURIComponent(first.next));
  assert.equal(last.items.length, 1);
  assert.equal(last.next, null);
  assert.deepEqual([...first.items, ...last.items].map(row => row.key), keys.sort());
});


test('a second socket for the actor receives the draft change after commit', { timeout: 12000 }, async () => {
  const a = await bootstrap(pool);
  const socket = io(origin, { transports: ['websocket'], auth: {token: a.owner_token}, autoConnect: false, reconnection: false });
  socket.on('updates.changed', (_notice, ack: () => void) => ack());
  const next = () => new Promise<unknown>(resolve => socket.once('updates.changed', resolve));
  const sub = { scope: 'drafts', id: a.owner_id };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    const initial = next();
    assert.deepEqual(await socket.timeout(2500).emitWithAck('updates.subscribe', sub), { data: sub });
    assert.deepEqual(await initial, sub);
    assert.equal((await socket.timeout(2500).emitWithAck('updates.subscribe', { scope: 'drafts', id: a.collaborator_id })).error, 'not_found');
    const changed = next();
    const row = await api(a.owner_token, 'PUT', dest(a.channel_id), mutation(plain('from desktop')));
    assert.deepEqual(await changed, sub);
    assert.deepEqual((await api(a.owner_token, 'GET', root)).items, [row]);
  } finally {
    socket.disconnect();
  }
});
