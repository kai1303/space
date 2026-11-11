import { readChannelPermissions } from './channel-permissions.js';
import { visibleWorkspacePeer } from './workspace-access.js';
import { sessionTransaction } from './session-concurrency.js';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AppError, chatCursor, documentMentions, mentionOperations, parseMention, parseRichDocument, record, uuid, type MentionActivity, type MentionOption, type MentionReference, type MentionSettings, type RichDocument } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess, requireWorkspaceAccess } from './access.js';
type Channel = { kind?: 'channel' | 'direct'; id: string; workspace_id: string; private: boolean; created_by: string | null };
async function rows<T>(c: DbSession, query: Parameters<DbSession['execute']>[0]): Promise<T[]> { return (await c.execute(query)).rows as T[]; }
const missing = () => new AppError(404, 'not_found');
const notificationScope = (actor: string, workspace: string) => sql`n.user_id=${actor} AND n.workspace_id=${workspace}
  AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=n.workspace_id AND wm.user_id=${actor} AND wm.active
    AND ((NOT ch.private AND wm.guest_type='none') OR EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=ch.id AND cm.user_id=${actor})))`;
export class MentionStore {
  readonly db;
  constructor(pool: Pool) { this.db = database(pool); }
  private async channel(c: DbSession, actor: string, id: string) {
    const [channel] = await rows<Channel>(c, sql`SELECT id,workspace_id,private,created_by,kind FROM channels WHERE id=${uuid(id)}`);
    if (!channel || !await hasChannelAccess(c, actor, channel.workspace_id, id)) throw missing();
    return channel;
  }
  private async options(c: DbSession, actor: string, channel: Channel, query: string, target?: MentionReference): Promise<MentionOption[]> {
    const people = await rows<MentionOption>(c, sql`SELECT 'user' AS kind,u.id,u.display_name AS label,u.title AS detail,u.image,
      EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=${channel.id} AND cm.user_id=u.id) AS joined
      FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=${channel.workspace_id} AND wm.active
      WHERE (${target?.id ?? null}::uuid IS NULL OR u.id=${target?.kind === 'user' ? target.id : null}::uuid)
      AND ${visibleWorkspacePeer(channel.workspace_id,actor,sql`u.id`)}
      AND (${channel.kind === 'direct'}=false OR EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=${channel.id} AND cm.user_id=u.id))
      AND (${target?.kind === 'agent'}=false) AND position(lower(${query}) IN lower(u.display_name||' '||u.full_name))>0
      ORDER BY lower(u.display_name),u.id LIMIT 30`);
    const agents = await rows<MentionOption>(c, sql`SELECT DISTINCT 'agent' AS kind,i.id,coalesce(ac.name,d.name) AS label,'Agent' AS detail,NULL::text AS image,true AS joined
      FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id
      LEFT JOIN agent_connections ac ON ac.installation_id=i.id
      JOIN workspace_members owner ON owner.workspace_id=i.workspace_id AND owner.user_id=i.owner_id AND owner.active
      JOIN channel_members cm ON cm.channel_id=${channel.id} AND cm.user_id=i.owner_id
      WHERE i.workspace_id=${channel.workspace_id} AND i.enabled AND ac.revoked_at IS NULL
      AND (ac.installation_id IS NOT NULL OR EXISTS(SELECT 1 FROM agent_grants g WHERE g.installation_id=i.id AND g.channel_id=${channel.id} AND g.workspace_id=i.workspace_id AND d.capabilities->'skills' ? g.skill))
      AND (${target?.id ?? null}::uuid IS NULL OR i.id=${target?.kind === 'agent' ? target.id : null}::uuid)
      AND (${target?.kind === 'user'}=false) AND position(lower(${query}) IN lower(coalesce(ac.name,d.name)))>0 ORDER BY label,i.id LIMIT 30`);
    return [...people,...agents].map(option=>({...option,label:option.label.replace(/[\r\n\t]/g,' ').trim()}));
  }
  async settings(actor: string, workspace: string): Promise<MentionSettings> {
    await requireWorkspaceAccess(this.db,actor,uuid(workspace));
    const [settings] = await rows<MentionSettings>(this.db, sql`SELECT p.paused_until,coalesce(s.broadcast_permission,'all') AS broadcast_permission,
      wm.role IN ('owner','admin') AS can_manage,s.general_channel_id,
      (SELECT count(*)::int FROM workspace_members WHERE workspace_id=wm.workspace_id AND active) AS member_count
      FROM workspace_members wm LEFT JOIN workspace_mention_settings s ON s.workspace_id=wm.workspace_id
      LEFT JOIN mention_preferences p ON p.user_id=wm.user_id WHERE wm.workspace_id=${workspace} AND wm.user_id=${actor} AND wm.active`);
    if(!settings)throw missing();return settings;
  }
  async updateSettings(actor: string, workspace: string, input: unknown) {
    const v=record(input,['paused_until','broadcast_permission']);
    if(!Object.keys(v).length)throw new AppError(400,'empty_update');
    if('paused_until' in v && v.paused_until!==null && (typeof v.paused_until!=='string'||!Number.isFinite(Date.parse(v.paused_until))||Date.parse(v.paused_until)<=Date.now()||Date.parse(v.paused_until)>Date.now()+7*86400000))throw new AppError(400,'invalid_pause');
    if('broadcast_permission' in v && !['all','admins'].includes(String(v.broadcast_permission)))throw new AppError(400,'invalid_permission');
    await this.db.transaction(async c=>{
      await c.execute(sql`SELECT id FROM workspaces WHERE id=${uuid(workspace)} FOR UPDATE`);
      await requireWorkspaceAccess(c,actor,workspace);
      if('broadcast_permission' in v){
        const [member]=await rows<{role:string}>(c,sql`SELECT role FROM workspace_members WHERE workspace_id=${workspace} AND user_id=${actor} AND active`);
        if(member?.role!=='owner'&&member?.role!=='admin')throw new AppError(403,'mention_settings_forbidden');
        await c.execute(sql`INSERT INTO workspace_mention_settings(workspace_id,broadcast_permission) VALUES(${workspace},${v.broadcast_permission}) ON CONFLICT(workspace_id) DO UPDATE SET broadcast_permission=EXCLUDED.broadcast_permission`);
      }
      if('paused_until' in v)await c.execute(sql`INSERT INTO mention_preferences(user_id,paused_until) VALUES(${actor},${v.paused_until}::timestamptz) ON CONFLICT(user_id) DO UPDATE SET paused_until=EXCLUDED.paused_until`);
    });
    return this.settings(actor,workspace);
  }
  async search(actor: string, channelId: string, input: unknown={}) {
    const v=record(input,['q']);const query=v.q===undefined?'':typeof v.q==='string'&&v.q.length<=100?v.q.trim().replace(/^@/,''):null;
    if(query===null)throw new AppError(400,'invalid_query');
    return this.db.transaction(async c=>{
      const channel=await this.channel(c,actor,channelId);
      const options=(await this.options(c,actor,channel,query)).filter(item=>item.kind!=='user'||!channel.private||item.joined);
      const [scope]=await rows<{general_channel_id:string|null;allowed:boolean;full_member:boolean;member_count:number}>(c,sql`SELECT s.general_channel_id,wm.guest_type='none' AS full_member,(coalesce(s.broadcast_permission,'all')='all' OR wm.role IN ('owner','admin')) AS allowed,
        (SELECT count(*)::int FROM channel_members cm JOIN workspace_members m ON m.workspace_id=cm.workspace_id AND m.user_id=cm.user_id AND m.active WHERE cm.channel_id=${channelId}) AS member_count
        FROM workspace_members wm LEFT JOIN workspace_mention_settings s ON s.workspace_id=wm.workspace_id WHERE wm.user_id=${actor} AND wm.workspace_id=${channel.workspace_id} AND wm.active`);
      const broadcastAllowed=channel.kind==='direct'?scope?.allowed:(await readChannelPermissions(c,actor,channelId)).capabilities.broadcast;
      if(scope&&broadcastAllowed)for(const id of ['here','channel',...(scope.full_member&&scope.general_channel_id===channelId?['everyone']:[])])if(id.includes(query.toLowerCase()))options.push({kind:'broadcast',id,label:id,detail:id==='here'?'Notify active channel members':`Notify channel members (${scope.member_count})`,joined:true});
      return {items:options.slice(0,63),member_count:scope?.member_count??0};
    });
  }
  async detail(actor:string,channelId:string,kind:string,id:string){
    if(kind!=='user'&&kind!=='agent')throw missing();
    return this.db.transaction(async c=>{
      const channel=await this.channel(c,actor,channelId);
      const [option]=await this.options(c,actor,channel,'',{kind,id:uuid(id),label:'lookup'});
      if(!option)throw missing();
      if(kind==='user'){
        const [profile]=await rows<{full_name:string;title:string;presence:string;status:unknown}>(c,sql`SELECT full_name,title,presence,CASE WHEN (status->>'expires_at') IS NULL OR (status->>'expires_at')::timestamptz>now() THEN status ELSE NULL END AS status FROM users WHERE id=${id}`);
        return {...option,...profile};
      }
      return option;
    });
  }
  async prepare(c:DbSession,actor:string,channel:Channel,document:RichDocument|undefined,inThread:boolean,confirmed:boolean){
    const refs=document?documentMentions(document):[];
    if(refs.length>50)throw new AppError(400,'too_many_mentions');
    const canonical=new Map<string,MentionReference>();
    for(const ref of refs){
      if(ref.kind==='broadcast'){
        const [scope]=await rows<{allowed:boolean;full_member:boolean;general_channel_id:string|null;members:number}>(c,sql`SELECT (coalesce(s.broadcast_permission,'all')='all' OR wm.role IN ('owner','admin')) AS allowed,wm.guest_type='none' AS full_member,s.general_channel_id,
          (SELECT count(*)::int FROM channel_members cm JOIN workspace_members m ON m.workspace_id=cm.workspace_id AND m.user_id=cm.user_id AND m.active WHERE cm.channel_id=${channel.id}) AS members
          FROM workspace_members wm LEFT JOIN workspace_mention_settings s ON s.workspace_id=wm.workspace_id WHERE wm.user_id=${actor} AND wm.workspace_id=${channel.workspace_id} AND wm.active`);
        if(!scope?.allowed||(ref.id==='everyone'&&!scope.full_member))throw new AppError(403,'broadcast_forbidden');
        if(ref.id==='everyone'&&scope.general_channel_id!==channel.id)throw new AppError(400,'invalid_broadcast_channel');
        if(!inThread&&scope.members>=6&&!confirmed)throw new AppError(409,'broadcast_confirmation_required');
        canonical.set(`${ref.kind}:${ref.id}`,ref);
      }else{
        const [option]=await this.options(c,actor,channel,'',ref);
        if(!option)throw missing();
        canonical.set(`${ref.kind}:${ref.id}`,{kind:option.kind,id:option.id,label:option.label});
      }
    }
    const activeOps = new Set(document ? mentionOperations(document).map(item=>item.index) : []);
    const safe=document?parseRichDocument({ops:document.ops.map((op,index)=>{const ref=op.attributes?.mention, replacement=ref&&activeOps.has(index)&&canonical.get(`${ref.kind}:${ref.id}`);return replacement?{...op,insert:`@${replacement.label}`,attributes:{...op.attributes,mention:replacement}}:op;})}):undefined;
    return {document:safe,refs:[...canonical.values()]};
  }
  async notify(c:DbSession,actor:string,channel:Channel,messageId:string,refs:MentionReference[],inThread:boolean){
    const users=refs.filter(ref=>ref.kind==='user').map(ref=>ref.id);
    const all=!inThread&&refs.some(ref=>ref.kind==='broadcast'&&(ref.id==='channel'||ref.id==='everyone'));
    const active=!inThread&&refs.some(ref=>ref.kind==='broadcast'&&ref.id==='here');
    if(!users.length&&!all&&!active)return;
    await c.execute(sql`INSERT INTO mention_notifications(workspace_id,channel_id,message_id,user_id,silent)
      SELECT ${channel.workspace_id},${channel.id},${messageId},u.id,coalesce(p.paused_until>now(),false) OR coalesce(cm.muted_until>now(),false) OR cm.notification_mode IS NOT DISTINCT FROM 'none'
      FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=${channel.workspace_id} AND wm.active
      LEFT JOIN channel_members cm ON cm.channel_id=${channel.id} AND cm.user_id=u.id
      LEFT JOIN mention_preferences p ON p.user_id=u.id
      WHERE u.id<>${actor} AND ((NOT ${channel.private} AND wm.guest_type='none') OR cm.user_id IS NOT NULL)
      AND (u.id=ANY(${sql.param(users)}::uuid[]) OR (cm.user_id IS NOT NULL AND (${all} OR (${active} AND u.presence='active'))))
      ON CONFLICT(message_id,user_id) DO NOTHING`);
  }
  async activity(actor:string,workspace:string,input:unknown={}):Promise<MentionActivity>{
    const v=record(input,['before']);const before=v.before===undefined?null:chatCursor(v.before);
    return this.db.transaction(async c=>{
      await requireWorkspaceAccess(c,actor,uuid(workspace));
      const scope=notificationScope(actor,workspace);
      const items=await rows<MentionActivity['items'][number]>(c,sql`SELECT n.id::text,n.channel_id,ch.name AS channel_name,n.message_id,m.thread_id,left(m.text,500) AS text,u.display_name AS author_name,n.created_at,n.read_at,n.silent
        FROM mention_notifications n JOIN channels ch ON ch.id=n.channel_id JOIN messages m ON m.channel_id=n.channel_id AND m.id=n.message_id JOIN users u ON u.id=m.user_id
        WHERE ${scope} AND (${before}::bigint IS NULL OR n.id<${before}::bigint) ORDER BY n.id DESC LIMIT 51`);
      const [count]=await rows<{count:number}>(c,sql`SELECT count(*)::int AS count FROM mention_notifications n JOIN channels ch ON ch.id=n.channel_id WHERE ${scope} AND n.read_at IS NULL`);
      return {items:items.slice(0,50),unread_count:count!.count,next_cursor:items.length>50?items[49]!.id:null};
    });
  }
  async markRead(actor:string,workspace:string,id:string){
    return sessionTransaction(this.db,async c=>{
      await requireWorkspaceAccess(c,actor,uuid(workspace));
      const result=await c.execute(sql`UPDATE mention_notifications n SET read_at=coalesce(read_at,now()) FROM channels ch WHERE n.id=${chatCursor(id)}::bigint AND ch.id=n.channel_id AND ${notificationScope(actor,workspace)} RETURNING n.id`);
      if(!result.rows.length)throw missing();return {read:true};
    });
  }
}
