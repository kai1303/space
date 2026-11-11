// Turns one committed Space change into guarded SQL for the knowledge graph. Pure apart from `lookup`.
// Each write is idempotent: a row is replaced only by a change with a higher version (its WAL position),
// so a replay or an older change after a newer one changes nothing. Parents that have not arrived yet get
// version-0 placeholders that any real row replaces.
export const TABLES = ['channels', 'knowledge_notes', 'agent_sessions'];

const arrayOf = value => Array.isArray(value) ? value.map(String) : String(value ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);
const sql = (text, values) => ({ text, values });

export function lsnToVersion(lsn) {
  const match = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(String(lsn));
  if (!match) throw new Error('Invalid LSN');
  return (BigInt('0x' + match[1]) << 32n) | BigInt('0x' + match[2]);
}

const channelStub = (id, workspace) => sql(
  `INSERT INTO kb.g_channels(id,workspace_id,name,is_private,enabled,version) VALUES($1::text,$2::uuid,'',true,false,0) ON CONFLICT (id) DO NOTHING`,
  [id, workspace]);
const threadStub = (id, channel, workspace) => sql(
  `INSERT INTO kb.g_threads(id,workspace_id,channel_id,version) VALUES($1::text,$2::uuid,$3::text,0) ON CONFLICT (id) DO NOTHING`,
  [id, workspace, channel]);

function planChannel({ op, row }, version) {
  if (op === 'delete') return [sql('DELETE FROM kb.g_channels WHERE id=$1::text AND version<=$2::bigint', [row.id, String(version)])];
  if (row.kind !== 'channel') return [];
  return [sql(
    `INSERT INTO kb.g_channels(id,workspace_id,name,is_private,enabled,version) VALUES($1::text,$2::uuid,$3,$4,$5,$6::bigint)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,is_private=EXCLUDED.is_private,enabled=EXCLUDED.enabled,version=EXCLUDED.version
     WHERE kb.g_channels.version<EXCLUDED.version`,
    [row.id, row.workspace_id, row.name, row.private, row.knowledge_enabled, String(version)])];
}

async function planKnowledge({ op, row }, version, lookup) {
  const v = String(version);
  if (op === 'delete' || row.removed_at) return [sql('DELETE FROM kb.g_knowledge WHERE id=$1::text AND version<=$2::bigint', [row.id, v])];
  const messages = arrayOf(row.evidence);
  const found = messages.length ? await lookup.threadsOf(row.workspace_id, messages) : new Map();
  // Evidence must come from the knowledge's own channel, and only channel threads are kept.
  const threads = [...new Set(messages.flatMap(m => {
    const hit = found.get(m);
    return hit && hit.kind === 'channel' && hit.channel === row.channel_id ? [hit.thread] : [];
  }))];
  const won = 'EXISTS (SELECT 1 FROM kb.g_knowledge WHERE id=$1::text AND version=$4::bigint)';
  return [
    channelStub(row.channel_id, row.workspace_id),
    ...threads.map(t => threadStub(t, row.channel_id, row.workspace_id)),
    sql(`INSERT INTO kb.g_knowledge(id,workspace_id,channel_id,kind,title,revision,version) VALUES($1::text,$2::uuid,$3::text,$4,$5,$6::int,$7::bigint)
         ON CONFLICT (id) DO UPDATE SET channel_id=EXCLUDED.channel_id,kind=EXCLUDED.kind,title=EXCLUDED.title,revision=EXCLUDED.revision,version=EXCLUDED.version
         WHERE kb.g_knowledge.version<EXCLUDED.version`,
      [row.id, row.workspace_id, row.channel_id, row.kind, row.title, row.revision, v]),
    sql(`DELETE FROM kb.g_evidence WHERE knowledge_id=$1::text AND workspace_id=$2::uuid AND NOT (thread_id=ANY($3::text[])) AND ${won}`,
      [row.id, row.workspace_id, threads, v]),
    sql(`INSERT INTO kb.g_evidence(id,workspace_id,knowledge_id,thread_id) SELECT $1::text||'/'||t,$2::uuid,$1::text,t FROM unnest($3::text[]) t
         WHERE ${won} ON CONFLICT (id) DO NOTHING`,
      [row.id, row.workspace_id, threads, v]),
  ];
}

async function planSession({ op, row }, version, lookup) {
  const v = String(version);
  if (op === 'delete') return [sql('DELETE FROM kb.g_sessions WHERE id=$1::text AND version<=$2::bigint', [row.id, v])];
  const owner = (await lookup.channelsOfThreads(row.workspace_id, [row.origin_thread_id])).get(row.origin_thread_id);
  if (!owner || owner.kind !== 'channel') return [];
  return [
    channelStub(owner.channel, row.workspace_id),
    threadStub(row.origin_thread_id, owner.channel, row.workspace_id),
    sql(`INSERT INTO kb.g_sessions(id,workspace_id,thread_id,title,state,version) VALUES($1::text,$2::uuid,$3::text,$4,$5,$6::bigint)
         ON CONFLICT (id) DO UPDATE SET thread_id=EXCLUDED.thread_id,title=EXCLUDED.title,state=EXCLUDED.state,version=EXCLUDED.version
         WHERE kb.g_sessions.version<EXCLUDED.version`,
      [row.id, row.workspace_id, row.origin_thread_id, row.title, row.state, v]),
  ];
}

export async function planChange(change, version, lookup) {
  if (change.table === 'channels') return planChannel(change, version);
  if (change.table === 'knowledge_notes') return planKnowledge(change, version, lookup);
  if (change.table === 'agent_sessions') return planSession(change, version, lookup);
  return [];
}
