// One instance per workspace. On connection loss exit so the supervisor reconnects,
// subscribes first and reconciles the source and index again.
import { createPool } from '@space/postgres/database';
import { syncFiles } from './markdown-files.mjs';
import { uuid } from '@space/contracts';
const workspace = uuid(process.env.KNOWLEDGE_WORKSPACE_ID);
const source = createPool(process.env.THREAD_SOURCE_URL);
const index = createPool(process.env.THREAD_INDEX_URL);
const listener = await source.connect();
const pending = new Map();
let publishGraph = true;
let channels = new Set(), rescan = true, draining = false, closed = false;
const pageSize = 32;

async function embed(bodies) {
  const response = await fetch('http://127.0.0.1:11434/api/embed', {method:'POST',
      headers:{'content-type':'application/json'}, signal:AbortSignal.timeout(30000),
      body:JSON.stringify({model:'all-minilm:22m',input:bodies})});
  if (!response.ok) throw Error('Thread embedding failed');
  const vectors = (await response.json()).embeddings;
  if (vectors?.length !== bodies.length || !vectors.every(v => v.length===384 && v.every(Number.isFinite))) throw Error('Invalid thread embeddings');
  return vectors;
}

async function sync(channel, ids) {
  if (await syncFiles(source,index,workspace,channel,ids,embed)) publishGraph = true;
  const { rows } = await source.query(
    "SELECT id,thread_id,search_revision,body FROM knowledge_thread_messages WHERE btrim(body)<>'' AND workspace_id=$1 AND channel_id=$2 AND id=ANY($3::uuid[])",
    [workspace,channel,ids]);
  const { rows: existing } = await index.query(
    'SELECT id,revision FROM kb.thread_messages WHERE workspace_id=$1 AND channel_id=$2 AND id=ANY($3::text[])',
    [workspace,channel,ids]);
  const old = new Map(existing.map(row => [row.id,row.revision]));
  const live = new Set(rows.map(row => row.id));
  const removed = existing.filter(row => !live.has(row.id)).map(row => row.id);
  const changed = rows.filter(row => old.get(row.id) !== row.search_revision);
  if (!removed.length && !changed.length) return;
  const vectors = changed.length ? await embed(changed.map(row => row.body)) : [];
  const client = await index.connect();
  try {
    await client.query('BEGIN');
    if (removed.length) {
      await client.query("SELECT pgcontext.delete_points('kb_threads',$1::text[])",[removed]);
      const deleted = await client.query('DELETE FROM kb.thread_messages WHERE workspace_id=$1 AND id=ANY($2::text[]) RETURNING thread_id',[workspace,removed]);
      await client.query('DELETE FROM kb.threads t WHERE t.id=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM kb.thread_messages m WHERE m.thread_id=t.id)',[deleted.rows.map(r=>r.thread_id)]);
    }
    for (const [i,row] of changed.entries()) {
      await client.query('INSERT INTO kb.threads VALUES($1) ON CONFLICT DO NOTHING',[row.thread_id]);
      await client.query(`INSERT INTO kb.thread_messages(id,workspace_id,channel_id,thread_id,revision,body,embedding)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body,
        embedding=EXCLUDED.embedding WHERE kb.thread_messages.revision<=EXCLUDED.revision`,
        [row.id,workspace,channel,row.thread_id,row.search_revision,row.body,JSON.stringify(vectors[i])]);
    }
    if (changed.length) await client.query("SELECT pgcontext.upsert_points('kb_threads',$1::text[])",[changed.map(row => row.id)]);
    await client.query('COMMIT');
    if (removed.length || changed.some(row=>!old.has(row.id))) publishGraph=true;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Repair both missing and obsolete rows in bounded pages, also after a channel opts out.
async function reconcile() {
  const { rows } = await source.query('SELECT channel_id FROM knowledge_thread_channels WHERE workspace_id=$1',[workspace]);
  channels = new Set(rows.map(row => row.channel_id));
  let after = '';
  for (;;) {
    const { rows: batch } = await index.query('SELECT channel_id,id,coalesce(source_message_id::text,id) AS parent FROM kb.thread_messages WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT $3',[workspace,after,pageSize]);
    if (!batch.length) break;
    for (const channel of new Set(batch.map(r=>r.channel_id))) await sync(channel,[...new Set(batch.filter(r=>r.channel_id===channel).map(r=>r.parent))]);
    after = batch.at(-1).id;
  }
  for (const channel of channels) {
    let cursor = null;
    for (;;) {
      const { rows: batch } = await source.query('SELECT id FROM knowledge_thread_messages WHERE workspace_id=$1 AND channel_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',[workspace,channel,cursor,pageSize]);
      if (!batch.length) break;
      await sync(channel,batch.map(r=>r.id));
      cursor = batch.at(-1).id;
    }
  }
}
async function drain() {
  if (draining || closed) return;
  draining = true;
  try {
    while (rescan || pending.size) {
      if (rescan) { rescan=false; pending.clear(); await reconcile(); }
      else {
        const channel = pending.values().next().value;
        const ids = [];
        for (const [id,c] of pending) if (c===channel) { pending.delete(id); ids.push(id); if (ids.length===pageSize) break; }
        await sync(channel,ids);
      }
    }
    // Also flush graph changes committed just before a prior worker stopped.
    if (publishGraph) {
      const publisher = await index.connect();
      try {
        await publisher.query('BEGIN');
        await publisher.query("SELECT * FROM graph.build_graph('space_threads',true)");
        await publisher.query('UPDATE kb.thread_messages SET published=true WHERE workspace_id=$1 AND NOT published',[workspace]);
        await publisher.query('COMMIT');
        publishGraph=false;
      } catch (e) { await publisher.query('ROLLBACK'); throw e; }
      finally { publisher.release(); }
    }
  } finally { draining=false; }
  if (rescan || pending.size) await drain();
}
function fail(e) { console.error('Thread ingestion stopped:',e.code ?? e.name); process.exit(1); }
listener.on('error',fail);
listener.on('end',()=>{ if (!closed) fail(Error('Source disconnected')); });
listener.on('notification',({payload})=>{
  if (payload==='reconcile' || pending.size>=2048) rescan=true;
  else {
    const [channel,id] = (payload??'').split('/');
    if (!channels.has(channel) || !id) return;
    pending.set(id,channel);
  }
  void drain().catch(fail);
});
await listener.query('LISTEN space_kb_'+workspace.replaceAll('-',''));
await drain();
console.log('Thread index ready');
for (const name of ['SIGTERM','SIGINT']) process.once(name,()=>{closed=true; process.exit(0);});
