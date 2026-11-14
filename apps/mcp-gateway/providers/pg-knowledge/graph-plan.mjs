// Turns one committed Space change into guarded SQL for the memory graph. Pure apart from `lookup`.
// Each write is idempotent: a row is replaced only by a change with a higher version (its WAL position),
// so a replay or an older change after a newer one changes nothing. Parents that have not arrived yet get
// version-0 placeholders that any real row replaces.
//
// lookup.message(workspace, id)            -> hydrated message with its embedding, or null when it is not in the source view
// lookup.threadsOf(workspace, messageIds)  -> Map message -> { message, thread, channel, kind }
// lookup.channelsOfThreads(workspace, ids) -> Map thread  -> { thread, channel, kind }
export const TABLES = ['channels', 'messages', 'knowledge_notes', 'agent_sessions', 'assets'];

const arrayOf = value => Array.isArray(value) ? value.map(String) : String(value ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);
const sql = (text, values) => ({ text, values });

export function lsnToVersion(lsn) {
  const match = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(String(lsn));
  if (!match) throw new Error('Invalid LSN');
  return (BigInt('0x' + match[1]) << 32n) | BigInt('0x' + match[2]);
}

const channelStub = (id, workspace) => sql(
  `INSERT INTO kb.m_channels(id,workspace_id,name,is_private,memory_enabled,knowledge_enabled,version) VALUES($1::text,$2::uuid,'',true,false,false,0) ON CONFLICT (id) DO NOTHING`,
  [id, workspace]);
const threadStub = (id, channel, workspace) => sql(
  `INSERT INTO kb.m_threads(id,workspace_id,channel_id,version) VALUES($1::text,$2::uuid,$3::text,0) ON CONFLICT (id) DO NOTHING`,
  [id, workspace, channel]);
const sessionStub = (id, thread, workspace) => sql(
  `INSERT INTO kb.m_sessions(id,workspace_id,thread_id,title,state,version) VALUES($1::text,$2::uuid,$3::text,'','active',0) ON CONFLICT (id) DO NOTHING`,
  [id, workspace, thread]);

// Counts, root and activity come from the indexed messages. `exclude` leaves out a message that is about to be deleted.
const recomputeThread = (thread, message) => sql(
  `UPDATE kb.m_threads t SET
     reply_count = greatest((SELECT count(*) FROM kb.m_messages m WHERE m.thread_id=t.id AND m.memory AND m.id IS DISTINCT FROM $2::text)::int - 1, 0),
     last_activity_at = (SELECT max(m.created_at) FROM kb.m_messages m WHERE m.thread_id=t.id AND m.id IS DISTINCT FROM $2::text),
     root_message_id = (SELECT m.id FROM kb.m_messages m WHERE m.thread_id=t.id AND m.id IS DISTINCT FROM $2::text ORDER BY m.sequence LIMIT 1)
   WHERE t.id = coalesce($1::text, (SELECT thread_id FROM kb.m_messages WHERE id=$2::text))`,
  [thread, message]);

function planChannel({ op, row }, version) {
  if (op === 'delete') return [sql('DELETE FROM kb.m_channels WHERE id=$1::text AND version<=$2::bigint', [row.id, String(version)])];
  if (row.kind !== 'channel') return [];
  // Space never stores a null topic or description, so null here means "not in this change" (an older WAL
  // record, or an unchanged TOAST value): keep the stored text.
  const textOf = value => typeof value === 'string' ? value : null;
  return [sql(
    `INSERT INTO kb.m_channels(id,workspace_id,name,is_private,memory_enabled,knowledge_enabled,topic,description,archived,version) VALUES($1::text,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::bigint)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,is_private=EXCLUDED.is_private,memory_enabled=EXCLUDED.memory_enabled,knowledge_enabled=EXCLUDED.knowledge_enabled,
       topic=coalesce(EXCLUDED.topic,kb.m_channels.topic),description=coalesce(EXCLUDED.description,kb.m_channels.description),
       archived=coalesce(EXCLUDED.archived,kb.m_channels.archived),version=EXCLUDED.version
     WHERE kb.m_channels.version<EXCLUDED.version`,
    [row.id, row.workspace_id, row.name, row.private, row.memory_enabled, row.knowledge_enabled, textOf(row.topic), textOf(row.description), row.archived_at === undefined ? null : row.archived_at !== null, String(version)])];
}

async function planMessage({ op, row }, version, lookup) {
  const v = String(version);
  const m = op === 'delete' ? null : await lookup.message(row.workspace_id, row.id);
  if (!m) {
    // Not (or no longer) in the source view: count without it, drop its vector point, then the row.
    return [
      recomputeThread(null, row.id),
      sql(`SELECT pgcontext.delete_points('kb_memory', ARRAY(SELECT id FROM kb.m_messages WHERE id=$1::text AND version<=$2::bigint))`, [row.id, v]),
      sql('DELETE FROM kb.m_messages WHERE id=$1::text AND version<=$2::bigint', [row.id, v]),
    ];
  }
  const ops = [channelStub(m.channel_id, m.workspace_id), threadStub(m.thread_id, m.channel_id, m.workspace_id)];
  if (m.author_id) ops.push(sql(
    `INSERT INTO kb.m_people(id,workspace_id,kind) VALUES($1::text,$2::uuid,$3) ON CONFLICT (id) DO NOTHING`,
    [m.author_id, m.workspace_id, m.author_type === 'human' ? 'human' : 'agent']));
  ops.push(
    sql(`INSERT INTO kb.m_messages(id,workspace_id,thread_id,author_id,sequence,revision,created_at,memory,knowledge,body,embedding,version)
         VALUES($1::text,$2::uuid,$3::text,$4,$5::bigint,$6::bigint,$7::timestamptz,$8,$9,$10,$11,$12::bigint)
         ON CONFLICT (id) DO UPDATE SET thread_id=EXCLUDED.thread_id,author_id=EXCLUDED.author_id,sequence=EXCLUDED.sequence,revision=EXCLUDED.revision,
           memory=EXCLUDED.memory,knowledge=EXCLUDED.knowledge,body=EXCLUDED.body,embedding=EXCLUDED.embedding,version=EXCLUDED.version
         WHERE kb.m_messages.version<EXCLUDED.version`,
      [m.id, m.workspace_id, m.thread_id, m.author_id ?? null, m.sequence, m.search_revision, m.created_at, m.memory, m.knowledge, m.body, JSON.stringify(m.embedding), v]),
    sql(`SELECT pgcontext.upsert_points('kb_memory', ARRAY[$1::text]) WHERE EXISTS (SELECT 1 FROM kb.m_messages WHERE id=$1::text AND version=$2::bigint)`, [m.id, v]));
  if (m.agent_session_id) ops.push(
    sessionStub(m.agent_session_id, m.thread_id, m.workspace_id),
    sql(`INSERT INTO kb.m_session_turns(id,workspace_id,session_id,message_id) VALUES($1::text,$2::uuid,$3::text,$1::text) ON CONFLICT (id) DO NOTHING`,
      [m.id, m.workspace_id, m.agent_session_id]));
  ops.push(recomputeThread(m.thread_id, null));
  return ops;
}

function planAttachment({ op, row }, version) {
  const v = String(version);
  if (op === 'delete') return [sql('DELETE FROM kb.m_attachments WHERE id=$1::text AND version<=$2::bigint', [row.id, v])];
  return [
    channelStub(row.channel_id, row.workspace_id),
    threadStub(row.thread_id, row.channel_id, row.workspace_id),
    sql(`INSERT INTO kb.m_attachments(id,workspace_id,channel_id,thread_id,message_id,name,type,size,version)
         VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8::integer,$9::bigint)
         ON CONFLICT (id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,channel_id=EXCLUDED.channel_id,
           thread_id=EXCLUDED.thread_id,message_id=EXCLUDED.message_id,name=EXCLUDED.name,
           type=EXCLUDED.type,size=EXCLUDED.size,version=EXCLUDED.version
         WHERE kb.m_attachments.version<EXCLUDED.version`,
      [row.id, row.workspace_id, row.channel_id, row.thread_id, row.message_id, row.name, row.type, row.size, v]),
  ];
}

async function planKnowledge({ op, row }, version, lookup) {
  const v = String(version);
  if (op === 'delete' || row.removed_at) return [sql('DELETE FROM kb.m_knowledge WHERE id=$1::text AND version<=$2::bigint', [row.id, v])];
  const messages = arrayOf(row.evidence);
  const found = messages.length ? await lookup.threadsOf(row.workspace_id, messages) : new Map();
  // Evidence must come from the knowledge's own channel, and only channel threads are kept.
  const kept = messages.flatMap(id => {
    const hit = found.get(id);
    return hit && hit.kind === 'channel' && hit.channel === row.channel_id ? [hit] : [];
  });
  const threads = [...new Set(kept.map(h => h.thread))];
  const won = 'EXISTS (SELECT 1 FROM kb.m_knowledge WHERE id=$1::text AND version=$4::bigint)';
  return [
    channelStub(row.channel_id, row.workspace_id),
    ...threads.map(t => threadStub(t, row.channel_id, row.workspace_id)),
    sql(`INSERT INTO kb.m_knowledge(id,workspace_id,channel_id,kind,title,revision,version) VALUES($1::text,$2::uuid,$3::text,$4,$5,$6::int,$7::bigint)
         ON CONFLICT (id) DO UPDATE SET channel_id=EXCLUDED.channel_id,kind=EXCLUDED.kind,title=EXCLUDED.title,revision=EXCLUDED.revision,version=EXCLUDED.version
         WHERE kb.m_knowledge.version<EXCLUDED.version`,
      [row.id, row.workspace_id, row.channel_id, row.kind, row.title, row.revision, v]),
    sql(`DELETE FROM kb.m_knowledge_evidence WHERE knowledge_id=$1::text AND workspace_id=$2::uuid AND NOT (message_id=ANY($3::text[])) AND ${won}`,
      [row.id, row.workspace_id, kept.map(h => h.message), v]),
    sql(`INSERT INTO kb.m_knowledge_evidence(id,workspace_id,knowledge_id,thread_id,message_id)
         SELECT $1::text||'/'||e.m,$2::uuid,$1::text,e.t,e.m FROM unnest($3::text[],$5::text[]) AS e(m,t)
         WHERE ${won} ON CONFLICT (id) DO NOTHING`,
      [row.id, row.workspace_id, kept.map(h => h.message), v, kept.map(h => h.thread)]),
  ];
}

async function planSession({ op, row }, version, lookup) {
  const v = String(version);
  if (op === 'delete') return [sql('DELETE FROM kb.m_sessions WHERE id=$1::text AND version<=$2::bigint', [row.id, v])];
  const owner = (await lookup.channelsOfThreads(row.workspace_id, [row.origin_thread_id])).get(row.origin_thread_id);
  if (!owner || owner.kind !== 'channel') return [];
  return [
    channelStub(owner.channel, row.workspace_id),
    threadStub(row.origin_thread_id, owner.channel, row.workspace_id),
    sql(`INSERT INTO kb.m_sessions(id,workspace_id,thread_id,title,state,version) VALUES($1::text,$2::uuid,$3::text,$4,$5,$6::bigint)
         ON CONFLICT (id) DO UPDATE SET thread_id=EXCLUDED.thread_id,title=EXCLUDED.title,state=EXCLUDED.state,version=EXCLUDED.version
         WHERE kb.m_sessions.version<EXCLUDED.version`,
      [row.id, row.workspace_id, row.origin_thread_id, row.title, row.state, v]),
  ];
}

export async function planChange(change, version, lookup) {
  if (change.table === 'graph_source_attachments') return planAttachment(change, version);
  if (change.table === 'channels') return planChannel(change, version);
  if (change.table === 'messages') return planMessage(change, version, lookup);
  if (change.table === 'knowledge_notes') return planKnowledge(change, version, lookup);
  if (change.table === 'agent_sessions') return planSession(change, version, lookup);
  return [];
}
