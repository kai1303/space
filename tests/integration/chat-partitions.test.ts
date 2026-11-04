import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { ChatStore } from '@space/postgres/chat';
import { PostgresStore } from '@space/postgres/store';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `partitions_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

type Seed = { [Key in keyof Awaited<ReturnType<typeof bootstrap>>]: string };
async function channel(a: Seed): Promise<Seed> {
  const chat = new ChatStore(pool);
  const next = await chat.createChannel(a.owner_id, a.workspace_id, { name: 'Partition peer', private: false });
  const thread_id = randomUUID();
  await pool.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES($1,$2,$3)', [thread_id, a.workspace_id, next.id]);
  return { ...a, channel_id: next.id, thread_id };
}
async function insert(a: Seed, id: string = randomUUID(), client: string = randomUUID(), conflict = '') {
  return pool.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text)
    VALUES($1,$2,$3,$4,'human',$5,$6,'hash','Partition message') ${conflict}`, [id,a.workspace_id,a.channel_id,a.thread_id,a.owner_id,client]);
}
async function consistent() {
  assert.equal((await pool.query(`SELECT count(*) FROM message_identities i FULL JOIN messages m ON m.channel_id=i.channel_id AND m.id=i.id
    WHERE i.id IS NULL OR m.id IS NULL`)).rows[0].count, '0');
}
function planRelations(plan: any): Set<string> {
  const relations = new Set<string>();
  const walk = (node: any) => { if (node['Relation Name']) relations.add(node['Relation Name']); for (const child of node.Plans ?? []) walk(child); };
  walk(plan);
  return relations;
}

test('messages and replay use sixteen hash partitions and channel predicates prune to one leaf', async () => {
  for (const table of ['messages', 'channel_events']) {
    const meta = (await pool.query(`SELECT c.relkind,pg_get_partkeydef(c.oid) AS key,
      (SELECT count(*) FROM pg_inherits WHERE inhparent=c.oid) AS children FROM pg_class c WHERE c.oid=$1::regclass`, [table])).rows[0];
    assert.equal(meta.relkind, 'p'); assert.equal(meta.key, 'HASH (channel_id)'); assert.equal(meta.children, '16');
  }
  const a = await bootstrap(pool), b = await bootstrap(pool), peer = await channel(a);
  for (const seed of [a,b,peer]) await insert(seed);
  for (const seed of [a,b,peer]) for (const [table,predicate] of [
    ['messages','workspace_id=$2 AND channel_id=$1 AND sequence > 0'],
    ['messages','workspace_id=$2 AND channel_id=$1 AND thread_id=$3 AND sequence > 0'],
    ['channel_events','workspace_id=$2 AND channel_id=$1 AND sequence > 0'],
  ]) {
    const args = predicate!.includes('$3') ? [seed.channel_id,seed.workspace_id,seed.thread_id] : [seed.channel_id,seed.workspace_id];
    const plan = (await pool.query(`EXPLAIN (FORMAT JSON) SELECT * FROM ${table} WHERE ${predicate} ORDER BY sequence LIMIT 50`, args)).rows[0]['QUERY PLAN'][0].Plan;
    const relations = planRelations(plan);
    assert.equal(relations.size,1); assert.match([...relations][0]!, new RegExp(`^${table}_p[0-9]+$`));
  }
  for (const [query,args] of [
    ['SELECT * FROM messages WHERE channel_id=$1 AND id=$2',[a.channel_id,randomUUID()]],
    ['SELECT m.* FROM assets a JOIN messages m ON m.id=a.message_id AND m.channel_id=a.channel_id WHERE a.channel_id=$1',[a.channel_id]],
  ] as const) {
    const plan = (await pool.query(`EXPLAIN (FORMAT JSON) ${query}`,[...args])).rows[0]['QUERY PLAN'][0].Plan;
    const messageLeaves = [...planRelations(plan)].filter(name => name !== 'assets');
    assert.equal(messageLeaves.length,1); assert.match(messageLeaves[0]!,/^messages_p[0-9]+$/);
  }
  await consistent();
});

test('global identity, client and task keys survive partitioning, concurrent retries and suppressed inserts', async () => {
  const a = await bootstrap(pool), peer = await channel(a), chat = new ChatStore(pool);
  const request = { client_message_id: randomUUID(), thread_id: a.thread_id, text: 'Concurrent retry' };
  const saved = await Promise.all(Array.from({length:8}, () => chat.send(a.owner_id,a.channel_id,request)));
  assert.equal(new Set(saved.map(m => m.id)).size,1);
  await assert.rejects(chat.send(a.owner_id,peer.channel_id,{...request,thread_id:peer.thread_id}), /idempotency_conflict/);
  await assert.rejects(insert(peer,saved[0]!.id), {code:'23505'});
  await assert.rejects(insert(peer,randomUUID(),request.client_message_id), {code:'23505'});
  const ignoredId = randomUUID();
  assert.equal((await insert(a,ignoredId,request.client_message_id,'ON CONFLICT DO NOTHING')).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM message_identities WHERE id=$1',[ignoredId])).rowCount,0);
  const ignoredClient = randomUUID();
  assert.equal((await insert(a,saved[0]!.id,ignoredClient,'ON CONFLICT DO NOTHING')).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM message_identities WHERE client_message_id=$1',[ignoredClient])).rowCount,0);
  const concurrentId = randomUUID();
  const races = await Promise.allSettled([insert(a,concurrentId),insert(peer,concurrentId)]);
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
  const task = await new PostgresStore(pool).createTask(a.owner_id,{workspace_id:a.workspace_id,thread_id:a.thread_id,installation_id:a.installation_id,goal:'Task identity',skill:'demo.echo'},randomUUID());
  const agent = (seed: Seed, id = randomUUID(), conflict = '') => pool.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,task_id,installation_id,text) VALUES($1,$2,$3,$4,$5,$6,'Agent') ${conflict}`,[id,seed.workspace_id,seed.channel_id,seed.thread_id,task.id,a.installation_id]);
  await agent(a); await assert.rejects(agent(peer),{code:'23505'});
  const ignoredAgent = randomUUID();
  assert.equal((await agent(a,ignoredAgent,'ON CONFLICT DO NOTHING')).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM message_identities WHERE id=$1',[ignoredAgent])).rowCount,0);
  await consistent();
});

test('identity and scope cannot drift; assets cannot dangle and deletes clean their registry', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool), id = randomUUID(); await insert(a,id);
  for (const statement of [
    'UPDATE messages SET id=gen_random_uuid() WHERE id=$1',
    'UPDATE messages SET client_message_id=gen_random_uuid() WHERE id=$1',
    'UPDATE message_identities SET channel_id=gen_random_uuid() WHERE id=$1',
  ]) await assert.rejects(pool.query(statement,[id]),/immutable/);
  await assert.rejects(pool.query('DELETE FROM message_identities WHERE id=$1',[id]),{code:'23503'});
  const originalIdentity = (await pool.query('SELECT * FROM message_identities WHERE id=$1',[id])).rows[0];
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await assert.rejects(async () => {
      await tx.query('DELETE FROM message_identities WHERE id=$1',[id]);
      await tx.query(`INSERT INTO message_identities(id,workspace_id,channel_id,user_id,client_message_id,request_hash)
        VALUES($1,$2,$3,$4,$5,'replacement')`,[id,a.workspace_id,a.channel_id,a.owner_id,randomUUID()]);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    },{code:'23503'});
  } finally { await tx.query('ROLLBACK'); tx.release(); }
  assert.deepEqual((await pool.query('SELECT * FROM message_identities WHERE id=$1',[id])).rows[0],originalIdentity);
  const peer = await channel(a);
  await assert.rejects(insert(peer,randomUUID(),originalIdentity.client_message_id),{code:'23505'});
  await assert.rejects(pool.query(`INSERT INTO message_identities(id,workspace_id,channel_id,user_id,client_message_id,request_hash)
    VALUES($1,$2,$3,$4,$5,'orphan')`,[randomUUID(),a.workspace_id,a.channel_id,a.owner_id,randomUUID()]),{code:'23503'});
  await assert.rejects(insert({...a,workspace_id:b.workspace_id}),{code:'P0002'});
  await assert.rejects(insert({...a,thread_id:b.thread_id}),{code:'23503'});
  const asset = randomUUID();
  await pool.query(`INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id)
    VALUES($1,$2,$3,$4,'file.txt',1,'text/plain',$1::uuid::text,$1::uuid::text,'ready',$5)`,[asset,a.workspace_id,a.channel_id,a.owner_id,id]);
  await assert.rejects(pool.query('DELETE FROM messages WHERE id=$1',[id]),{code:'23503'});
  await assert.rejects(pool.query('UPDATE assets SET message_id=$1 WHERE id=$2',[randomUUID(),asset]),{code:'23503'});
  await pool.query('DELETE FROM assets WHERE id=$1',[asset]); await pool.query('DELETE FROM messages WHERE id=$1',[id]);
  assert.equal((await pool.query('SELECT 1 FROM message_identities WHERE id=$1',[id])).rowCount,0);
  await consistent();
});

test('different channels sharing one hash bucket still enforce global message keys', async () => {
  const a = await bootstrap(pool);
  const bucket = (await pool.query(`SELECT part FROM generate_series(0,15) part
    WHERE satisfies_hash_partition('messages'::regclass,16,part,$1::uuid)`,[a.channel_id])).rows[0].part;
  const otherId = (await pool.query(`SELECT id FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,1024)) candidate
    WHERE satisfies_hash_partition('messages'::regclass,16,$1,id) LIMIT 1`,[bucket])).rows[0].id;
  const peer = {...a,channel_id:otherId,thread_id:randomUUID()};
  await pool.query('INSERT INTO channels(id,workspace_id) VALUES($1,$2)',[peer.channel_id,a.workspace_id]);
  await pool.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES($1,$2,$3)',[peer.thread_id,a.workspace_id,peer.channel_id]);
  const firstId = randomUUID(), secondId = randomUUID(), client = randomUUID();
  await insert(a,firstId,client); await insert(peer,secondId);
  const leaves = await pool.query('SELECT DISTINCT tableoid::regclass::text AS leaf FROM messages WHERE id=ANY($1::uuid[])',[[firstId,secondId]]);
  assert.equal(leaves.rowCount,1);
  await assert.rejects(insert(peer,firstId),{code:'23505'});
  await assert.rejects(insert(peer,randomUUID(),client,'ON CONFLICT DO NOTHING'),{code:'23505'});
  await consistent();
});

test('v17 copy preserves all message, asset, event and counter values and failed migration rolls back', async () => {
  const name = `partition_legacy_${randomBytes(8).toString('hex')}`;
  const legacy = new Pool({connectionString:url,options:`-c search_path=${name}`});
  await admin.query(`CREATE SCHEMA ${name}`);
  try {
    const directory = new URL('../../adapters/postgres/migrations/',import.meta.url);
    const files = (await readdir(directory)).filter(f=>/^0(0\d|1[0-7])_.*\.sql$/.test(f)).sort();
    for (const file of files) await legacy.query(await readFile(new URL(file,directory),'utf8'));
    await legacy.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO schema_migrations(version) SELECT generate_series(1,17)');
    const a = await bootstrap(legacy), chat = new ChatStore(legacy);
    const human = {id:randomUUID()};
    await legacy.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text,document)
      VALUES($1,$2,$3,$4,'human',$5,$6,'legacy','Rich history',$7)`,[human.id,a.workspace_id,a.channel_id,a.thread_id,a.owner_id,randomUUID(),{ops:[{insert:'Rich history\n'}]}]);
    // Seed the historical schema directly; current stores require columns added after v17.
    const task = { id: randomUUID() };
    await legacy.query(`INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,status,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,'Preserve agent','demo.echo',$5,'awaiting_approval',$6,'legacy')`,[task.id,a.workspace_id,a.thread_id,a.installation_id,a.owner_id,randomUUID()]);
    await legacy.query(`INSERT INTO task_events(id,type,workspace_id,actor_id,resource_id,correlation_id,sequence,payload)
      VALUES($1,'task.proposed',$2,$3,$4,$4,1,$5)`,[randomUUID(),a.workspace_id,a.owner_id,task.id,{goal:'Preserve agent'}]);
    await legacy.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,task_id,installation_id,text) VALUES($1,$2,$3,$4,$5,$6,'Agent history')`,[randomUUID(),a.workspace_id,a.channel_id,a.thread_id,task.id,a.installation_id]);
    const asset = randomUUID();
    await legacy.query(`INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id)
      VALUES($1,$2,$3,$4,'old.txt',1,'text/plain',$1::uuid::text,$1::uuid::text,'ready',$5)`,[asset,a.workspace_id,a.channel_id,a.owner_id,human.id]);
    await legacy.query('UPDATE messages SET attachments=$1 WHERE id=$2',[JSON.stringify([{id:asset,name:'old.txt',size:1,type:'text/plain'}]),human.id]);
    // Compare the original v17 fields; later migrations add defaulted runtime state.
    const tables = ['messages','assets','channel_events','channels'];
    const columns = await Promise.all(tables.map(async table => (await legacy.query(`SELECT * FROM ${table} LIMIT 0`)).fields.map(field => `"${field.name}"`).join(',')));
    const snapshot = async () => Promise.all(tables.map(async (table,index) => (await legacy.query(`SELECT to_jsonb(t) AS row FROM (SELECT ${columns[index]} FROM ${table}) t ORDER BY to_jsonb(t)::text`)).rows));
    const before = await snapshot();
    // Fail after all migration DDL has run, at the version recording boundary.
    await legacy.query(`CREATE FUNCTION reject_partition_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.version=18 THEN RAISE EXCEPTION 'deliberate migration rollback'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_partition_migration BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_partition_migration()`);
    await assert.rejects(migrate(legacy), (error: any) => error.cause?.message === 'deliberate migration rollback');
    assert.deepEqual(await snapshot(),before);
    assert.equal((await legacy.query("SELECT relkind FROM pg_class WHERE oid='messages'::regclass")).rows[0].relkind,'r');
    assert.equal((await legacy.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version,17);
    await legacy.query('DROP TRIGGER reject_partition_migration ON schema_migrations; DROP FUNCTION reject_partition_migration()'); await migrate(legacy);
    assert.deepEqual(await snapshot(),before);
    assert.equal((await legacy.query('SELECT count(*) FROM messages WHERE reaction_sequence<>0 OR agent_session_id IS NOT NULL')).rows[0].count,'0');
    assert.equal((await legacy.query('SELECT count(*) FROM assets WHERE processing_token IS NOT NULL OR processing_until IS NOT NULL')).rows[0].count,'0');
    assert.equal((await legacy.query('SELECT count(*) FROM message_identities')).rows[0].count,'2');
    const stats = (await legacy.query(`SELECT DISTINCT tablename FROM pg_stats WHERE schemaname=current_schema()
      AND tablename IN ('messages','channel_events','message_identities')`)).rows.map(row=>row.tablename).sort();
    assert.deepEqual(stats,['channel_events','message_identities','messages']);
    const next = await chat.send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'After partitioning'});
    assert.equal(BigInt(next.sequence!),BigInt(before[3]![0]!.row.event_sequence)+1n);
    await migrate(legacy);
  } finally { await legacy.end(); await admin.query(`DROP SCHEMA ${name} CASCADE`); }
});
