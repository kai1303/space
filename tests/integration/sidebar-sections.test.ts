import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { migrate } from '@space/postgres/migrate';
import { SidebarSectionStore } from '@space/postgres/sidebar-sections';

const schema = 'sidebar_' + randomBytes(8).toString('hex');
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const store = new SidebarSectionStore(pool);
const dm = new ChatStore(pool).directMessages;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
const empty = { sections: [], assignments: [] };

test('concurrent create-and-move is atomic and retries preserve later edits', async () => {
  const { workspace_id: w, owner_id: actor, channel_id: ch } = await bootstrap(pool);
  const section = { id: randomUUID(), name: 'Design', emoji: '🧑🏽‍💻', channel_id: ch };
  const copies = await Promise.all([store.create(actor,w,section), store.create(actor,w,section)]);
  for (const result of copies) {
    assert.deepEqual(result.sections, [{ id: section.id, name: 'Design', emoji: '🧑🏽‍💻', collapsed: false }]);
    assert.deepEqual(result.assignments, [{ channel_id: ch, section_id: section.id, kind: 'channel', name: 'general', private: false }]);
  }
  const next = { id: randomUUID(), name: 'Later' };
  await store.create(actor,w,next);
  await Promise.all([
    store.update(actor,w,section.id,{ name: 'Design reviews', emoji: '🚀' }),
    store.update(actor,w,section.id,{ collapsed: true }),
    store.move(actor,w,ch,next.id),
  ]);
  const retried = await store.create(actor,w,section);
  assert.deepEqual(retried.sections[0], { id: section.id, name: 'Design reviews', emoji: '🚀', collapsed: true });
  await assert.rejects(store.create(actor,w,{ ...section, emoji: '🍋' }), { code:'idempotency_conflict' });
  assert.throws(() => store.update(actor,w,section.id,{ emoji: 'invalid' }), { status:400 });
  const cleared = await store.update(actor,w,section.id,{ emoji:null });
  assert.equal(cleared.sections[0]?.emoji, undefined);
  assert.equal(retried.assignments[0]?.section_id, next.id);
  await assert.rejects(store.create(actor,w,{ ...section, name: 'Collision' }), {code:'idempotency_conflict'});
  assert.deepEqual((await store.remove(actor,w,next.id)).assignments, []);
  assert.deepEqual((await store.remove(actor,w,next.id)).assignments, []);
  const before = await store.snapshot(actor,w);
  await assert.rejects(store.create(actor,w,{ id:randomUUID(), name:'Rolled back', channel_id:randomUUID() }), {status:404});
  assert.deepEqual(await store.snapshot(actor,w), before);
});

test('owner-private revisions and durable events change only on effective edits', async () => {
  const { workspace_id:w, owner_id:actor, collaborator_id:peer, channel_id:ch } = await bootstrap(pool);
  const resources = [`actor:${actor}`, `actor:${peer}`, `workspace:${w}`, `channel:${ch}`];
  const revisions = async () => Object.fromEntries((await pool.query('SELECT resource, revision::int FROM resource_update_revisions WHERE resource=ANY($1::text[])',[resources])).rows.map(r=>[r.resource,r.revision]));
  const start = await revisions();
  const section = { id:randomUUID(), name:'Private with client', channel_id:ch };
  await store.create(actor,w,section);
  const changed = await revisions();
  assert.ok((changed[resources[0]!] ?? 0) > (start[resources[0]!] ?? 0));
  for (const key of resources.slice(1)) assert.equal(changed[key],start[key]);
  const {rows} = await pool.query('SELECT payload FROM event_outbox WHERE payload->>\'actor_id\'=$1', [actor]);
  assert.ok(rows.length);
  for (const {payload} of rows) {
    assert.deepEqual(payload.keys,[`actor:${actor}`]);
    assert.equal(JSON.stringify(payload).includes(section.name),false);
  }
  await store.move(actor,w,ch,section.id);
  await store.update(actor,w,section.id,{ collapsed:false });
  await store.create(actor,w,section);
  assert.deepEqual(await revisions(),changed);
  assert.deepEqual(await store.snapshot(peer,w),empty);
  await assert.rejects(store.move(peer,w,ch,section.id), { status:404 });
  await assert.rejects(store.update(peer,w,section.id,{name:'Unauthorized'}), { status:404 });
  await store.remove(peer,w,section.id);
  assert.equal((await store.snapshot(actor,w)).sections[0]?.name,section.name);
});

test('closed DMs, membership removal, archived channels and workspace isolation', async () => {
  const { workspace_id:w, owner_id:actor, collaborator_id:peer, channel_id:ch } = await bootstrap(pool);
  const outsider = await bootstrap(pool);
  const section = { id:randomUUID(), name:'Conversations', channel_id:ch };
  await store.create(actor,w,section);
  await assert.rejects(store.move(actor,w,outsider.channel_id,section.id), {status:404});
  await assert.rejects(store.snapshot(outsider.owner_id,w), {status:404});
  const direct = await dm.open(actor,w,{user_id:peer});
  const self = await dm.open(actor,w,{user_id:actor});
  await store.move(actor,w,direct.id,section.id);
  await store.move(actor,w,self.id,section.id);
  assert.deepEqual((await store.snapshot(actor,w)).assignments.filter(row=>row.kind==='direct').map(row=>row.name),
    ['Demo collaborator','Demo owner (you)']);
  await dm.visibility(actor,direct.id,{hidden:true});
  const closed = await store.snapshot(actor,w);
  assert.equal(closed.assignments.some(row=>row.channel_id===direct.id),false);
  await dm.open(actor,w,{user_id:peer});
  assert.ok((await store.snapshot(actor,w)).assignments.some(row=>row.channel_id===direct.id));
  await store.move(actor,w,self.id,null);
  await pool.query('UPDATE channels SET archived_at=now() WHERE id=$1',[ch]);
  assert.ok((await store.snapshot(actor,w)).assignments.some(row=>row.channel_id===ch));
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[ch,actor]);
  assert.equal((await store.snapshot(actor,w)).assignments.some(row=>row.channel_id===ch),false);
  await assert.rejects(store.move(actor,w,ch,section.id), {status:404});
  await store.create(peer, w, section);
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[w,peer]);
  await assert.rejects(store.snapshot(peer,w),{status:404});
  await assert.rejects(store.update(peer,w,section.id,{collapsed:true}),{status:404});
});

test('concurrent creations cannot exceed the per-person section capacity', async () => {
  const { workspace_id:w, owner_id:actor } = await bootstrap(pool);
  await pool.query(`INSERT INTO sidebar_sections(workspace_id,user_id,id,name,creation_name)
    SELECT $1,$2,gen_random_uuid(),'Other','Other' FROM generate_series(1,99)`,[w,actor]);
  const competing = await Promise.allSettled(['A','B'].map(name=>store.create(actor,w,{id:randomUUID(),name})));
  assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);
  const rejected = competing.find(r=>r.status==='rejected');
  assert.equal(rejected?.reason.code,'sidebar_section_limit');
  assert.equal((await store.snapshot(actor,w)).sections.length,100);
});
