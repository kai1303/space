// One instance per workspace. On connection loss exit so the supervisor reconnects,
// subscribes first and reconciles the source and index again.
import { createPool } from '@space/postgres/database';
import { syncFiles } from './markdown-files.mjs';
import { reconcileNotes, syncCitedNotes, syncNotes } from './notes-sync.mjs';
import { uuid } from '@space/contracts';
const workspace = uuid(process.env.KNOWLEDGE_WORKSPACE_ID);
const source = createPool(process.env.THREAD_SOURCE_URL);
const index = createPool(process.env.THREAD_INDEX_URL);
const listener = await source.connect();
const pending = new Map();
const pendingNotes = new Set();
const evidence = new Map();
// Installations without notes.sql keep working exactly as before.
const notesIndex = (await index.query("SELECT to_regclass('kb.notes') IS NOT NULL AS ok")).rows[0].ok;
const noteId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

// Thread messages are indexed by the Graph RAG reader (graph-reader.mjs). This worker keeps only
// Markdown files attached to messages, and knowledge notes.
async function sync(channel, ids) {
  if (await syncFiles(source,index,workspace,channel,ids,embed)) publishGraph = true;
}

// Repair both missing and obsolete rows in bounded pages, also after a channel opts out.
async function reconcile() {
  const { rows } = await source.query('SELECT channel_id FROM knowledge_thread_channels WHERE workspace_id=$1',[workspace]);
  channels = new Set(rows.map(row => row.channel_id));
  // Index side first: files whose message or channel left the source are removed by sync().
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { rows: batch } = await index.query('SELECT DISTINCT channel_id, source_message_id AS id FROM kb.thread_messages WHERE workspace_id=$1 AND asset_id IS NOT NULL AND source_message_id>$2::uuid ORDER BY source_message_id LIMIT $3',[workspace,after,pageSize]);
    if (!batch.length) break;
    for (const channel of new Set(batch.map(r=>r.channel_id))) await sync(channel,batch.filter(r=>r.channel_id===channel).map(r=>r.id));
    after = batch.at(-1).id;
  }
  for (const channel of channels) {
    let cursor = null;
    for (;;) {
      const { rows: batch } = await source.query("SELECT DISTINCT message_id AS id FROM knowledge_thread_files WHERE workspace_id=$1 AND channel_id=$2 AND ($3::uuid IS NULL OR message_id>$3) ORDER BY message_id LIMIT $4",[workspace,channel,cursor,pageSize]);
      if (!batch.length) break;
      await sync(channel,batch.map(r=>r.id));
      cursor = batch.at(-1).id;
    }
  }
  if (notesIndex) await reconcileNotes(source, index, workspace, embed);
}
async function drain() {
  if (draining || closed) return;
  draining = true;
  try {
    while (rescan || pending.size || pendingNotes.size || evidence.size) {
      if (rescan) { rescan=false; pending.clear(); pendingNotes.clear(); evidence.clear(); await reconcile(); }
      else if (pendingNotes.size) {
        const ids = [...pendingNotes].slice(0, pageSize);
        for (const id of ids) pendingNotes.delete(id);
        await syncNotes(source, index, workspace, ids, embed);
      }
      else {
        const changes = evidence.size ? evidence : pending;
        const channel = changes.values().next().value;
        const ids = [];
        for (const [id,c] of changes) if (c===channel) { changes.delete(id); ids.push(id); if (ids.length===pageSize) break; }
        if (changes === evidence) await syncCitedNotes(source, index, workspace, channel, ids, embed);
        else await sync(channel,ids);
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
  if (rescan || pending.size || pendingNotes.size || evidence.size) await drain();
}
function fail(e) { console.error('Thread ingestion stopped:',e.code ?? e.name); process.exit(1); }
listener.on('error',fail);
listener.on('end',()=>{ if (!closed) fail(Error('Source disconnected')); });
listener.on('notification',({payload})=>{
  if (payload==='reconcile' || pending.size+pendingNotes.size+evidence.size>=2048) rescan=true;
  else if (payload?.startsWith('evidence/')) {
    const [, channel, id] = payload.split('/');
    if (!notesIndex || !noteId.test(channel ?? '') || !noteId.test(id ?? '')) return;
    evidence.set(id, channel);
  }
  else if (payload?.startsWith('note/')) {
    const id = payload.split('/')[2];
    if (!notesIndex || !noteId.test(id ?? '')) return;
    pendingNotes.add(id);
  }
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
