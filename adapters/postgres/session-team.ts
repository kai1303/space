import { readChannelPermissions } from './channel-permissions.js';
import { visibleWorkspacePeer } from './workspace-access.js';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import { AppError, documentMentions, parseRichDocument, record, text, uuid, type SessionMentionOption, type RichDocument, type AgentSessionOutputs, type SessionTeamView, type SharedSessionOutput, type SessionDiscussionMessage } from '@space/contracts';
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
function discussionCursor(query:unknown) {
  const {before} = record(query,['before']);
  if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,17}$/.test(before))) throw new AppError(400,'invalid_cursor');
  return before;
}
async function discussionPage(c:DbSession,id:string,before:string|undefined) {
  const {rows} = await c.execute<SessionDiscussionMessage & Record<string,unknown>>(sql`SELECT d.sequence::text,d.actor_id AS author_id,u.display_name AS author,d.body,d.document,d.created_at
        FROM session_discussion_messages d JOIN users u ON u.id=d.actor_id WHERE d.session_id=${id}
        ${before ? sql`AND d.sequence < ${before}::bigint` : sql``} ORDER BY d.sequence DESC LIMIT 51`);
  const messages = rows.slice(0,50).reverse().map(row => ({...row, created_at: new Date(row.created_at).toISOString()}));
  return {messages,before:rows.length>50?messages[0]!.sequence:null};
}
export class SessionTeamStore {
  constructor(readonly db:Database) {}
  read(actor:string,id:string,query:unknown):Promise<SessionTeamView> {
    const before=discussionCursor(query);
    return this.db.transaction(async c => {
      const team = await access(c,actor,id);
      const {rows:reviewers} = await c.execute<{user_id:string;display_name:string}>(sql`SELECT r.user_id,u.display_name FROM session_reviewers r JOIN users u ON u.id=r.user_id WHERE r.session_id=${id} ORDER BY u.display_name,r.user_id LIMIT 32`);
      const {rows:shared} = await c.execute<SharedSessionOutput>(sql`SELECT kind,path,output FROM session_shared_outputs WHERE session_id=${id} ORDER BY kind,path LIMIT 49`);
      return {...team,viewer_id:actor,shared,reviewers,...await discussionPage(c,id,before)};
    },{isolationLevel:'repeatable read',accessMode:'read only'});
  }
  discussion(actor:string,id:string,query:unknown) {
    const before=discussionCursor(query);
    return this.db.transaction(async c=>{
      const team=await access(c,actor,id);
      return {...await discussionPage(c,id,before),writable:team.writable};
    },{isolationLevel:'repeatable read',accessMode:'read only'});
  }
  mentionOptions(actor:string,id:string,query:unknown) {
    const {q='',ids} = record(query,['q','ids']);
    if (ids!==undefined && (typeof ids!=='string' || ids.length>1850)) throw new AppError(400,'invalid_mention');
    const targets=typeof ids==='string'?ids.split(',').map(uuid):null;
    if (targets && targets.length>50) throw new AppError(400,'too_many_mentions');
    if (typeof q!=='string' || q.length>100) throw new AppError(400,'invalid_query');
    return this.db.transaction(async c=>{
      const team=await access(c,actor,id);
      // Only the source conversation can look up workspace peers. Review-room readers
      // must not be able to infer the source channel or its membership.
      const {rows:[source]}=await c.execute<{id:string;name:string;kind:string}>(sql`SELECT ch.id,ch.name,ch.kind
        FROM agent_sessions a JOIN threads t ON t.id=a.origin_thread_id JOIN channels ch ON ch.id=t.channel_id
        JOIN channel_members cm ON cm.channel_id=ch.id AND cm.user_id=${actor} WHERE a.id=${id}`);
      if (!source) throw new AppError(404,'not_found');
      const canAdd=team.writable && source.kind==='channel' && (await readChannelPermissions(c,actor,source.id)).capabilities.invite;
      const {rows:items}=await c.execute<SessionMentionOption>(sql`SELECT 'user' AS kind,u.id,
        trim(regexp_replace(u.display_name,'[[:cntrl:]]',' ','g')) AS label,u.title AS detail,u.image,
        (cm.user_id IS NOT NULL OR r.user_id IS NOT NULL OR (${team.workspace_visible} AND wm.guest_type='none')) AS joined,
        (${team.can_manage && team.writable} AND wm.guest_type='none' AND r.user_id IS NULL AND cm.user_id IS NULL AND NOT ${team.workspace_visible}) AS can_invite_reviewer,
        CASE WHEN ${canAdd} AND cm.user_id IS NULL AND wm.guest_type='none' AND r.user_id IS NULL AND NOT ${team.workspace_visible} THEN ${source.name}::text END AS invite_channel
        FROM workspace_members wm JOIN users u ON u.id=wm.user_id
        LEFT JOIN channel_members cm ON cm.channel_id=${source.id} AND cm.user_id=u.id
        LEFT JOIN session_reviewers r ON r.session_id=${id} AND r.user_id=u.id
        WHERE wm.workspace_id=${team.workspace_id} AND wm.active AND ${visibleWorkspacePeer(team.workspace_id,actor,sql`u.id`)}
          AND (${sql.param(targets)}::uuid[] IS NULL OR u.id=ANY(${sql.param(targets)}::uuid[]))
          AND (wm.guest_type='none' OR cm.user_id IS NOT NULL)
          AND position(lower(${q}) IN lower(u.display_name||' '||u.full_name))>0
        ORDER BY joined DESC,lower(u.display_name),u.id LIMIT ${targets?50:30}`);
      return {items,member_count:items.length};
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
    const input=record(body,['text','document']);
    const message=text(input.text);
    const document=input.document===undefined?null:parseRichDocument(input.document);
    if (document && (document.ops.map(op=>op.insert).join('').trim()!==message.trim() ||
        document.ops.some(op=>op.attributes && (Object.keys(op.attributes).some(k=>k!=='mention') || op.attributes.mention?.kind!=='user')))) {
      throw new AppError(400,'invalid_document');
    }
    const refs=document?documentMentions(document):[];
    if (refs.length>50) throw new AppError(400,'too_many_mentions');
    return sessionTransaction(this.db,async c=>{
      const team = await access(c,actor,id);
      const {rows:[prior]} = await c.execute<{body:string;document:RichDocument|null}>(sql`SELECT body,document FROM session_discussion_messages WHERE session_id=${id} AND actor_id=${actor} AND client_id=${uuid(key)}`);
      if (prior) {
        if (prior.body!==message || !isDeepStrictEqual(prior.document,document)) throw new AppError(409,'idempotency_conflict');
        return;
      }
      writable(team);
      if (refs.length) {
        const {rows}=await c.execute<{id:string;label:string}>(sql`SELECT u.id,trim(regexp_replace(u.display_name,'[[:cntrl:]]',' ','g')) AS label
          FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=${team.workspace_id} AND wm.active
          AND u.id=ANY(${sql.param(refs.map(ref=>ref.id))}::uuid[]) AND ${visibleWorkspacePeer(team.workspace_id,actor,sql`u.id`)}`);
        const names=new Map(rows.map(row=>[row.id,row.label]));
        if (document!.ops.some(op=>op.attributes?.mention && names.get(op.attributes.mention.id)!==op.attributes.mention.label)) throw new AppError(400,'invalid_mention');
      }
      await c.execute(sql`INSERT INTO session_discussion_messages(session_id,actor_id,client_id,body,document)
        VALUES(${id},${actor},${key},${message},${document?JSON.stringify(document):null}::jsonb)`);
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
