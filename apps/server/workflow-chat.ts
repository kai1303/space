import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, record, text, uuid, type WorkspaceWorkflow } from '@space/contracts';
import type { ChatStore } from '@space/postgres/chat';

import { HelpWorkflows } from '@space/postgres/help-workflows';
import { helpWorkflowClient } from '@space/workflows/help-client';

export const workflowMessagePath = '/v1/workflow-messages';
export interface WorkflowChatConfig {
  token: string;
  actor: string;
  workspace: string;
  help: string;
  onCall: string;
}

export function workflowChatConfig(): WorkflowChatConfig | undefined {
  const token = process.env.SPACE_WORKFLOW_TOKEN;
  if (!token) return;
  if (token.length < 32) throw new Error('SPACE_WORKFLOW_TOKEN requires at least 32 characters');
  return { token, actor: uuid(process.env.SPACE_WORKFLOW_ACTOR_ID), workspace: uuid(process.env.SPACE_WORKFLOW_WORKSPACE_ID),
    help: uuid(process.env.SPACE_WORKFLOW_HELP_CHANNEL_ID), onCall: uuid(process.env.SPACE_WORKFLOW_ON_CALL_CHANNEL_ID) };
}

export function registerWorkflowChat(app: FastifyInstance, chat: ChatStore, config?: WorkflowChatConfig) {
  app.get<{ Params: { workspace: string } }>('/v1/workspaces/:workspace/workflows', async request => {
    const workspace = uuid(request.params.workspace);
    const routes = config?.workspace === workspace ? [
      { urgency: 'normal', id: config.help }, { urgency: 'urgent', id: config.onCall },
    ] as const : [];
    const visible = await chat.channels(request.actorId, workspace, {}, routes.map(route => route.id));
    const items: WorkspaceWorkflow[] = routes.length ? [{
      name: 'IT Help Request',
      destinations: routes.flatMap(route => {
        const channel = visible.items.find(item => item.id === route.id && !item.archived_at);
        return channel ? [{ urgency: route.urgency, channel }] : [];
      }),
    }] : [];
    return { items, next_cursor: null };
  });
  if (!config) return;
  const publications = new HelpWorkflows(chat.db, config);
  const client = helpWorkflowClient(process.env.TEMPORAL_ADDRESS);
  app.addHook('onClose', () => client.close());
  const base = '/v1/workspaces/:workspace/workflows/published';
  type Params = { workspace: string; id: string };
  function checkWorkspace(workspace: string) {
    if (uuid(workspace) !== config!.workspace) throw new AppError(404, 'not_found');
  }
  app.get<{Params: Params; Querystring: {mine?: string; after?: string; limit?: string}}>(base, async r => {
    checkWorkspace(r.params.workspace);
    const { mine, ...paging } = r.query;
    return publications.list(r.actorId, mine === 'true', paging);
  });
  app.post<{Params: Params}>(base, async (r, reply) => {
    checkWorkspace(r.params.workspace);
    const b = record(r.body, ['id','name','normal_channel','urgent_channel']);
    const result = await publications.publish(r.actorId, uuid(b.id), text(b.name,80).trim(), uuid(b.normal_channel), uuid(b.urgent_channel));
    return reply.code(201).send(result);
  });
  app.patch<{Params: Params}>(base + '/:id', async (r, reply) => {
    checkWorkspace(r.params.workspace);
    const b = record(r.body, ['revision','name','normal_channel','urgent_channel']);
    if (typeof b.revision !== 'number' || !Number.isSafeInteger(b.revision) || b.revision < 1) throw new AppError(400, 'invalid_revision');
    await publications.edit(r.actorId,uuid(r.params.id),b.revision,text(b.name,80).trim(),uuid(b.normal_channel),uuid(b.urgent_channel));
    return reply.code(204).send();
  });
  app.post<{Params: Params}>(base + '/:id/requests', async (r, reply) => {
    checkWorkspace(r.params.workspace);
    const id = uuid(r.params.id), b = record(r.body, ['request_id','urgency','description']);
    const key = uuid(b.request_id), description = text(b.description,4000).trim();
    if (b.urgency !== 'normal' && b.urgency !== 'urgent') throw new AppError(400, 'invalid_urgency');
    const result = await publications.prepare(r.actorId,id,key,b.urgency,description);
    const workflowId = `help-${id}-${r.actorId}-${key}`;
    if (!result.started) {
      try { await client.start(workflowId,result.name,result.channel,{requester:r.actorId,urgency:b.urgency,description}); }
      catch { throw new AppError(503, 'workflow_start_unconfirmed_retry'); }
      await publications.acknowledge(r.actorId,id,key);
    }
    return reply.code(202).send({ workflow_id: workflowId, channel_id: result.channel });
  });
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest('Bearer ' + config.token);
  app.post(workflowMessagePath, { onRequest: async request => {
    if (!timingSafeEqual(expected, digest(request.headers.authorization ?? ''))) throw new AppError(401, 'unauthorized');
  } }, async (request, reply) => {
    const body = record(request.body, ['workflowName', 'key', 'text', 'target', 'destination']);
    const name = text(body.workflowName, 80).trim();
    const content = text(body.text, 16000);
    // UUIDv8 derived from the logical step key, stable across Activity attempts.
    const bytes = digest('space.workflow.message/' + text(body.key, 2048)).subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 128;
    bytes[8] = (bytes[8]! & 63) | 128;
    const clientId = bytes.toString('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
    let channel: string;
    if (body.target === 'person') {
      const dm = await chat.directMessages.open(config.actor, config.workspace, { user_id: uuid(body.destination) });
      channel = dm.id;
    } else if (body.target === 'channel' && (body.destination === '#help' || body.destination === '#on-call')) {
      channel = body.destination === '#help' ? config.help : config.onCall;
    } else if (body.target === 'channel' && (body.destination === config.help || body.destination === config.onCall)) {
      channel = body.destination;
    } else {
      throw new AppError(400, 'invalid_workflow_destination');
    }
    const message = await chat.send(config.actor, channel, { text: content, client_message_id: clientId }, undefined,
      { name, workspace: config.workspace });
    return reply.code(201).send({ id: message.id, channel_id: message.channel_id });
  });
}
