import { sql } from 'drizzle-orm';
import { AppError, shellCommand, shellExecution, type AgentTool } from '@space/contracts';
import type { DbSession } from './database.js';

// Old connectors emitted rolling snapshots. A call can disappear from the final
// snapshot, and its input and output can be clipped in different snapshots.
export async function legacySessionTools(db: DbSession, taskId: string, execution: string, position: number, after: number) {
  const history = sql`WITH appearances AS (
    SELECT e.sequence, tool, ordinal FROM task_events e
    CROSS JOIN LATERAL jsonb_array_elements(e.payload#>'{response,tools}') WITH ORDINALITY AS call(tool,ordinal)
    WHERE e.correlation_id=${taskId} AND e.resource_id=${execution} AND e.type LIKE 'execution.%'
  ), first_seen AS (
    SELECT DISTINCT ON (tool->>'id') tool->>'id' AS id, sequence, ordinal FROM appearances
    ORDER BY tool->>'id', sequence, ordinal
  ), ordered AS (
    SELECT id,(row_number() OVER (ORDER BY sequence,ordinal)-1)::integer AS position FROM first_seen
  )`;
  if (position < 0) {
    const page = await db.execute<{position:number; id:string; name:string; kind:'tool'; status:string;args:string; info:unknown}>(sql`${history}
      SELECT o.*, 'tool' AS kind, last.tool->>'name' AS name, last.tool->>'status' AS status, last.tool->'shell' AS info,
        (SELECT tool->>'arguments' FROM appearances WHERE tool->>'id'=o.id ORDER BY length(tool->>'arguments') DESC NULLS LAST,sequence DESC LIMIT 1) AS args
      FROM (SELECT * FROM ordered ${after < 0 ? sql`` : sql`WHERE position < ${after}`} ORDER BY position DESC LIMIT 33) o
      JOIN LATERAL (SELECT tool FROM appearances WHERE tool->>'id'=o.id ORDER BY sequence DESC LIMIT 1) last ON true
      ORDER BY position DESC`);
    return {items:page.rows.slice(0,32).map(({args,info,...item})=>item.name==='shell' ? {...item,shell:{...shellExecution({command:shellCommand(args ?? '')}),...shellExecution(info)}} : item),next:page.rows.length>32?page.rows[31]!.position:null};
  }
  if (after >= 0) throw new AppError(404,'not_found');
  const result = await db.execute<{tool:AgentTool}>(sql`${history}
    SELECT (array_agg(tool ORDER BY sequence DESC))[1] ||
      jsonb_strip_nulls(jsonb_build_object(
        'arguments',(array_agg(tool->>'arguments' ORDER BY length(tool->>'arguments') DESC NULLS LAST, sequence DESC))[1],
        'result',(array_agg(tool->>'result' ORDER BY length(tool->>'result') DESC NULLS LAST, sequence DESC))[1]
      )) AS tool
    FROM appearances JOIN ordered ON ordered.id=tool->>'id' WHERE ordered.position=${position} GROUP BY ordered.id`);
  if (!result.rows[0]) throw new AppError(404,'not_found');
  return {chunks:[{part:0,last:true,data:JSON.stringify(result.rows[0].tool)}]};
}
