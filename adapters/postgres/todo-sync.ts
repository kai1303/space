import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AppError, parsePage, parseTodoSync, record, text, uuid } from '@space/contracts';
import { database } from './database.js';
import { page } from './membership.js';
import { requireWorkspaceAccess } from './access.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const membership = (actor: string, workspace: string) => sql`EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=${workspace} AND m.user_id=${actor} AND m.active)`;
const authorized = (source: string, digest: string) => sql`s.id=${source} AND s.token_hash=${digest} AND s.expires_at>now()
  AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=s.workspace_id AND m.user_id=s.user_id AND m.active)`;
const sourceColumns = sql`id,name,created_at,expires_at,(token_hash IS NULL) AS revoked`;
type Receipt = {id: string; external_id: string; revision: string} & Record<string, unknown>;
const receiptColumns = sql`t.id,t.external_id,t.external_revision::text AS revision`;

export class TodoSyncStore {
  readonly db;
  constructor(readonly pool: Pool) { this.db = database(pool); }

  async sources(actor: string, workspace: string, input: unknown) {
    actor=uuid(actor);workspace=uuid(workspace);
    const {after,limit}=parsePage(record(input,['after','limit']));
    return this.db.transaction(async c=>{
      await requireWorkspaceAccess(c,actor,workspace);
      const rows=await c.execute<{id:string}&Record<string,unknown>>(sql`SELECT ${sourceColumns} FROM todo_sync_sources WHERE workspace_id=${workspace} AND user_id=${actor}
        AND ${membership(actor,workspace)} ${after?sql`AND id>${after}::uuid`:sql``} ORDER BY id LIMIT ${limit+1}`);
      return page(rows.rows,limit,row=>row.id);
    });
  }

  async credentials(actor: string, workspace: string, id: string, action: 'create'|'rotate'|'revoke', input: unknown) {
    actor=uuid(actor);workspace=uuid(workspace);id=uuid(id);
    const body=record(input,action==='create'?['name']:[]);
    const name=action==='create'?text(body.name,80).trim():undefined;
    const token=action==='revoke'?undefined:`sp_todo_${randomBytes(32).toString('base64url')}`;
    return this.db.transaction(async c=>{
      await requireWorkspaceAccess(c,actor,workspace);
      const rows=action==='create'
        ? await c.execute(sql`INSERT INTO todo_sync_sources(id,workspace_id,user_id,name,token_hash,expires_at)
            SELECT ${id},${workspace},${actor},${name},${hash(token!)},now()+interval '90 days' WHERE ${membership(actor,workspace)}
            ON CONFLICT(id) DO NOTHING RETURNING ${sourceColumns}`)
        : await c.execute(sql`UPDATE todo_sync_sources SET token_hash=${token?hash(token):null},expires_at=now()+interval '90 days'
            WHERE id=${id} AND workspace_id=${workspace} AND user_id=${actor} AND ${membership(actor,workspace)} RETURNING ${sourceColumns}`);
      if(!rows.rows[0])throw new AppError(action==='create'?409:404,action==='create'?'source_conflict':'not_found');
      return {...rows.rows[0],...(token?{token}:{})};
    });
  }

  private credential(source: string, token: unknown) {
    if(typeof token!=='string'||!/^sp_todo_[A-Za-z0-9_-]{43}$/.test(token))throw new AppError(401,'unauthorized');
    return {source:uuid(source),digest:hash(token)};
  }

  async receipts(sourceId: string, token: unknown, input: unknown) {
    const {source,digest}=this.credential(sourceId,token);
    const {after,limit}=parsePage(record(input,['after','limit']));
    return this.db.transaction(async c=>{
      const access=await c.execute(sql`SELECT 1 FROM todo_sync_sources s WHERE ${authorized(source,digest)}`);
      if(!access.rows.length)throw new AppError(401,'unauthorized');
      // Return identifiers only: a one-way importer must not read later personal edits.
      const rows=await c.execute<Receipt>(sql`SELECT ${receiptColumns} FROM hub_todos t JOIN todo_sync_sources s ON s.id=t.external_source_id
        WHERE ${authorized(source,digest)} ${after?sql`AND t.id>${after}::uuid`:sql``} ORDER BY t.id LIMIT ${limit+1}`);
      return page(rows.rows,limit,row=>row.id);
    });
  }

  async sync(sourceId: string, token: unknown, input: unknown) {
    const {source,digest}=this.credential(sourceId,token), body=parseTodoSync(input);
    const fingerprint=hash(JSON.stringify(body));
    return this.db.transaction(async c=>{
      const rows=await c.execute<Receipt>(sql`INSERT INTO hub_todos AS t(id,workspace_id,user_id,title,completed,document,external_source_id,external_id,external_revision,external_hash,external_url)
        SELECT ${randomUUID()},s.workspace_id,s.user_id,${body.title},${body.completed},${body.document?JSON.stringify(body.document):null}::jsonb,s.id,${body.external_id},${body.revision}::bigint,${fingerprint},${body.url}
        FROM todo_sync_sources s WHERE ${authorized(source,digest)}
        ON CONFLICT(external_source_id,external_id) DO UPDATE SET title=excluded.title,completed=excluded.completed,document=excluded.document,
          external_revision=excluded.external_revision,external_hash=excluded.external_hash,external_url=excluded.external_url,
          updated_at=greatest(clock_timestamp(),t.updated_at+interval '1 microsecond')
        WHERE t.external_revision<excluded.external_revision AND EXISTS(SELECT 1 FROM todo_sync_sources s WHERE ${authorized(source,digest)})
        RETURNING ${receiptColumns}`);
      if(rows.rows[0])return {...rows.rows[0],result:'applied' as const};
      const access=await c.execute(sql`SELECT 1 FROM todo_sync_sources s WHERE ${authorized(source,digest)}`);
      if(!access.rows.length)throw new AppError(401,'unauthorized');
      const existing=await c.execute<Receipt & {external_hash:string}>(sql`SELECT ${receiptColumns},t.external_hash FROM hub_todos t JOIN todo_sync_sources s ON s.id=t.external_source_id
        WHERE ${authorized(source,digest)} AND t.external_id=${body.external_id}`);
      const current=existing.rows[0];
      if(!current)throw new AppError(401,'unauthorized');
      if(current.revision===body.revision&&current.external_hash!==fingerprint)throw new AppError(409,'source_revision_conflict');
      const {external_hash,...receipt}=current;
      return {...receipt,result:current.revision===body.revision?'unchanged' as const:'stale' as const};
    });
  }
}
