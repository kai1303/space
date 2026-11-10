import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, record, text, uuid } from '@space/contracts';
import type { ChatStore } from '@space/postgres/chat';

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

export function registerWorkflowChat(app: FastifyInstance, chat: ChatStore, config: WorkflowChatConfig) {
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
    } else {
      throw new AppError(400, 'invalid_workflow_destination');
    }
    const message = await chat.send(config.actor, channel, { text: content, client_message_id: clientId }, undefined,
      { name, workspace: config.workspace });
    return reply.code(201).send({ id: message.id, channel_id: message.channel_id });
  });
}
