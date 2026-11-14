import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import { AppError, record, text, uuid, type AgentSessionOutputs, type SessionTeamView, type SharedSessionOutput, type SessionDiscussionMessage } from '@space/contracts';
import type { Database, DbSession } from './database.js';
import { sessionTransaction } from './session-concurrency.js';

type Access = Pick<SessionTeamView,'workspace_id'|'title'|'can_manage'|'writable'|'workspace_visible'>;
async function access(c:DbSession, actor:string, id:string) {
  const {rows:[team]} = await c.execute<Access>(sql`SELECT * FROM session_team_access(${uuid(id)},${uuid(actor)})`);
  if (!team) throw new AppError(404,'not_found');
  return team;
}
const writable = (team:Access) => { if (!team.writable) throw new AppError(409,'session_read_only'); };
const manager = (team:Access) => { if (!team.can_manage) throw new AppError(403,'session_manager_required'); };
const outputPath = (kind:unknown, path:unknown) => {
  if (kind === 'preview' && path === '') return '';
  if (kind === 'view') return text(path,128);
  if (kind === 'file' || kind === 'change') return text(path,300);
  throw new AppError(400,'invalid_shared_output');
};
export class SessionTeamStore {
  constructor(readonly db:Database) {}
  read(actor:string,id:string,query:unknown):Promise<SessionTeamView> {
    const {before} = record(query,['before']);
    if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,17}$/.test(before))) throw new AppError(400,'invalid_cursor');
    return this.db.transaction(async c => {
      const team = await access(c,actor,id);
      const {rows:reviewers} = await c.execute<{user_id:string;display_name:string}>(sql`SELECT r.user_id,u.display_name FROM session_reviewers r JOIN users u ON u.id=r.user_id WHERE r.session_id=${id} ORDER BY u.display_name,r.user_id LIMIT 32`);
      const {rows:shared} = await c.execute<SharedSessionOutput>(sql`SELECT kind,path,output FROM session_shared_outputs WHERE session_id=${id} ORDER BY kind,path LIMIT 49`);
      const {rows} = await c.execute<SessionDiscussionMessage & Record<string,unknown>>(sql`SELECT d.sequence::text,u.display_name AS author,d.body,d.created_at::text
        FROM session_discussion_messages d JOIN users u ON u.id=d.actor_id WHERE d.session_id=${id}
        ${before ? sql`AND d.sequence < ${before}::bigint` : sql``} ORDER BY d.sequence DESC LIMIT 51`);
      const messages = rows.slice(0,50).reverse();
      return {...team,viewer_id:actor,shared,reviewers,messages,before:rows.length>50?messages[0]!.sequence:null};
    },{isolationLevel:'repeatable read',accessMode:'read only'});
  }
  invite(actor:string,id:string,userId:string) {
    return sessionTransaction(this.db,async c => {
      const team=await access(c,actor,id); manager(team); writable(team);
      const user=uuid(userId);
      if (!(await c.execute(sql`SELECT 1 FROM workspace_members WHERE workspace_id=${team.workspace_id} AND user_id=${user} AND active AND guest_type='none'`)).rows.length) throw new AppError(404,'not_found');
      const {rows} = await c.execute<{user_id:string}>(sql`SELECT user_id FROM session_reviewers WHERE session_id=${id} LIMIT 32`);
      if (rows.some(row=>row.user_id===user)) return;
      if (rows.length>=32) throw new AppError(409,'session_reviewer_limit');
      await c.execute(sql`INSERT INTO session_reviewers(workspace_id,session_id,user_id) VALUES(${team.workspace_id},${id},${user}) ON CONFLICT DO NOTHING`);
    });
  }
  visibility(actor:string,id:string,input:unknown) {
    const {workspace_visible} = record(input,['workspace_visible']);
    if (typeof workspace_visible!=='boolean') throw new AppError(400,'invalid_visibility');
    return sessionTransaction(this.db,async c=>{
      const team=await access(c,actor,id); manager(team);
      if (workspace_visible) {
        writable(team);
        await c.execute(sql`INSERT INTO session_team_visibility(workspace_id,session_id) VALUES(${team.workspace_id},${id}) ON CONFLICT DO NOTHING`);
      } else await c.execute(sql`DELETE FROM session_team_visibility WHERE session_id=${id}`);
    });
  }
  remove(actor:string,id:string,userId:string) {
    return sessionTransaction(this.db,async c => {
      const team = await access(c,actor,id); if (uuid(userId)!==actor) manager(team);
      await c.execute(sql`DELETE FROM session_reviewers WHERE session_id=${id} AND user_id=${userId}`);
    });
  }
  post(actor:string,id:string,key:string,body:unknown) {
    const message = text(record(body,['text']).text);
    return sessionTransaction(this.db,async c=>{
      const team = await access(c,actor,id);
      const {rows:[prior]} = await c.execute<{body:string}>(sql`SELECT body FROM session_discussion_messages WHERE session_id=${id} AND actor_id=${actor} AND client_id=${uuid(key)}`);
      if (prior) {
        if (prior.body!==message) throw new AppError(409,'idempotency_conflict');
        return;
      }
      writable(team);
      await c.execute(sql`INSERT INTO session_discussion_messages(session_id,actor_id,client_id,body) VALUES(${id},${actor},${key},${message})`);
    });
  }
  share(actor:string,id:string,input:unknown) {
    const {kind,path,output} = record(input,['kind','path','output']);
    const name = outputPath(kind,path);
    return sessionTransaction(this.db,async c=>{
      const team=await access(c,actor,id); manager(team);
      if (output===null) {
        await c.execute(sql`DELETE FROM session_shared_outputs WHERE session_id=${id} AND kind=${kind} AND path=${name}`);
        return;
      }
      writable(team);
      const {rows:[session]}=await c.execute<{outputs:AgentSessionOutputs}>(sql`SELECT outputs FROM agent_sessions WHERE id=${id}`);
      const available=session!.outputs;
      let selected: SharedSessionOutput['output'] | undefined;
      switch (kind) {
        case 'view': selected = available.views?.find(view => view.key === name); break;
        case 'file': selected = available.files.find(file => file.path === name); break;
        case 'change': selected = available.changes.find(change => change.path === name); break;
        case 'preview': selected = available.preview; break;
      }
      if (!selected || !isDeepStrictEqual(selected,output)) throw new AppError(409,'session_output_changed');
      const {rows:[count]}=await c.execute<{total:number;exists:boolean}>(sql`SELECT count(*)::int AS total,coalesce(bool_or(kind=${kind} AND path=${name}),false) AS exists FROM session_shared_outputs WHERE session_id=${id}`);
      if (!count!.exists && count!.total>=49) throw new AppError(409,'session_shared_output_limit');
      await c.execute(sql`INSERT INTO session_shared_outputs(session_id,kind,path,output) VALUES(${id},${kind},${name},${JSON.stringify(selected)}::jsonb)
        ON CONFLICT(session_id,kind,path) DO UPDATE SET output=excluded.output WHERE session_shared_outputs.output IS DISTINCT FROM excluded.output`);
    });
  }
}
