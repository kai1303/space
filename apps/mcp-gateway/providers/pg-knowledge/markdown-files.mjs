import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

let storage;
const binaryText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
async function markdownText(file) {
  if (file.preview?.kind === 'text' && !file.preview.truncated) return file.preview.text;
  // A sealed object never changes. Older uploads may have no preview, and a preview
  // is only a prefix for large files. Read exactly the object named by the source view.
  if (file.preview && !['text', 'unsupported'].includes(file.preview.kind)) return '';
  const env = process.env;
  if (!env.ASSET_STORAGE_ENDPOINT || !env.ASSET_STORAGE_BUCKET) throw Error('Markdown original storage is not configured');
  storage ??= new S3Client({region:'us-east-1',endpoint:env.ASSET_STORAGE_ENDPOINT,forcePathStyle:true,
    credentials:{accessKeyId:env.ASSET_STORAGE_ACCESS_KEY,secretAccessKey:env.ASSET_STORAGE_SECRET_KEY}});
  const object = await storage.send(new GetObjectCommand({Bucket:env.ASSET_STORAGE_BUCKET, Key:file.object_key,
    Range:`bytes=0-${file.size - 1}`}), {abortSignal:AbortSignal.timeout(30000)});
  try {
    if (object.ContentLength !== file.size) throw Error('Markdown original size mismatch');
    const bytes = await object.Body.transformToByteArray();
    if (bytes.length !== file.size) throw Error('Incomplete Markdown original');
    try {
      const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
      return binaryText.test(text) ? '' : text;
    } catch (error) {
      if (error instanceof TypeError) return '';
      throw error;
    }
  } finally { object.Body?.destroy(); }
}

function* passages(text) {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 1400, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline > start + 700) end = newline + 1;
      else if (text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
    }
    const body = text.slice(start, end).trim();
    if (body) yield body;
    start = end;
  }
}

// Part zero is written last. A restart can safely replay partial, unpublished batches.
async function indexFile(index, workspace, channel, file, embed) {
  const text = await markdownText(file);
  let first, batch = [], ordinal = 0;
  async function write(parts) {
    const vectors = await embed(parts.map(p => file.name + '\n' + p.body));
    const client = await index.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO kb.threads VALUES($1) ON CONFLICT DO NOTHING', [file.thread_id]);
      const keys = [];
      for (const [i, p] of parts.entries()) {
        const key = file.id + '/' + p.ordinal;
        await client.query(`INSERT INTO kb.thread_messages
          (id,workspace_id,channel_id,thread_id,revision,body,embedding,source_message_id,asset_id,part)
          VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
          [key,workspace,channel,file.thread_id,p.body,JSON.stringify(vectors[i]),file.message_id,file.id,p.ordinal]);
        keys.push(key);
      }
      await client.query("SELECT pgcontext.upsert_points('kb_threads',$1::text[])",[keys]);
      await client.query("SELECT pgcontext.upsert_points('kb_markdown',$1::text[])",[keys]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  for (const body of passages(text)) {
    const part = {ordinal:ordinal++, body};
    if (!first) first = part;
    else batch.push(part);
    if (batch.length === 16) { await write(batch); batch = []; }
  }
  if (!first) return false;
  await write([...batch, first]);
  return true;
}

export async function syncFiles(source,index,workspace,channel,messages,embed) {
  const live = await source.query(`SELECT id FROM knowledge_thread_files
    WHERE workspace_id=$1 AND channel_id=$2 AND message_id=ANY($3::uuid[])`,[workspace,channel,messages]);
  const existing = await index.query(`SELECT asset_id,bool_or(part=0) AS complete FROM kb.thread_messages
    WHERE workspace_id=$1 AND channel_id=$2 AND source_message_id=ANY($3::uuid[]) GROUP BY asset_id`,[workspace,channel,messages]);
  const complete = new Set(existing.rows.filter(f => f.complete).map(f => f.asset_id));
  const attached = new Set(live.rows.map(f => f.id));
  const removed = existing.rows.filter(f => !attached.has(f.asset_id)).map(f => f.asset_id);
  let changed = false;
  if (removed.length) {
    // Bound each extension call even for large originals. The source ACL already hides them.
    for (;;) {
      const client = await index.connect();
      let count;
      try {
        await client.query('BEGIN');
        const {rows} = await client.query(`DELETE FROM kb.thread_messages WHERE id IN
          (SELECT id FROM kb.thread_messages WHERE asset_id=ANY($1::uuid[]) AND workspace_id=$2 LIMIT 128)
          RETURNING id,thread_id`,[removed,workspace]);
        count = rows.length;
        if (count) {
          const keys = rows.map(row => row.id);
          await client.query("SELECT pgcontext.delete_points('kb_threads',$1::text[])", [keys]);
          await client.query("SELECT pgcontext.delete_points('kb_markdown',$1::text[])", [keys]);
          await client.query('DELETE FROM kb.threads t WHERE id=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM kb.thread_messages m WHERE m.thread_id=t.id)',[rows.map(r=>r.thread_id)]);
        }
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      if (count < 128) break;
    }
    changed = true;
  }
  for (const id of attached) {
    if (complete.has(id)) continue;
    const {rows:[file]} = await source.query('SELECT * FROM knowledge_thread_files WHERE workspace_id=$1 AND channel_id=$2 AND id=$3',[workspace,channel,id]);
    if (file && await indexFile(index,workspace,channel,file,embed)) changed = true;
  }
  return changed;
}
