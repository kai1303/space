import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { AgentTool } from '@space/contracts';
import type { Database, DbSession } from './database.js';

type TurnStatus = {
  dispatch: 'direct' | 'queued';
  execution: 'started';
  approval: 'proposed' | 'approved' | 'rejected' | 'requested' | 'allowed' | 'denied';
  outcome: 'completed' | 'failed' | 'stopped' | 'rejected';
  memory: `${'session' | 'thread'}:${'saved' | 'pending' | 'skipped'}`;
};

const pending = new WeakMap<DbSession, string[]>();
const maxRecordsPerTransaction = 256;
const taskId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function traceTurn<P extends keyof TurnStatus>(session: DbSession, traceId: string, phase: P, status: TurnStatus[P]) {
  const records = pending.get(session);
  if (records && records.length < maxRecordsPerTransaction && taskId.test(traceId)) {
    records.push(JSON.stringify({msg: 'agent_turn_phase', traceId, phase, status}));
  }
}

export function traceTool(session: DbSession, traceId: string, id: string, status: AgentTool['status']) {
  const records = pending.get(session);
  if (!records || records.length >= maxRecordsPerTransaction || !taskId.test(traceId)) return;
  const toolId = createHash('sha256').update(traceId + ':' + id).digest('hex').slice(0, 32);
  records.push(JSON.stringify({msg: 'agent_turn_phase', traceId, phase: 'tool', status, toolId}));
}

export async function traceToolChanges(session: DbSession, traceId: string, tools?: AgentTool[]) {
  if (!tools?.length || !pending.has(session)) return;
  // Compare with the last accepted snapshot even after a process restart or connector handoff.
  const previous = await session.execute<{id: string; status: string}>(sql`
    SELECT tool->>'id' AS id, tool->>'status' AS status
    FROM (SELECT payload->'response'->'tools' AS tools FROM task_events
          WHERE correlation_id=${traceId} AND payload ? 'response' ORDER BY sequence DESC LIMIT 1) snapshot,
         LATERAL jsonb_array_elements(snapshot.tools) tool`);
  const statuses = new Map(previous.rows.map(tool => [tool.id, tool.status]));
  for (const tool of tools) {
    if (statuses.get(tool.id) !== tool.status) traceTool(session, traceId, tool.id, tool.status);
  }
}

export async function commitWithTurnTrace<T>(db: Database, work: (c: DbSession) => Promise<T>, isolationLevel: 'serializable' | 'read committed') {
  if (process.env.SPACE_MONITORING_ENABLED !== 'true') return db.transaction(work, {isolationLevel});
  const records: string[] = [];
  const result = await db.transaction(async c => {
    pending.set(c, records);
    try { return await work(c); }
    finally { pending.delete(c); }
  }, {isolationLevel});
  // Failed commits and serialization retries never produce successful phase records.
  try {
    for (const line of records) {
      if (process.stdout.writableNeedDrain) break;
      console.info(line);
    }
  } catch { /* Telemetry cannot change a committed result. */ }
  return result;
}
