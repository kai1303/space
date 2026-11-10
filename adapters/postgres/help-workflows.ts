import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AppError, parsePage, type PublishedHelpWorkflow } from '@space/contracts';
import type { Database, DbSession } from './database.js';
import { requireWorkspaceAccess } from './access.js';
import { requireFullWorkspaceMember } from './workspace-access.js';
import { requireChannelCapability } from './channel-permissions.js';
import { sessionTransaction } from './session-concurrency.js';
import { page } from './membership.js';


type Routing = { workspace: string; actor: string; help: string; onCall: string };

async function authorizeRoute(tx: DbSession, config: Routing, viewer: string, channel: string) {
  if (channel !== config.help && channel !== config.onCall) throw new AppError(400, 'invalid_workflow_destination');
  const row = await tx.execute(sql`SELECT id FROM channels WHERE workspace_id=${config.workspace} AND id=${channel} AND kind='channel'`);
  if (!row.rowCount) throw new AppError(404, 'not_found');
  await requireChannelCapability(tx, viewer, channel, 'post');
  await requireChannelCapability(tx, config.actor, channel, 'post');
}

export class HelpWorkflows {
  constructor(readonly db: Database, readonly config: Routing) {}

  async list(viewer: string, mine: boolean, paging: unknown) {
    const { limit, after } = parsePage(paging);
    const ws = this.config.workspace;
    return this.db.transaction(async tx => {
      await requireWorkspaceAccess(tx, viewer, ws);
      const { rows } = await tx.execute<PublishedHelpWorkflow & Record<string, unknown>>(sql`
        SELECT id, name, manager_id ${mine ? sql`, jsonb_build_object('revision',revision,'normal_channel',normal_channel,'urgent_channel',urgent_channel) AS settings` : sql``}
        FROM published_help_workflows
        WHERE workspace_id=${ws} ${mine ? sql`AND manager_id=${viewer}` : sql``}
          ${after ? sql`AND id>${after}` : sql``}
        ORDER BY id LIMIT ${limit + 1}`);
      return page(rows, limit, row => row.id);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async publish(viewer: string, id: string, name: string, normal: string, urgent: string) {
    const ws = this.config.workspace;
    return sessionTransaction(this.db, async tx => {
      await requireFullWorkspaceMember(tx, viewer, ws);
      for (const channel of new Set([normal, urgent])) await authorizeRoute(tx, this.config, viewer, channel);
      await tx.execute(sql`INSERT INTO published_help_workflows(id,workspace_id,manager_id,name,normal_channel,urgent_channel)
        VALUES(${id},${ws},${viewer},${name},${normal},${urgent}) ON CONFLICT(id) DO NOTHING`);
      const { rows } = await tx.execute<PublishedHelpWorkflow & Record<string, unknown>>(sql`SELECT id,name,manager_id
        FROM published_help_workflows WHERE id=${id} AND workspace_id=${ws} AND manager_id=${viewer}
          AND name=${name} AND normal_channel=${normal} AND urgent_channel=${urgent}`);
      if (!rows[0]) throw new AppError(409, 'workflow_publish_conflict');
      return rows[0];
    });
  }

  async edit(viewer: string, id: string, revision: number, name: string, normal: string, urgent: string) {
    const ws = this.config.workspace;
    return sessionTransaction(this.db, async tx => {
      await requireFullWorkspaceMember(tx, viewer, ws);
      const { rows: [current] } = await tx.execute<{name:string; revision:number; normal_channel:string; urgent_channel:string}>(sql`
        SELECT name,revision,normal_channel,urgent_channel FROM published_help_workflows
        WHERE id=${id} AND workspace_id=${ws} AND manager_id=${viewer}`);
      if (!current) throw new AppError(404, 'not_found');
      for (const channel of new Set([normal, urgent])) await authorizeRoute(tx, this.config, viewer, channel);
      if (current.name === name && current.normal_channel === normal && current.urgent_channel === urgent) return;
      const {rowCount} = await tx.execute(sql`UPDATE published_help_workflows SET name=${name},normal_channel=${normal},
        urgent_channel=${urgent},revision=revision+1 WHERE id=${id} AND workspace_id=${ws} AND manager_id=${viewer} AND revision=${revision}`);
      if (!rowCount) throw new AppError(409, 'workflow_changed_reopen_editor');
    });
  }

  async prepare(viewer: string, id: string, key: string, urgency: 'normal' | 'urgent', description: string) {
    const hash = createHash('sha256').update(JSON.stringify([urgency, description])).digest('hex');
    return sessionTransaction(this.db, async tx => {
      await requireWorkspaceAccess(tx, viewer, this.config.workspace);
      const eligible = await tx.execute(sql`SELECT id FROM published_help_workflows WHERE workspace_id=${this.config.workspace} AND id=${id}`);
      if (!eligible.rowCount) throw new AppError(404, 'not_found');
      await tx.execute(sql`INSERT INTO help_workflow_requests(workflow_id,requester_id,request_id,input_hash)
        VALUES(${id},${viewer},${key},${hash}) ON CONFLICT DO NOTHING`);
      const { rows: [request] } = await tx.execute<{input_hash: string; started: boolean; name:string; channel:string}>(sql`
        SELECT input_hash,started,routing->>'name' AS name,routing->>${urgency}::text AS channel
        FROM help_workflow_requests WHERE workflow_id=${id} AND requester_id=${viewer} AND request_id=${key}`);
      if (request?.input_hash !== hash) throw new AppError(409, 'workflow_request_conflict');
      await authorizeRoute(tx, this.config, viewer, request.channel);
      return { name: request.name, channel:request.channel, started: request.started };
    });
  }

  async acknowledge(viewer: string, id: string, key: string) {
    await this.db.execute(sql`UPDATE help_workflow_requests SET started=true
      WHERE workflow_id=${id} AND requester_id=${viewer} AND request_id=${key} AND NOT started`);
  }
}
