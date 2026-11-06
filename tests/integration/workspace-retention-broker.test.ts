import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { connect } from 'nats';
import { EventBus, streamName } from '@space/events';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

test('registered retention consumer redacts an expired message after its scheduled publisher shuts down', {timeout:45000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema=`retention_broker_${randomBytes(8).toString('hex')}`;
  const url=process.env.TEST_NATS_URL??'nats://127.0.0.1:54222';
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  // Stream cleanup must not race a shared CDC publisher still reading this fixture's WAL.
  const databaseUrl=new URL(process.env.TEST_DATABASE_URL);databaseUrl.pathname=`/${schema}`;
  const pool=new Pool({connectionString:databaseUrl.toString(),options:`-c search_path=${schema}`});
  const producer=new EventBus(url,schema);
  const messageId=randomUUID(),recentId=randomUUID();
  let handled!:(at:number)=>void;
  const completed=new Promise<number>(resolve=>{handled=resolve;});
  // Observe completion while preserving the real broker subscription, registered handler and ACK.
  class ObservedBus extends EventBus {
    override subscribe(filter:string,options:Parameters<EventBus['subscribe']>[1],handler:Parameters<EventBus['subscribe']>[2]) {
      return super.subscribe(filter,options,async delivery=>{
        let acknowledged=false;
        await handler({...delivery,ack:async()=>{await delivery.ack();acknowledged=true;}});
        if(acknowledged&&filter==='retention.message_due.*'&&delivery.event.aggregate_id===messageId)handled(Date.now());
      });
    }
  }
  const consumer=new ObservedBus(url,schema);
  const app=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{events:consumer}});
  let timer:NodeJS.Timeout|undefined;
  try {
    await admin.query(`CREATE DATABASE ${schema}`);await pool.query(`CREATE SCHEMA ${schema}`);await migrate(pool);
    const a=await bootstrap(pool);
    await pool.query('INSERT INTO workspace_preferences(workspace_id,retention_days) VALUES($1,1)',[a.workspace_id]);
    const writer=await pool.connect();
    let outbox:{id:string;kind:string;aggregate_id:string;payload:Record<string,unknown>;available_at:Date}|undefined;
    try {
      // Read the trigger's event before commit makes it eligible for CDC cleanup.
      await writer.query('BEGIN');
      for(const [id,days] of [[messageId,1],[recentId,0]] as const)await writer.query(
        "INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text,created_at) VALUES($1,$2,$3,$4,'human',$5,gen_random_uuid(),'broker-test','Confidential broker message',now()-make_interval(days=>$6)+CASE WHEN $6=1 THEN interval '8 seconds' ELSE interval '0 seconds' END)",
        [id,a.workspace_id,a.channel_id,a.thread_id,a.owner_id,days]);
      outbox=(await writer.query<NonNullable<typeof outbox>>(
        "SELECT id,kind,aggregate_id,payload,available_at FROM event_outbox WHERE kind='retention.message_due' AND aggregate_id=$1",[messageId])).rows[0]!;
      await writer.query('COMMIT');
    } catch(error) { await writer.query('ROLLBACK'); throw error; }
    finally { writer.release(); }
    assert.ok(outbox);
    const availableAt=outbox.available_at.toISOString();
    await producer.start();
    // Publish the SQL-generated deadline directly; WAL/CDC recovery is tested separately.
    await producer.publish({id:outbox.id,schema,kind:outbox.kind,aggregate_id:outbox.aggregate_id,data:outbox.payload,available_at:availableAt});
    await producer.close();
    await app.ready();
    const handledAt=await Promise.race([completed,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Registered retention consumer did not complete')),15000);
    })]);
    clearTimeout(timer);
    assert.ok(handledAt>=Date.parse(availableAt),'broker must preserve the scheduled deadline after publisher shutdown');
    await app.close();
    const rows=(await pool.query<{id:string;text:string;retained_at:Date|null}>('SELECT id,text,retained_at FROM messages WHERE workspace_id=$1 ORDER BY id',[a.workspace_id])).rows;
    const expired=rows.find(row=>row.id===messageId)!,recent=rows.find(row=>row.id===recentId)!;
    assert.ok(expired.retained_at);assert.equal(expired.text,'Message removed by workspace retention.');
    assert.equal(recent.retained_at,null);assert.equal(recent.text,'Confidential broker message');
    const history=(await pool.query("SELECT payload FROM channel_events WHERE channel_id=$1 AND payload->>'id'=$2",[a.channel_id,messageId])).rows;
    assert.ok(history.length>=2);assert.ok(history.every(row=>!JSON.stringify(row.payload).includes('Confidential')));
  }finally{
    clearTimeout(timer);await app.close();await producer.close();await consumer.close();
    await pool.end();await admin.query(`DROP DATABASE ${schema}`);await admin.end();
    const connection=await connect({servers:url});
    try{
      const manager=await connection.jetstreamManager();
      for(const suffix of ['CHAT','WORK'])await manager.streams.delete(`${streamName(schema)}_${suffix}`).catch(error=>{if(error.code!=='404')throw error;});
    }finally{await connection.close();}
  }
});
