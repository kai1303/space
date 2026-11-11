// Run with TEST_DATABASE_URL (Space test DB) and a disposable provider index, initialized with threads.sql.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@space/postgres/database';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { AssetStore } from '@space/postgres/assets';
import { ChatStore } from '@space/postgres/chat';
import { assetDownloadPath, parseConversationPath } from '@space/contracts';
import { searchThreads } from './thread-search.mjs';
const schema='thread_test_'+randomUUID().replaceAll('-','');
const admin=createPool(process.env.TEST_DATABASE_URL), index=createPool(process.env.THREAD_INDEX_URL), reader=createPool(process.env.KNOWLEDGE_DATABASE_URL);
const url=new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set('options','-c search_path='+schema);
const source=createPool(url.href);
let worker;
async function stop() {
  if (worker && worker.exitCode===null && worker.signalCode===null) {
    const ended=once(worker,'exit');worker.kill();await ended;
  }
}
async function until(fn) {
  const deadline=Date.now()+20000;
  while (Date.now()<deadline) { if(await fn()) return;await delay(150); }
  throw Error('Timed out waiting for the index');
}
try {
  await admin.query('CREATE SCHEMA '+schema);
  await migrate(source);
  const seed=await bootstrap(source), chat=new ChatStore(source);
  const send=(text,thread_id)=>chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text,...(thread_id?{thread_id}:{})});
  const root=await send('Checkout retry support uses the Ember handbook.');
  const start=()=>{worker=spawn(process.execPath,[fileURLToPath(new URL('./thread-worker.mjs',import.meta.url))],{
    env:{...process.env,THREAD_SOURCE_URL:url.href,KNOWLEDGE_WORKSPACE_ID:seed.workspace_id},stdio:['ignore','ignore','inherit']});};
  await source.query('INSERT INTO knowledge_thread_channels VALUES($1,$2)',[seed.workspace_id,seed.channel_id]);start();
  const indexed=async id=>(await index.query('SELECT body,published FROM kb.thread_messages WHERE workspace_id=$1 AND id=$2',[seed.workspace_id,id])).rows[0];
  await until(async()=>(await indexed(root.id))?.published);
  const reply=await send('The team confirmed the escalation code is juniper.',root.thread_id);
  await until(async()=>(await indexed(reply.id))?.published);
  const context={workspaceId:seed.workspace_id,requesterId:seed.owner_id,connectionId:randomUUID(),audience:{channelId:seed.channel_id}};
  const {embeddings:[vector]}=await(await fetch('http://127.0.0.1:11434/api/embed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'all-minilm:22m',input:'Ember retry'})})).json();
  const hits=async()=>{
    const client=await reader.connect();
    try {
      await client.query("SET graph.query_freshness='off'");await client.query("SELECT graph.select_graph('space_threads')");
      return await searchThreads(client,source,context,'Ember retry',vector,8);
    }finally{client.release(true);}
  };
  assert.deepEqual(new Set((await hits()).map(h=>parseConversationPath(h.citation.url).message)),new Set([root.id,reply.id]));
  await stop();
  await source.query('UPDATE messages SET text=$3 WHERE channel_id=$1 AND id=$2',[seed.channel_id,reply.id,'The revised escalation code is cedar.']);
  await chat.deleteMessage(seed.owner_id,seed.channel_id,root.id);
  assert.deepEqual(await hits(),[],'deleted and stale text must be hidden even while the worker is offline');
  start();
  await until(async()=>!(await indexed(root.id)) && (await indexed(reply.id))?.body.includes('cedar'));
  assert.equal((await hits())[0]?.ref.recordId,'message/'+reply.id);
  // A file-only message must be found through its attachment, with a link to
  // the original bytes. The last passage contains the only escalation code.
  const assets = new AssetStore(source);
  const body = 'Routine operation. '.repeat(150) + '\nEscalation code: STONE-RAIN-73.';
  const upload = await assets.create(seed.owner_id,seed.channel_id,{name:'Support.MD',size:Buffer.byteLength(body),type:'text/markdown'});
  await assets.complete(seed.owner_id,upload.id,async () => ({kind:'text',language:'markdown',text:body,truncated:false}));
  await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text:'',asset_ids:[upload.id]});
  const fileHits = async (requester = seed.owner_id) => {
    const client = await reader.connect();
    try {
      await client.query("SET graph.query_freshness='off'");
      await client.query("SELECT graph.select_graph('space_threads')");
      return await searchThreads(client,source,{...context,requesterId:requester},'STONE-RAIN-73 escalation',vector,8,true);
    } finally { client.release(true); }
  };
  assert.deepEqual(await fileHits(),[]);
  await source.query('UPDATE knowledge_thread_channels SET index_markdown=true WHERE workspace_id=$1',[seed.workspace_id]);
  await until(async () => (await fileHits()).some(hit => hit.evidence.includes('STONE-RAIN-73')));
  const passages = await fileHits();
  assert.ok(passages.length>1);
  assert.ok(passages.every(hit => hit.citation.url===assetDownloadPath(upload.id) && hit.citation.label==='Support.MD'));
  assert.deepEqual(await fileHits(randomUUID()),[]);
  await stop();
  await source.query('UPDATE knowledge_thread_channels SET index_markdown=false WHERE workspace_id=$1',[seed.workspace_id]);
  assert.deepEqual(await fileHits(),[],'file opt-out hides all passages immediately');
  start();
  await until(async () => !(await index.query('SELECT 1 FROM kb.thread_messages WHERE asset_id=$1',[upload.id])).rowCount);
  await source.query('DELETE FROM knowledge_thread_channels WHERE workspace_id=$1',[seed.workspace_id]);
  assert.deepEqual(await hits(),[]);
  await until(async()=>!(await indexed(reply.id)));
  console.log('PASS: backfill, live reply, graph membership, exact message citations, stopped-worker edits/deletions, restart recovery, file-only post, multi-passage Markdown, original file citation, revoked file access and opt-out.');
} finally {
  await stop();await source.end();await index.end();await reader.end();
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
