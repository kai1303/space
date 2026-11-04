import { AppError, record, uuid } from '@space/contracts';
import type { ChatStore } from '@space/postgres/chat';
import { hasChannelAccess, hasThreadAccess, hasWorkspaceAccess } from '@space/postgres/access';

export type ResourceSubscription = { scope: 'workspace' | 'channel' | 'thread' | 'task'; id: string; revision?: string };
export function parseResourceSubscription(input: unknown): ResourceSubscription {
  const value = record(input, ['scope', 'id']);
  if (!['workspace', 'channel', 'thread', 'task'].includes(value.scope as string)) throw new AppError(400, 'invalid_scope');
  return { scope: value.scope as ResourceSubscription['scope'], id: uuid(value.id) };
}
export async function resourceRevision(chat: ChatStore, actor: string, subscription: ResourceSubscription): Promise<string> {
  const { scope, id } = subscription;
  let workspace: string, channel: string | undefined;
  let allowed = false;
  if (scope === 'workspace') {
    workspace = id;
    allowed = await hasWorkspaceAccess(chat.db, actor, workspace);
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
  const revisions = await chat.pool.query<{resource:string;revision:string}>(
    'SELECT resource,revision::text FROM resource_update_revisions WHERE resource=ANY($1::text[]) ORDER BY resource',[keys]);
  return JSON.stringify(revisions.rows);
}
