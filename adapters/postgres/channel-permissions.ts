import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {AppError,parseChannelPermissionsUpdate,uuid,type ChannelPermissionSnapshot,type ChannelPermissions,type ChannelCapabilities} from '@space/contracts';
import type {Database,DbSession} from './database.js';
import {sessionTransaction} from './session-concurrency.js';

type PermissionRow=ChannelPermissions & {workspace_id:string;role:string;guest_type:string;archived:boolean;private:boolean;broadcast_permission:string};
export async function readChannelPermissions(c:DbSession,actor:string,channel:string):Promise<ChannelPermissionSnapshot>{
  const {rows}=await c.execute(sql`SELECT p.*,p.revision::text AS revision,wm.role,wm.guest_type,ch.archived_at IS NOT NULL AS archived,ch.private,
    coalesce(ms.broadcast_permission,'all') AS broadcast_permission
    FROM channels ch JOIN channel_permissions p ON p.channel_id=ch.id AND p.workspace_id=ch.workspace_id
    JOIN channel_members cm ON cm.channel_id=ch.id AND cm.workspace_id=ch.workspace_id AND cm.user_id=${uuid(actor)}
    JOIN workspace_members wm ON wm.workspace_id=cm.workspace_id AND wm.user_id=cm.user_id AND wm.active
    LEFT JOIN workspace_mention_settings ms ON ms.workspace_id=ch.workspace_id
    WHERE ch.id=${uuid(channel)} AND ch.kind='channel'`);
  const row=rows[0] as PermissionRow|undefined;
  if(!row)throw new AppError(404,'not_found');
  const full=row.guest_type==='none',admin=full&&['owner','admin'].includes(row.role),manager=full&&(admin||row.manager_ids.includes(actor));
  const post=!row.archived&&(row.posting==='everyone'||row.posting==='members'&&full||admin||(row.posting==='selected'&&row.poster_ids.includes(actor)));
  const memberAction=(policy:'members'|'managers')=>full&&(manager||policy==='members');
  return {
    revision:row.revision,posting:row.posting,poster_ids:row.poster_ids,manager_ids:row.manager_ids,
    allow_replies:row.allow_replies,allow_broadcast:row.allow_broadcast,invite:row.invite,remove:row.remove,edit_details:row.edit_details,archive:row.archive,
    capabilities:{post,reply:!row.archived&&(post||row.allow_replies),broadcast:!row.archived&&row.allow_broadcast&&(row.broadcast_permission==='all'||admin),
      invite:!row.archived&&memberAction(row.invite),remove:memberAction(row.remove),edit_details:!row.archived&&memberAction(row.edit_details),archive:memberAction(row.archive),manage:manager&&!row.archived},
  };
}
export async function requireChannelCapability(c:DbSession,actor:string,channel:string,action:keyof ChannelCapabilities){
  const permissions=await readChannelPermissions(c,actor,channel);
  if(!permissions.capabilities[action])throw new AppError(403,action==='post'?'channel_posting_forbidden':action==='reply'?'channel_replies_forbidden':action==='broadcast'?'channel_broadcast_forbidden':'channel_management_forbidden');
  return permissions;
}
export async function requireRemainingChannelManager(c:DbSession,channel:string,managers:string[],excluding?:string){
  const {rows}=await c.execute(sql`SELECT cm.user_id FROM channel_members cm JOIN workspace_members wm ON wm.workspace_id=cm.workspace_id AND wm.user_id=cm.user_id
    WHERE cm.channel_id=${channel} AND wm.active AND wm.guest_type='none'
      AND (wm.role IN ('owner','admin') OR cm.user_id=ANY(${sql.param(managers)}::uuid[]))
      LIMIT 2`);
  // Legacy managerless channels must not trap ordinary members or offboarding.
  if(!rows.some(row=>row.user_id!==excluding)&&(!excluding||rows.length))throw new AppError(409,'channel_needs_manager');
}
// Check only channels affected by this membership change. Serializable callers
// retry if a simultaneous channel edit or departure changes the eligible set.
export async function requireManagedPrivateChannels(c:DbSession,workspace:string,user:string,demoting=false){
  const {rows}=await c.execute(sql`SELECT 1 FROM channels ch JOIN channel_permissions p ON p.channel_id=ch.id
    JOIN channel_members affected ON affected.channel_id=ch.id AND affected.user_id=${user}
    JOIN workspace_members subject ON subject.workspace_id=ch.workspace_id AND subject.user_id=affected.user_id
    WHERE ch.workspace_id=${workspace} AND ch.private AND ch.kind='channel'
      AND subject.active AND subject.guest_type='none' AND (subject.role IN ('owner','admin') OR subject.user_id=ANY(p.manager_ids))
      AND NOT EXISTS (SELECT 1 FROM channel_members cm JOIN workspace_members wm ON wm.workspace_id=cm.workspace_id AND wm.user_id=cm.user_id
        WHERE cm.channel_id=ch.id AND wm.active AND wm.guest_type='none'
          AND (cm.user_id=ANY(p.manager_ids) OR wm.role IN ('owner','admin') AND cm.user_id<>${user})
          ${demoting?sql``:sql`AND cm.user_id<>${user}`}) LIMIT 1`);
  if(rows.length)throw new AppError(409,'channel_needs_manager');
}
export class ChannelPermissionStore{
  constructor(private readonly db:Database){}
  read(actor:string,channel:string){return sessionTransaction(this.db,c=>readChannelPermissions(c,actor,channel));}
  update(actor:string,channel:string,input:unknown){
    const change=parseChannelPermissionsUpdate(input);
    return sessionTransaction(this.db,async c=>{
      const current=await requireChannelCapability(c,actor,channel,'manage');
      if(current.revision!==change.revision)throw new AppError(409,'channel_permissions_conflict');
      const next={...current,...change};
      for(const [ids,managers] of [[next.manager_ids,true],[next.poster_ids,false]] as const){
        if(!ids.length)continue;
        const {rows}=await c.execute(sql`SELECT cm.user_id FROM channel_members cm JOIN workspace_members wm ON wm.workspace_id=cm.workspace_id AND wm.user_id=cm.user_id
          WHERE cm.channel_id=${channel} AND cm.user_id=ANY(${sql.param(ids)}::uuid[]) AND wm.active ${managers?sql`AND wm.guest_type='none'`:sql``}`);
        if(rows.length!==ids.length)throw new AppError(400,'invalid_permission_members');
      }
      const {rows:channels}=await c.execute(sql`SELECT workspace_id,private FROM channels WHERE id=${channel}`);
      if(channels[0]!.private)await requireRemainingChannelManager(c,channel,next.manager_ids);
      const {rows}=await c.execute(sql`UPDATE channel_permissions SET revision=revision+1,posting=${next.posting},
        poster_ids=${sql.param(next.poster_ids)}::uuid[],manager_ids=${sql.param(next.manager_ids)}::uuid[],allow_replies=${next.allow_replies},allow_broadcast=${next.allow_broadcast},
        invite=${next.invite},remove=${next.remove},edit_details=${next.edit_details},archive=${next.archive}
        WHERE channel_id=${channel} AND revision=${change.revision}::bigint RETURNING revision`);
      if(!rows.length)throw new AppError(409,'channel_permissions_conflict');
      await c.execute(sql`INSERT INTO workspace_events(id,workspace_id,actor_id,type,payload) VALUES(${randomUUID()},${channels[0]!.workspace_id},${actor},'channel.permissions_updated',${JSON.stringify({channel_id:channel,revision:String(rows[0]!.revision),changes:Object.keys(change).filter(k=>k!=='revision')})}::jsonb)`);
      return readChannelPermissions(c,actor,channel);
    });
  }
}
