import { AppError, record, uuid } from '@space/contracts';
import type { ChatStore } from '@space/postgres/chat';
import { hasChannelAccess, hasThreadAccess, hasWorkspaceAccess } from '@space/postgres/access';

export type ResourceSubscription = { scope: 'actor' | 'drafts' | 'workspace' | 'channel' | 'thread' | 'task' | 'session-team' | 'sidebar-sections'; id: string; revision?: string; keys?: string[] };
export function parseResourceSubscription(input: unknown): ResourceSubscription {
  const value = record(input, ['scope', 'id']);
  if (!['actor', 'drafts', 'workspace', 'channel', 'thread', 'task', 'session-team', 'sidebar-sections'].includes(value.scope as string)) throw new AppError(400, 'invalid_scope');
  return { scope: value.scope as ResourceSubscription['scope'], id: uuid(value.id) };
}
export async function resourceRevision(chat: ChatStore, actor: string, subscription: ResourceSubscription): Promise<string> {
  const { scope, id } = subscription;
  if(scope==='actor' || scope==='drafts'){
    if(id!==actor)throw new AppError(404,'not_found');
    subscription.keys=[`${scope}:${actor}`];
    const result=await chat.pool.query('SELECT revision::text FROM resource_update_revisions WHERE resource=$1',subscription.keys);
    return result.rows[0]?.revision??'0';
  }
  let workspace: string, channel: string | undefined;
  let allowed = false;
  if (scope === 'workspace' || scope === 'sidebar-sections') {
    workspace = id;
    allowed = await hasWorkspaceAccess(chat.db, actor, workspace);
  } else if (scope === 'session-team') {
    const result = await chat.pool.query<{workspace_id:string;channel_id:string;thread_id:string;writable:boolean;can_manage:boolean;revision:string}>(`SELECT
      access.workspace_id,t.channel_id,t.id AS thread_id,access.writable,access.can_manage,
      coalesce(rev.revision,0)::text AS revision FROM session_team_access($1,$2) access JOIN agent_sessions a ON a.id=$1
      JOIN threads t ON t.id=a.origin_thread_id LEFT JOIN resource_update_revisions rev ON rev.resource='session-team:'||a.id`,[id,actor]);
    const row=result.rows[0];
    if (!row) throw new AppError(404,'not_found');
    // Recheck access on membership and lifecycle changes. Never expose the source's revision or traffic.
    subscription.keys=['global', `workspace:${row.workspace_id}`, `channel:${row.channel_id}`, `thread:${row.thread_id}`, `actor:${actor}`, `session-team:${id}`];
    return JSON.stringify([row.revision,row.writable,row.can_manage]);
  } else {
    const query = scope === 'channel' ? 'SELECT workspace_id,id AS channel_id FROM channels WHERE id=$1'
      : scope === 'thread' ? 'SELECT workspace_id,channel_id FROM threads WHERE id=$1'
      : 'SELECT t.workspace_id,t.channel_id,k.thread_id FROM tasks k JOIN threads t ON t.id=k.thread_id WHERE k.id=$1';
    const row = (await chat.pool.query<{workspace_id:string;channel_id:string;thread_id?:string}>(query,[id])).rows[0];
    if (!row) throw new AppError(404, 'not_found');
    workspace = row.workspace_id; channel = row.channel_id;
    allowed = scope === 'channel' ? await hasChannelAccess(chat.db, actor, workspace, channel)
      : await hasThreadAccess(chat.db, actor, scope === 'thread' ? id : row.thread_id!);
  }
  if (!allowed) throw new AppError(404, 'not_found');
  const keys = ['global', `workspace:${workspace}`, ...(channel ? [`channel:${channel}`] : []),
    ...(scope === 'workspace' ? [`workspace-messages:${workspace}`] : scope === 'thread' || scope === 'task' ? [`${scope}:${id}`] : [])];
  subscription.keys = [...keys, `actor:${actor}`];
  const revisionKeys = scope === 'sidebar-sections' ? subscription.keys : keys;
  const revisions = await chat.pool.query<{resource:string;revision:string}>(
    'SELECT resource,revision::text FROM resource_revision_totals WHERE resource=ANY($1::text[]) ORDER BY resource',[revisionKeys]);
  return JSON.stringify(revisions.rows);
}
