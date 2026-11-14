import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { AgentConnectionStore } from '@space/postgres/agent-connections';
import { pdfToolToken } from '@space/postgres/pdf-access';
import { createApi } from '@space/server/api';
import { PDF_TOOL_PATH } from '@space/contracts';
import type { AssetStorage } from '@space/server/storage';

const schema = 'pdf_tool_' + randomBytes(6).toString('hex');
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const pdf = await readFile(new URL('../fixtures/preview/two-pages.pdf', import.meta.url));
let reads = 0;
let duringRead: (() => Promise<void>) | undefined;
const unused = async (): Promise<never> => { throw new Error('Unexpected storage operation'); };
const storage: AssetStorage = {
  async read() { reads++; await duringRead?.(); return pdf; },
  createUpload:unused, finalize:unused, download:unused, write:unused, inline:unused, remove:unused,
};
const store = new PostgresStore(pool), app = createApi(store, { storage });
let origin: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
});
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function fixture() {
  const base = await bootstrap(pool), connections = new AgentConnectionStore(pool);
  const pairing = await connections.createPairing(base.owner_id,base.workspace_id,{provider:'codex'});
  const paired = await connections.claim({code:pairing.code,credential:randomBytes(32).toString('base64url'),provider:'codex'});
  const session = randomUUID(), task = randomUUID(), execution = randomUUID(), asset = randomUUID(), connection = randomUUID();
  const delivery = { id:randomUUID(), execution_id:execution, lease_token:randomUUID() };
  await pool.query("UPDATE agent_connections SET connection_id=$2,auth_status='ready',last_seen_at=now() WHERE installation_id=$1",[paired.installation_id,connection]);
  await pool.query('INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id) VALUES($1,$2,$3,$4)',[session,base.workspace_id,paired.installation_id,base.thread_id]);
  await pool.query("INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,status,session_id,idempotency_key,request_hash,attachments) VALUES($1::uuid,$2,$3,$4,'read','codex.run',$5,'running',$6,$1::text,'test',$7)",[task,base.workspace_id,base.thread_id,paired.installation_id,base.collaborator_id,session,JSON.stringify([{id:asset,name:'source.pdf',size:pdf.length,type:'application/pdf'}])]);
  await pool.query("INSERT INTO executions(id,workspace_id,task_id,installation_id,session_id,status) VALUES($1,$2,$3,$4,$5,'running')",[execution,base.workspace_id,task,paired.installation_id,session]);
  await pool.query('UPDATE tasks SET active_execution_id=$2 WHERE id=$1',[task,execution]);
  await pool.query("INSERT INTO outbox(id,task_id,execution_id,state,lease_token,lease_until) VALUES($1,$2,$3,'delivering',$4,now()+interval '30 minutes')",[delivery.id,task,execution,delivery.lease_token]);
  await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,task_id,preview) VALUES($1::uuid,$2,$3,$4,'source.pdf',$5,'application/pdf',$1::text,$1::text,'ready',$6,'{\"kind\":\"pdf\",\"mime\":\"application/pdf\"}')",[asset,base.workspace_id,base.channel_id,base.collaborator_id,pdf.length,task]);
  const token = pdfToolToken(delivery,connection);
  return {...base,...paired,task,execution,asset,connection,delivery,token};
}

test('PDF tool is available through normal paired API and reads only its authorized attachment page',async()=>{
  const f = await fixture(), foreign = await fixture();
  const prepared = await store.prepareDelivery({...f.delivery, task_id:f.task, attempts:1}, f.connection);
  assert.equal(prepared?.request.pdf_tool_token, f.token);
  assert.equal(prepared.request.outbound, undefined);
  const client = new Client({name:'pdf-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + PDF_TOOL_PATH),{requestInit:{headers:{authorization:'Bearer '+prepared.request.pdf_tool_token}}}));
  try {
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['read_pdf_page']);
    const result = await client.callTool({name:'read_pdf_page',arguments:{asset_id:f.asset,page:2}});
    assert.notEqual(result.isError,true);
    const body = result.structuredContent as {pages:{page:number;text:string}[];citation:string;page_count:number};
    assert.equal(body.citation,`/file/${f.asset}?page=2`);
    assert.equal(body.page_count,2);
    assert.deepEqual(body.pages.map(p=>p.page),[2]);
    assert.match(body.pages[0]!.text,/Page 2 of 2/);
    for (const args of [{asset_id:foreign.asset,page:1},{asset_id:f.asset,page:0},{asset_id:f.asset,page:1,unexpected:true}]) {
      const before = reads;
      assert.equal((await client.callTool({name:'read_pdf_page',arguments:args})).isError,true);
      assert.equal(reads,before);
    }
    await assert.rejects(client.callTool({name:'arbitrary_external_tool',arguments:{}}),/not found/);
    const outside = await client.callTool({name:'read_pdf_page',arguments:{asset_id:f.asset,page:300}});
    assert.equal((outside.structuredContent as {status:string}).status,'out_of_range');
    await pool.query("UPDATE tasks SET attachments='[]' WHERE id=$1",[f.task]);
    await assert.rejects(client.listTools());
  } finally { await client.close(); }
});

for (const mode of ['requester_membership','owner_membership','stale_execution','connection_replaced','ended','expired','revoked'] as const)
test(`PDF token denies ${mode}`,async()=>{
  const f=await fixture(),client=new Client({name:'pdf-denied',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+PDF_TOOL_PATH),{requestInit:{headers:{authorization:'Bearer '+f.token}}}));
  try {
    const before=reads;
    if(mode==='requester_membership')await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[f.channel_id,f.collaborator_id]);
    if(mode==='owner_membership')await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[f.channel_id,f.owner_id]);
    if(mode==='stale_execution')await pool.query("UPDATE executions SET status='completed' WHERE id=$1",[f.execution]);
    if(mode==='connection_replaced')await pool.query('UPDATE agent_connections SET connection_id=$2 WHERE installation_id=$1',[f.installation_id,randomUUID()]);
    if(mode==='ended')await pool.query("UPDATE agent_sessions SET state='ended' WHERE id=(SELECT session_id FROM tasks WHERE id=$1)",[f.task]);
    if(mode==='expired')await pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[f.delivery.id]);
    if(mode==='revoked')await pool.query('UPDATE agent_connections SET revoked_at=now() WHERE installation_id=$1',[f.installation_id]);
    await assert.rejects(client.callTool({name:'read_pdf_page',arguments:{asset_id:f.asset,page:1}}));
    assert.equal(reads,before);
  }finally{await client.close();}
});

test('PDF tool rechecks access after extraction and suppresses revoked text',async()=>{
  const f=await fixture(),client=new Client({name:'pdf-revoked',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+PDF_TOOL_PATH),{requestInit:{headers:{authorization:'Bearer '+f.token}}}));
  duringRead=async()=>{await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[f.channel_id,f.collaborator_id]);};
  try {
    const result=await client.callTool({name:'read_pdf_page',arguments:{asset_id:f.asset,page:2}});
    assert.equal(result.isError,true);
    assert.doesNotMatch(JSON.stringify(result),/Page 2 of 2/);
  }finally{duringRead=undefined;await client.close();}
});
