import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EventBus, type EventDelivery } from '@space/events';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { ChatStore } from '@space/postgres/chat';
import { AssetStore } from '@space/postgres/assets';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
const schema=`deadlines_${randomBytes(8).toString('hex')}`;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
class ProbeBus extends EventBus {
  readonly handlers=new Map<string,Parameters<EventBus['subscribe']>[2]>();
  override async start() {}
  override async subscribeTransient() { return () => {}; }
  override async subscribe(filter: string, _options: Parameters<EventBus['subscribe']>[1], handler: Parameters<EventBus['subscribe']>[2]) { this.handlers.set(filter,handler); return async()=>{this.handlers.delete(filter);}; }
  override async close() {}
  async receive(kind:string,data:Record<string,unknown>,available_at=new Date(0).toISOString()) {
    let acknowledgments=0, retry:number|undefined;
    const delivery:EventDelivery={event:{id:randomUUID(),schema,kind,aggregate_id:'target',data,available_at},ack:()=>{acknowledgments++;},retry:(delay=1000)=>{retry=delay;}};
    await this.handlers.get(`${kind}.*`)!(delivery);
    return {acknowledgments,retry};
  }
}
const bus=new ProbeBus('nats://unused',schema),store=new PostgresStore(pool),assets=new AssetStore(pool);
const removed:string[]=[];
const storage={async createUpload(){return {url:'unused',fields:{}};},async finalize(){},async read(){return new Uint8Array();},async write(){},async inline(){return 'unused';},async download(){return 'unused';},async remove(key:string){removed.push(key);}};
const app=createApi(store,{allowDevelopmentTokens:true,realtime:{events:bus},storage});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await app.ready();});
after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});

test('connection deadline ignores a renewed heartbeat and rechecks database time before expiry',async()=>{
  const a=await bootstrap(pool),connection=randomUUID(),old=new Date(Date.now()-60000).toISOString();
  await pool.query('INSERT INTO agent_connections(installation_id,name,connection_id,last_seen_at) VALUES($1,$2,$3,now())',[a.installation_id,'Deadline test',connection]);
  const payload={installation_id:a.installation_id,connection_id:connection,last_seen_at:old};
  assert.equal((await bus.receive('connection.deadline',payload)).acknowledgments,1);
  assert.equal((await pool.query('SELECT connection_id FROM agent_connections WHERE installation_id=$1',[a.installation_id])).rows[0].connection_id,connection);
  const fresh=(await pool.query('SELECT last_seen_at::text AS last_seen_at FROM agent_connections WHERE installation_id=$1',[a.installation_id])).rows[0].last_seen_at;
  const early=await bus.receive('connection.deadline',{...payload,last_seen_at:fresh});
  assert.ok(early.retry!>40000);assert.equal(early.acknowledgments,0);
  await pool.query('UPDATE agent_connections SET last_seen_at=$2 WHERE installation_id=$1',[a.installation_id,old]);
  assert.equal((await bus.receive('connection.deadline',payload)).acknowledgments,1);
  assert.equal((await pool.query('SELECT connection_id FROM agent_connections WHERE installation_id=$1',[a.installation_id])).rows[0].connection_id,null);
});

test('delivery deadlines never fail a newer or not-yet-due attempt',async()=>{
  const a=await bootstrap(pool),task=await store.createTask(a.owner_id,{workspace_id:a.workspace_id,thread_id:a.thread_id,installation_id:a.installation_id,goal:'Deadline test',skill:'demo.echo'},randomUUID());
  await store.approveTask(a.owner_id,task.id);
  const id=(await pool.query('SELECT id FROM outbox WHERE task_id=$1',[task.id])).rows[0].id;
  const delivery=(await store.claimDelivery(undefined,id))!;
  const early=await bus.receive('delivery.deadline',{delivery_id:id,lease_token:delivery.lease_token});
  assert.ok(early.retry!>20000);assert.equal(early.acknowledgments,0);
  await pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);
  await bus.receive('delivery.deadline',{delivery_id:id,lease_token:randomUUID()});
  assert.equal((await store.readTask(a.owner_id,task.id)).status,'queued');
  await bus.receive('delivery.deadline',{delivery_id:id,lease_token:delivery.lease_token});
  assert.equal((await store.readTask(a.owner_id,task.id)).status,'failed');
});

test('asset deadline cleans only its target and retries while that target is processing',async()=>{
  const a=await bootstrap(pool),one=await assets.create(a.owner_id,a.channel_id,{name:'one.txt',size:1,type:'text/plain'}),two=await assets.create(a.owner_id,a.channel_id,{name:'two.txt',size:1,type:'text/plain'});
  await pool.query("UPDATE assets SET expires_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])",[[one.id,two.id]]);
  await pool.query("UPDATE assets SET processing_token=$2,processing_until=now()+interval '30 seconds' WHERE id=$1",[one.id,randomUUID()]);
  const busy=await bus.receive('asset.deadline',{asset_id:one.id});assert.ok(busy.retry!>20000);assert.equal(busy.acknowledgments,0);assert.equal(removed.length,0);
  await pool.query('UPDATE assets SET processing_token=NULL,processing_until=NULL WHERE id=$1',[one.id]);
  await bus.receive('asset.deadline',{asset_id:one.id});
  assert.equal((await pool.query('SELECT id FROM assets WHERE id=$1',[one.id])).rowCount,0);
  assert.equal((await pool.query('SELECT id FROM assets WHERE id=$1',[two.id])).rowCount,1);
  assert.ok(removed.includes(one.object_key));assert.ok(!removed.includes(two.object_key));
});


test('duplicate deadline for an attached asset with cleaned staging has no remaining obligation',async()=>{
  const a=await bootstrap(pool),asset=await assets.create(a.owner_id,a.channel_id,{name:'saved.txt',size:1,type:'text/plain'});
  await pool.query("UPDATE assets SET status='ready',staging_deleted_at=now() WHERE id=$1",[asset.id]);
  await new ChatStore(pool).send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Saved',asset_ids:[asset.id]});
  const result=await bus.receive('asset.deadline',{asset_id:asset.id});
  assert.equal(result.acknowledgments,1);assert.equal(result.retry,undefined);
  assert.equal((await pool.query('SELECT id FROM assets WHERE id=$1',[asset.id])).rowCount,1);
});
